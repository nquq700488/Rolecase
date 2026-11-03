import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AcpAgentRuntime,
  FileCredentialStore,
  resolveAdapterCommand,
  type AgentRuntimeConnectionInput,
  type CredentialStorePort,
} from '@rolecast/server'

import type { AcpProvider } from './harness.js'

const integrationEnabled = process.env.RUN_ACP_INTEGRATION === '1'
const providers: AcpProvider[] = process.env.ACP_PROVIDER === undefined
  ? ['claude', 'codex']
  : [process.env.ACP_PROVIDER as AcpProvider]
const integrationTest = integrationEnabled ? it : it.skip

describe('AcpAgentRuntime Port Contract', () => {
  for (const provider of providers) {
    integrationTest(`${provider} 通过 AgentRuntimePort 完成一轮执行`, async () => {
      const runtime = new AcpAgentRuntime()
      const workDir = await mkdtemp(join(tmpdir(), 'rolecast-runtime-'))
      let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null
      try {
        const adapter = resolveAdapterCommand(provider, undefined)
        const input: AgentRuntimeConnectionInput = {
          providerKind: provider,
          adapterCommand: adapter.command,
          adapterArgs: adapter.args,
          cwd: workDir,
          env: { ...process.env },
          adapterVersion: provider === 'claude' ? '0.90.0' : '2.2.2',
          environmentMode: 'inherited',
          runtimeDirectory: workDir,
        }
        connection = await runtime.connect(input)
        expect(connection.capabilities.source).toBe('acp_handshake')
        const session = await runtime.createSession(connection, workDir)
        const events = []
        for await (const event of runtime.sendTurn({
          session,
          contextBundle: {
            system_instructions: '',
            task_input: '只回复 ACP_RUNTIME_OK，不调用工具。',
            referenced_artifacts: [],
            session_summary: '',
            constraints: [],
            output_contract: '',
          },
        })) {
          events.push(event)
        }

        expect(events.some((event) => event.kind === 'turn_completed')).toBe(true)
        await runtime.closeSession(session)
      } finally {
        if (connection !== null) {
          await runtime.closeConnection(connection.connectionId)
        }
        await rm(workDir, { recursive: true, force: true })
      }
    }, 180_000)

    integrationTest(`${provider} discover 暴露模型 config options`, async () => {
      const runtime = new AcpAgentRuntime()
      const workDir = await mkdtemp(join(tmpdir(), 'rolecast-discover-'))
      try {
        const adapter = resolveAdapterCommand(provider, undefined)
        const input: AgentRuntimeConnectionInput = {
          providerKind: provider,
          adapterCommand: adapter.command,
          adapterArgs: adapter.args,
          cwd: workDir,
          env: { ...process.env },
          adapterVersion: provider === 'claude' ? '0.90.0' : '2.2.2',
          environmentMode: 'inherited',
          runtimeDirectory: workDir,
        }
        const capabilities = await runtime.discover(input)
        const options = capabilities.capabilities.config_options
        expect(Array.isArray(options)).toBe(true)
        expect((options as Array<{ category?: string }>).some((option) => option.category === 'model')).toBe(true)
      } finally {
        await rm(workDir, { recursive: true, force: true })
      }
    }, 180_000)
  }
})

// 真实 Adapter Credential 注入 smoke 默认跳过：只在显式设置 RUN_ACP_CREDENTIAL_SMOKE=1 时运行。
// 只使用合成 Secret，不发起任何真实模型调用（不发 prompt），因此不产生网络请求。
const credentialSmokeEnabled = process.env.RUN_ACP_CREDENTIAL_SMOKE === '1'
const credentialSmoke = credentialSmokeEnabled ? it : it.skip

/** 记录读取过的 credential_ref，用于断言 CredentialStore → Runtime 这一段链路。 */
class RecordingCredentialStore implements CredentialStorePort {
  readonly reads: string[] = []

  constructor(private readonly inner: CredentialStorePort) {}

  save(operationKey: string, secret: string): Promise<string> {
    return this.inner.save(operationKey, secret)
  }

  get(reference: string): Promise<string | null> {
    this.reads.push(reference)
    return this.inner.get(reference)
  }

  validate(reference: string): Promise<boolean> {
    return this.inner.validate(reference)
  }

  rotate(reference: string, secret: string): Promise<void> {
    return this.inner.rotate(reference, secret)
  }

  delete(reference: string): Promise<void> {
    return this.inner.delete(reference)
  }
}

describe('AcpAgentRuntime 真实 Adapter Credential 注入 smoke', () => {
  for (const provider of providers) {
    credentialSmoke(`${provider} isolated 用合成凭据完成真实 Adapter 握手与 Session`, async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'rolecast-credential-smoke-'))
      const store = new RecordingCredentialStore(
        new FileCredentialStore(join(workDir, 'credentials')),
      )
      // 合成 Secret：不含真实凭据，也不会被打印到任何输出。
      const syntheticSecret = `synthetic-${randomUUID()}`
      const reference = await store.save(`smoke-${randomUUID()}`, syntheticSecret)
      const runtime = new AcpAgentRuntime(store)
      let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

      try {
        const adapter = resolveAdapterCommand(provider, undefined)
        connection = await runtime.connect({
          providerKind: provider,
          adapterCommand: adapter.command,
          adapterArgs: adapter.args,
          cwd: workDir,
          env: {},
          adapterVersion: provider === 'claude' ? '0.90.0' : '2.2.2',
          environmentMode: 'isolated',
          runtimeDirectory: workDir,
          credentialRef: reference,
          credentialEnvironmentKey: provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
          ...(provider === 'codex'
            ? {
                importedConfig: {
                  confirmed: true,
                  model: 'rolecast-smoke-model',
                  baseUrl: 'https://smoke.invalid/v1',
                },
              }
            : {}),
        })

        // CredentialStore → Runtime：Runtime 必须按引用读取，而不是自行拼装环境。
        expect(store.reads).toEqual([reference])
        // Runtime env → 真实 Adapter：真实 Adapter 在注入环境后完成握手。
        expect(connection.capabilities.source).toBe('acp_handshake')
        expect(connection.capabilities.provider_kind).toBe(provider)
        // 真实 Adapter 的成功响应同样经过 scope 脱敏，合成 Secret 不出现在返回结构里。
        expect(JSON.stringify(connection.capabilities).includes(syntheticSecret)).toBe(false)

        const session = await runtime.createSession(connection, workDir)
        expect(session.sessionId.length).toBeGreaterThan(0)
        expect(JSON.stringify(session).includes(syntheticSecret)).toBe(false)

        await runtime.closeSession(session)
      } finally {
        if (connection !== null) {
          await runtime.closeConnection(connection.connectionId)
        }
        await rm(workDir, { recursive: true, force: true })
      }
    }, 180_000)
  }
})
