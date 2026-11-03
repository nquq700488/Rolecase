import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ContextBundle } from '../../application/context/context-builder.js'
import type {
  CredentialStorePort,
  SecretRedactionPort,
  SecretRedactionScope,
} from '../../application/ports/credential-store-port.js'
import {
  AcpAgentRuntime,
  CodexCustomEndpointUnverifiedError,
  CredentialEnvironmentMismatchError,
  ProviderNeedsConfigurationError,
} from './acp-agent-runtime.js'
import { SecretRedactor } from '../credentials/file-credential-store.js'

const TEST_SECRET = 'test-secret'

const textContextBundle = (taskInput = 'hello'): ContextBundle => ({
  system_instructions: '',
  task_input: taskInput,
  referenced_artifacts: [],
  session_summary: '',
  constraints: [],
  output_contract: '',
})

const fakeCredentialStore: CredentialStorePort = {
  save: async () => 'credential-001',
  get: async () => TEST_SECRET,
  validate: async () => true,
  rotate: async () => undefined,
  delete: async () => undefined,
}

/** 记录 scope 生命周期，用于断言所有失败路径都关闭了 scope。 */
class SpyRedaction implements SecretRedactionPort {
  readonly scopes: Array<{ closed: boolean }> = []
  private readonly inner = new SecretRedactor()

  fingerprint(secret: string): string {
    return this.inner.fingerprint(secret)
  }

  redact(value: string): string {
    return this.inner.redact(value)
  }

  redactRecord(
    value: Readonly<Record<string, unknown>>,
    secretFingerprints: readonly string[] = [],
  ): Readonly<Record<string, unknown>> {
    return this.inner.redactRecord(value, secretFingerprints)
  }

  createScope(secret: string): SecretRedactionScope {
    const scope = this.inner.createScope(secret)
    const record = { closed: false }
    this.scopes.push(record)
    return {
      redact: (value: string) => scope.redact(value),
      redactValue: (value: unknown) => scope.redactValue(value),
      redactStreamRecord: (value: unknown, streamId: string) => scope.redactStreamRecord(value, streamId),
      flushStream: (streamId: string) => scope.flushStream(streamId),
      dropStream: (streamId: string) => scope.dropStream(streamId),
      close: () => {
        record.closed = true
        scope.close()
      },
    }
  }
}

/** 构造只实现 initialize/session 最小握手的 Fake Adapter 脚本。 */
const fakeAdapterScript = (onPrompt: string): string => [
  "const readline = require('node:readline')",
  "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
  "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
    + " if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } });"
    + " if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'session-001', configOptions: [] } });"
    + ` if (m.method === 'session/prompt') { ${onPrompt} } })`,
].join(';')

const isolatedClaudeInput = (
  runtimeDirectory: string,
  adapterCommand: string,
  adapterArgs: readonly string[],
) => ({
  providerKind: 'claude' as const,
  adapterCommand,
  adapterArgs,
  cwd: runtimeDirectory,
  env: {},
  adapterVersion: '1.0.0',
  environmentMode: 'isolated' as const,
  runtimeDirectory,
  credentialRef: 'credential-001',
  credentialEnvironmentKey: 'ANTHROPIC_API_KEY' as const,
})

const collectEventText = (events: readonly { payload: Record<string, unknown> }[]): string => events
  .map((event) => (typeof event.payload.text === 'string' ? event.payload.text : ''))
  .join('')

/** 轮询等待异步清理完成，避免固定 sleep 造成的偶发失败。 */
const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 只实现 initialize / session 最小握手、其余行为由调用方追加的 Adapter 脚本。 */
const adapterScriptWithHandlers = (handlers: string): string => [
  "const readline = require('node:readline')",
  "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
  "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
    + " if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } });"
    + " if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'session-001', configOptions: [] } });"
    + ` ${handlers} })`,
].join(';')

describe('AcpAgentRuntime environment policy', () => {
  it('inherited 连接携带 credential_ref 时在读取凭据前 fail-closed', async () => {
    let readCount = 0
    const store: CredentialStorePort = {
      save: async () => 'credential-001',
      get: async () => {
        readCount += 1
        return 'test-secret'
      },
      validate: async () => true,
      rotate: async () => undefined,
      delete: async () => undefined,
    }
    const runtime = new AcpAgentRuntime(store)

    await expect(runtime.connect({
      providerKind: 'claude',
      adapterCommand: '/path/that/must/not/be_spawned',
      adapterArgs: [],
      cwd: '/tmp',
      env: {},
      adapterVersion: '1.0.0',
      environmentMode: 'inherited',
      runtimeDirectory: '/tmp/rolecast-inherited-mismatch',
      credentialRef: 'credential-001',
      credentialEnvironmentKey: 'ANTHROPIC_API_KEY',
    })).rejects.toBeInstanceOf(CredentialEnvironmentMismatchError)
    expect(readCount).toBe(0)
  })

  it('Claude isolated local 在 spawn 前 fail-closed，不读凭据', async () => {
    let readCount = 0
    const store: CredentialStorePort = {
      ...fakeCredentialStore,
      get: async () => {
        readCount += 1
        return TEST_SECRET
      },
    }
    const runtime = new AcpAgentRuntime(store)

    await expect(runtime.connect({
      providerKind: 'claude',
      connectionKind: 'local',
      adapterCommand: '/path/that/must/not/be_spawned',
      adapterArgs: [],
      cwd: '/tmp',
      env: {},
      adapterVersion: '1.0.0',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-claude-isolated-local',
    })).rejects.toBeInstanceOf(ProviderNeedsConfigurationError)
    expect(readCount).toBe(0)
  })

  it('Claude isolated api_key 缺少引用时在 spawn 前 fail-closed', async () => {
    const runtime = new AcpAgentRuntime(fakeCredentialStore)

    await expect(runtime.connect({
      providerKind: 'claude',
      connectionKind: 'api_key',
      adapterCommand: '/path/that/must/not/be_spawned',
      adapterArgs: [],
      cwd: '/tmp',
      env: {},
      adapterVersion: '1.0.0',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-claude-missing-ref',
    })).rejects.toBeInstanceOf(ProviderNeedsConfigurationError)
  })

  it('custom_endpoint 缺少 base_url 时在 spawn 前 fail-closed', async () => {
    const runtime = new AcpAgentRuntime(fakeCredentialStore)

    await expect(runtime.connect({
      providerKind: 'claude',
      connectionKind: 'custom_endpoint',
      adapterCommand: '/path/that/must/not/be_spawned',
      adapterArgs: [],
      cwd: '/tmp',
      env: {},
      adapterVersion: '1.0.0',
      environmentMode: 'inherited',
      runtimeDirectory: '/tmp/rolecast-claude-missing-url',
    })).rejects.toBeInstanceOf(ProviderNeedsConfigurationError)
  })

  it('历史 codex api_key + baseUrl 在 spawn 与读凭据前 fail-closed', async () => {
    let readCount = 0
    const store: CredentialStorePort = {
      ...fakeCredentialStore,
      get: async () => {
        readCount += 1
        return TEST_SECRET
      },
    }
    const runtime = new AcpAgentRuntime(store)

    await expect(runtime.connect({
      providerKind: 'codex',
      // 旧数据形状：connectionKind 仍是 api_key，但已有 baseUrl。
      connectionKind: 'api_key',
      baseUrl: 'https://gateway.example.test/v1',
      adapterCommand: '/path/that/must/not/be_spawned',
      adapterArgs: [],
      cwd: '/tmp',
      env: {},
      adapterVersion: '2.2.2',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-codex-legacy-endpoint',
      credentialRef: 'credential-001',
      credentialEnvironmentKey: 'OPENAI_API_KEY',
      importedConfig: { confirmed: true, model: 'gpt-test' },
    })).rejects.toBeInstanceOf(CodexCustomEndpointUnverifiedError)
    expect(readCount).toBe(0)
  })

  it('Codex isolated 只有 model_provider 时在读凭据前 fail-closed', async () => {
    let readCount = 0
    const store: CredentialStorePort = {
      ...fakeCredentialStore,
      get: async () => {
        readCount += 1
        return TEST_SECRET
      },
    }
    const runtime = new AcpAgentRuntime(store)

    await expect(runtime.connect({
      providerKind: 'codex',
      connectionKind: 'api_key',
      adapterCommand: '/path/that/must/not/be_spawned',
      adapterArgs: [],
      cwd: '/tmp',
      env: {},
      adapterVersion: '2.2.2',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-codex-provider-only',
      credentialRef: 'credential-001',
      credentialEnvironmentKey: 'OPENAI_API_KEY',
      // 只有选择名，无法物化出 config.toml 内容。
      importedConfig: { confirmed: true },
    })).rejects.toBeInstanceOf(ProviderNeedsConfigurationError)
    expect(readCount).toBe(0)
  })

  it('Codex custom endpoint 认证未证，spawn 前 fail-closed', async () => {
    let readCount = 0
    const store: CredentialStorePort = {
      ...fakeCredentialStore,
      get: async () => {
        readCount += 1
        return TEST_SECRET
      },
    }
    const runtime = new AcpAgentRuntime(store)

    await expect(runtime.connect({
      providerKind: 'codex',
      connectionKind: 'custom_endpoint',
      baseUrl: 'https://gateway.example.test/v1',
      adapterCommand: '/path/that/must/not/be_spawned',
      adapterArgs: [],
      cwd: '/tmp',
      env: {},
      adapterVersion: '2.2.2',
      environmentMode: 'inherited',
      runtimeDirectory: '/tmp/rolecast-codex-custom',
    })).rejects.toBeInstanceOf(CodexCustomEndpointUnverifiedError)
    expect(readCount).toBe(0)
  })

  it('Claude custom_endpoint 通过 ANTHROPIC_BASE_URL 进入 Adapter 环境', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-claude-endpoint-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      const script = [
        "if (process.env.ANTHROPIC_BASE_URL !== 'https://gateway.example.test/v1') process.exit(4)",
        "const readline = require('node:readline')",
        "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
          + " if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } }) + '\\n') })",
      ].join(';')
      connection = await runtime.connect({
        providerKind: 'claude',
        connectionKind: 'custom_endpoint',
        baseUrl: 'https://gateway.example.test/v1',
        adapterCommand: process.execPath,
        adapterArgs: ['-e', script],
        cwd: runtimeDirectory,
        env: {},
        adapterVersion: '1.0.0',
        environmentMode: 'inherited',
        runtimeDirectory,
      })
      expect(connection.capabilities.source).toBe('acp_handshake')
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('Codex isolated 未确认配置时在 spawn 前 fail-closed', async () => {
    const runtime = new AcpAgentRuntime()

    await expect(runtime.connect({
      providerKind: 'codex',
      adapterCommand: '/path/that/must/not/be_spawned',
      adapterArgs: [],
      cwd: '/tmp',
      env: {},
      adapterVersion: '2.2.2',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-codex',
    })).rejects.toBeInstanceOf(ProviderNeedsConfigurationError)
  })

  it('Codex isolated 在没有受控凭据注入时 fail-closed', async () => {
    const runtime = new AcpAgentRuntime()

    await expect(runtime.connect({
      providerKind: 'codex',
      adapterCommand: '/path/that/must/not/be_spawned',
      adapterArgs: [],
      cwd: '/tmp',
      env: { OPENAI_API_KEY: 'not-test-secret' },
      adapterVersion: '2.2.2',
      environmentMode: 'isolated',
      runtimeDirectory: '/tmp/rolecast-codex',
      importedConfig: { confirmed: true, model: 'gpt-test' },
    })).rejects.toBeInstanceOf(ProviderNeedsConfigurationError)
  })

  it('Codex isolated 将已确认的非秘密配置写入 Runtime 目录', async () => {
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-config-'))
    const fakeAgent = [
      "const fs = require('node:fs')",
      "const readline = require('node:readline')",
      "if (!fs.readFileSync(process.env.CODEX_HOME + '/config.toml', 'utf8').includes('base_url')) process.exit(2)",
      "if (process.env.OPENAI_API_KEY !== 'test-secret') process.exit(3)",
      "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line); if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } }) + '\\n') })",
    ].join(';')
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect({
        providerKind: 'codex',
        adapterCommand: process.execPath,
        adapterArgs: ['-e', fakeAgent],
        cwd: runtimeDirectory,
        env: { ...process.env },
        adapterVersion: '2.2.2',
        environmentMode: 'isolated',
        runtimeDirectory,
        credentialRef: 'credential-001',
        credentialEnvironmentKey: 'OPENAI_API_KEY',
        importedConfig: {
          confirmed: true,
          baseUrl: 'https://gateway.example.test/v1',
          model: 'gpt-test',
        },
      })
      expect(connection.capabilities.source).toBe('acp_handshake')
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('Runtime 事件出口会先脱敏敏感字段', async () => {
    const runtime = new AcpAgentRuntime(fakeCredentialStore, new SecretRedactor())
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-redaction-'))
    const fakeAgent = [
      "const readline = require('node:readline')",
      "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
      "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line); if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } }); if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'session-001', configOptions: [] } }); if (m.method === 'session/prompt') { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', api_key: 'test-secret', text: 'test-secret' } } }); send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn', access_token: 'test-secret' } }); } })",
    ].join(';')
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect({
        providerKind: 'codex',
        adapterCommand: process.execPath,
        adapterArgs: ['-e', fakeAgent],
        cwd: runtimeDirectory,
        env: {},
        adapterVersion: '2.2.2',
        environmentMode: 'isolated',
        runtimeDirectory,
        credentialRef: 'credential-001',
        credentialEnvironmentKey: 'OPENAI_API_KEY',
        importedConfig: { confirmed: true, model: 'gpt-test' },
      })
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event)
      }

      expect(JSON.stringify(events)).not.toContain('test-secret')
      expect(events[0]?.payload.api_key).toBe('[REDACTED]')
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('将 ContextBundle 以明确分区的通用 ACP 文本发送', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-context-'))
    const promptPath = join(runtimeDirectory, 'prompt.json')
    const fakeAgent = [
      'const fs = require("node:fs")',
      'const readline = require("node:readline")',
      'const send = value => process.stdout.write(JSON.stringify(value) + "\\n")',
      'readline.createInterface({ input: process.stdin }).on("line", line => { const m = JSON.parse(line); if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "fake", version: "0.1.0" }, authMethods: [] } }); if (m.method === "session/new") send({ jsonrpc: "2.0", id: m.id, result: { sessionId: "session-001", configOptions: [] } }); if (m.method === "session/prompt") { fs.writeFileSync(process.env.CONTEXT_PROMPT_PATH, JSON.stringify(m.params.prompt ?? [])); send({ jsonrpc: "2.0", id: m.id, result: { stopReason: "end_turn" } }); } })',
    ].join(';')
    const runtime = new AcpAgentRuntime()
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect({
        providerKind: 'claude',
        adapterCommand: process.execPath,
        adapterArgs: ['-e', fakeAgent],
        cwd: runtimeDirectory,
        env: { CONTEXT_PROMPT_PATH: promptPath },
        adapterVersion: '0.90.0',
        environmentMode: 'inherited',
        runtimeDirectory,
      })
      const session = await runtime.createSession(connection, runtimeDirectory)
      const contextBundle = {
        system_instructions: 'Role instructions\\n- cite evidence',
        task_input: 'Review this patch',
        referenced_artifacts: [],
        session_summary: '',
        constraints: [],
        output_contract: 'List file and line',
      }
      for await (const _event of runtime.sendTurn({ session, contextBundle })) {}

      const prompt = JSON.parse(await readFile(promptPath, 'utf8')) as Array<{ type: string; text: string }>
      expect(prompt).toHaveLength(1)
      expect(prompt[0]?.type).toBe('text')
      const text = prompt[0]?.text ?? ''
      expect(text).toContain('Role instructions\\n- cite evidence')
      expect(text).toContain('Review this patch')
      expect(text).toContain('List file and line')
      expect(text.indexOf('Role instructions')).toBeLessThan(text.indexOf('Review this patch'))
      expect(text.indexOf('Review this patch')).toBeLessThan(text.indexOf('List file and line'))
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('sendTurn 的消费者提前结束时会取消底层 Adapter 请求', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-cancel-'))
    const markerPath = join(runtimeDirectory, 'cancelled')
    const fakeAgent = [
      "const fs = require('node:fs')",
      "const readline = require('node:readline')",
      "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
      "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line); if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } }); if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'session-001', configOptions: [] } }); if (m.method === 'session/prompt') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', text: 'working' } } }); if (m.method === 'session/cancel') fs.writeFileSync(process.env.CANCEL_MARKER, 'cancelled'); })",
    ].join(';')
    const runtime = new AcpAgentRuntime()
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect({
        providerKind: 'codex',
        adapterCommand: process.execPath,
        adapterArgs: ['-e', fakeAgent],
        cwd: runtimeDirectory,
        env: { CANCEL_MARKER: markerPath },
        adapterVersion: '2.2.2',
        environmentMode: 'inherited',
        runtimeDirectory,
      })
      const session = await runtime.createSession(connection, runtimeDirectory)
      const iterator = runtime.sendTurn({ session, contextBundle: textContextBundle() })[Symbol.asyncIterator]()
      await expect(iterator.next()).resolves.toMatchObject({ done: false })
      await iterator.return?.()

      let marker = ''
      for (let attempt = 0; attempt < 100 && marker.length === 0; attempt += 1) {
        marker = await readFile(markerPath, 'utf8').catch(() => '')
        if (marker.length === 0) {
          // 用真实延时等待子进程写入，setImmediate 在并行负载下会抢在写盘之前跑完。
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
        }
      }
      expect(marker).toBe('cancelled')
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('spawn 失败时关闭 scope', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-spawn-fail-'))
    const redaction = new SpyRedaction()
    const runtime = new AcpAgentRuntime(fakeCredentialStore, redaction)

    try {
      await expect(runtime.connect(isolatedClaudeInput(
        runtimeDirectory,
        '/path/that/does/not/exist',
        [],
      ))).rejects.toBeTruthy()
      expect(redaction.scopes).toHaveLength(1)
      expect(redaction.scopes[0]?.closed).toBe(true)
    } finally {
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('握手失败时关闭 scope，成功交接后 closeConnection 才关闭', async () => {
    const handshakeFailureDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-handshake-fail-'))
    const failing = new SpyRedaction()
    const failingRuntime = new AcpAgentRuntime(fakeCredentialStore, failing)

    try {
      await expect(failingRuntime.connect(isolatedClaudeInput(
        handshakeFailureDirectory,
        process.execPath,
        ['-e', 'process.exit(0)'],
      ))).rejects.toBeTruthy()
      expect(failing.scopes).toHaveLength(1)
      expect(failing.scopes[0]?.closed).toBe(true)
    } finally {
      await rm(handshakeFailureDirectory, { recursive: true, force: true })
    }

    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-handshake-ok-'))
    const redaction = new SpyRedaction()
    const runtime = new AcpAgentRuntime(fakeCredentialStore, redaction)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(
        runtimeDirectory,
        process.execPath,
        ['-e', fakeAdapterScript('')],
      ))
      expect(redaction.scopes).toHaveLength(1)
      expect(redaction.scopes[0]?.closed).toBe(false)

      await runtime.closeConnection(connection.connectionId)
      connection = null
      expect(redaction.scopes[0]?.closed).toBe(true)
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('跨 chunk 的 Secret 不出现在任何已 yield 的 RuntimeEvent', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-split-secret-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        fakeAdapterScript([
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', text: 'before-test-sec' } } })",
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', text: 'ret-after' } } })",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
        ].join('; ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ payload: Record<string, unknown> }> = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { payload: Record<string, unknown> })
      }

      expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
      // 'before-test-sec' + 'ret-after' → 跨 chunk 命中完整 Secret，替换后余下 '-after'。
      expect(collectEventText(events)).toBe('before-[REDACTED]-after')
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('turn 正常结束 flush 安全尾部，取消则丢弃', async () => {
    const completedDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-flush-'))
    const completedRuntime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await completedRuntime.connect(isolatedClaudeInput(completedDirectory, process.execPath, [
        '-e',
        fakeAdapterScript([
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', text: 'tail-test-sec' } } })",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
        ].join('; ')),
      ]))
      const session = await completedRuntime.createSession(connection, completedDirectory)
      const events: Array<{ payload: Record<string, unknown> }> = []
      for await (const event of completedRuntime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { payload: Record<string, unknown> })
      }

      // 安全尾部不丢失：文本完整保留，但不构成完整 Secret。
      expect(collectEventText(events)).toBe('tail-test-sec')
      expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
    } finally {
      if (connection !== null) {
        await completedRuntime.closeConnection(connection.connectionId)
      }
      await rm(completedDirectory, { recursive: true, force: true })
    }

    const cancelledDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-drop-'))
    const cancelledRuntime = new AcpAgentRuntime(fakeCredentialStore)
    let cancelledConnection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      cancelledConnection = await cancelledRuntime.connect(isolatedClaudeInput(cancelledDirectory, process.execPath, [
        '-e',
        fakeAdapterScript([
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', text: 'x-test-sec' } } })",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'cancelled' } })",
        ].join('; ')),
      ]))
      const session = await cancelledRuntime.createSession(cancelledConnection, cancelledDirectory)
      const events: Array<{ payload: Record<string, unknown> }> = []
      for await (const event of cancelledRuntime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { payload: Record<string, unknown> })
      }

      expect(collectEventText(events)).toBe('x-')
      expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
    } finally {
      if (cancelledConnection !== null) {
        await cancelledRuntime.closeConnection(cancelledConnection.connectionId)
      }
      await rm(cancelledDirectory, { recursive: true, force: true })
    }
  })

  it('Adapter 错误离开 Runtime 时不携带 Secret 原文', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-error-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      const script = [
        "const readline = require('node:readline')",
        "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
          + " if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } });"
          + " if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'rejected " + TEST_SECRET + "', data: { api_key: '" + TEST_SECRET + "' } } }) })",
      ].join(';')
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, ['-e', script]))

      const error = await runtime.createSession(connection, runtimeDirectory).then(
        () => null,
        (rejected: unknown) => rejected as { message: string; data: unknown },
      )

      expect(error).not.toBeNull()
      expect(String(error?.message)).not.toContain(TEST_SECRET)
      expect(JSON.stringify(error?.data)).not.toContain(TEST_SECRET)
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('closeConnection 在未决权限请求下收敛且幂等', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-permission-close-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null
    try {
      // Adapter 发出一轮 update 后挂起一个权限请求，且永不应答。
      const script = [
        "const readline = require('node:readline')",
        "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', line => {"
          + " const m = JSON.parse(line);"
          + " if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } });"
          + " if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'session-001', configOptions: [] } });"
          + " if (m.method === 'session/prompt') { send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', text: 'waiting' } } }); send({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { sessionId: 'session-001' } }); } })",
      ].join(';')
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, ['-e', script]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const iterator = runtime.sendTurn({ session, contextBundle: textContextBundle() })[Symbol.asyncIterator]()
      const first = await iterator.next()
      expect(first.value).toMatchObject({ kind: 'agent_message_chunk' })
      const second = await iterator.next()
      expect(second.value).toMatchObject({ kind: 'permission_requested' })

      // 有未决权限请求时关闭必须收敛，不能挂起。
      await expect(runtime.closeConnection(connection.connectionId)).resolves.toBeUndefined()
      // 幂等：重复关闭不再有副作用。
      await expect(runtime.closeConnection(connection.connectionId)).resolves.toBeUndefined()
      connection = null

      // 连接已回收，该权限请求不再可应答。
      await expect(runtime.respondPermission({
        session,
        requestId: 99,
        optionId: 'allow',
      })).rejects.toBeTruthy()
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('不同字段窗口的尾部不会被拼成完整 Secret 发出', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-cross-field-'))
    // Secret 为重复串，两个字段各扣住一半即可重组完整 Secret。
    const repeatedStore: CredentialStorePort = {
      save: async () => 'credential-001',
      get: async () => 'abab',
      validate: async () => true,
      rotate: async () => undefined,
      delete: async () => undefined,
    }
    const runtime = new AcpAgentRuntime(repeatedStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', text: 'ab' } } });",
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'tool_call_update', title: 'ab' } } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ payload: Record<string, unknown> }> = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { payload: Record<string, unknown> })
      }

      expect(JSON.stringify(events)).not.toContain('abab')
      expect(collectEventText(events)).not.toBe('abab')
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('initialize 成功响应回显的 Secret 不进入 CapabilitySnapshot', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-handshake-redact-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      const script = [
        "const readline = require('node:readline')",
        "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
          + " if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1,"
          + ` agentCapabilities: { api_key: '${TEST_SECRET}', note: 'token ${TEST_SECRET}' },`
          + ` agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: ['${TEST_SECRET}'] } }); })`,
      ].join(';')
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, ['-e', script]))

      const serialized = JSON.stringify(connection.capabilities)
      expect(serialized).not.toContain(TEST_SECRET)
      expect(connection.capabilities.adapter_version).toBe('0.1.0')
      expect(connection.capabilities.source).toBe('acp_handshake')
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('session/new 成功响应回显的 Secret 不进入 RuntimeSession 配置', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-session-redact-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      const script = [
        "const readline = require('node:readline')",
        "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
          + " if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } });"
          + " if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'session-001',"
          + ` configOptions: [{ id: 'model', category: 'model', currentValue: 'default-model', options: [{ value: 'model-a', name: 'Model A ${TEST_SECRET}' }] }] } }); })`,
      ].join(';')
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, ['-e', script]))
      const session = await runtime.createSession(connection, runtimeDirectory)

      expect(JSON.stringify(session)).not.toContain(TEST_SECRET)
      // 正常模型配置语义不变。
      expect(session.configOptions).toEqual([{
        id: 'model',
        category: 'model',
        currentValue: 'default-model',
        options: [{ value: 'model-a', name: 'Model A [REDACTED]' }],
      }])
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('set_config_option 成功响应回显的 Secret 不进入返回的配置项', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-config-redact-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/set_config_option') {",
          `send({ jsonrpc: '2.0', id: m.id, result: { configOptions: [{ id: 'model', category: 'model', currentValue: '${TEST_SECRET}', options: [{ value: 'model-a' }] }] } });`,
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const updated = await runtime.setConfigOption(session, 'model', 'model-a')

      expect(JSON.stringify(updated)).not.toContain(TEST_SECRET)
      expect(updated.configOptions[0]).toEqual({
        id: 'model',
        category: 'model',
        currentValue: '[REDACTED]',
        options: [{ value: 'model-a' }],
      })
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('Adapter 空闲退出后清理 Context、scope 与进程', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-idle-exit-'))
    const redaction = new SpyRedaction()
    const runtime = new AcpAgentRuntime(fakeCredentialStore, redaction)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      // 握手成功后 Adapter 自行退出（空闲退出），不依赖任何请求。
      const script = [
        "const readline = require('node:readline')",
        "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
          + " if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } }); })",
        'setTimeout(() => process.exit(0), 30)',
      ].join(';')
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, ['-e', script]))
      const created = connection

      await waitFor(() => redaction.scopes[0]?.closed === true)
      expect(redaction.scopes[0]?.closed).toBe(true)
      // Context 已移除：连接不再可用。
      await expect(runtime.createSession(created, runtimeDirectory)).rejects.toBeTruthy()
      // 异常清理后显式关闭是幂等空操作。
      await expect(runtime.closeConnection(created.connectionId)).resolves.toBeUndefined()
      connection = null
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('Adapter 在存在挂起权限时退出仍收敛', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-exit-with-permission-'))
    const redaction = new SpyRedaction()
    const runtime = new AcpAgentRuntime(fakeCredentialStore, redaction)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', text: 'waiting' } } });",
          "send({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { sessionId: 'session-001' } });",
          'setTimeout(() => process.exit(0), 30)',
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const iterator = runtime.sendTurn({ session, contextBundle: textContextBundle() })[Symbol.asyncIterator]()
      await iterator.next()
      await iterator.next()

      await waitFor(() => redaction.scopes[0]?.closed === true)
      expect(redaction.scopes[0]?.closed).toBe(true)
      // 挂起的权限请求随连接一起失效，不会永远悬空。
      await expect(runtime.respondPermission({ session, requestId: 99, optionId: 'allow' })).rejects.toBeTruthy()
      await expect(runtime.closeConnection(connection.connectionId)).resolves.toBeUndefined()
      connection = null
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('discover 返回的模型目录不携带成功响应回显的 Secret', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-discover-redact-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)

    try {
      const script = [
        "const readline = require('node:readline')",
        "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
          + " if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } });"
          + " if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'session-001',"
          + ` configOptions: [{ id: 'model', category: 'model', currentValue: 'default-model', options: [{ value: 'model-a', name: '${TEST_SECRET}' }] }] } });`
          + " if (m.method === 'session/close') send({ jsonrpc: '2.0', id: m.id, result: {} }); })",
      ].join(';')
      const snapshot = await runtime.discover(
        isolatedClaudeInput(runtimeDirectory, process.execPath, ['-e', script]),
      )

      // ProviderService.discoverModels 会把这里的能力写入 SQLite，Secret 不得进入。
      expect(JSON.stringify(snapshot)).not.toContain(TEST_SECRET)
      expect(snapshot.capabilities.config_options).toEqual([{
        id: 'model',
        category: 'model',
        currentValue: 'default-model',
        options: [{ value: 'model-a', name: '[REDACTED]' }],
      }])
    } finally {
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('thought chunk 的尾部按原始 kind 还原', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-thought-tail-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_thought_chunk', text: 'tail-test-sec' } } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ kind: string; payload: Record<string, unknown> }> = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { kind: string; payload: Record<string, unknown> })
      }

      // 尾部必须保持原 kind，不得改写成普通 Agent 消息。
      expect(events.map((event) => event.kind)).toEqual([
        'agent_thought_chunk',
        'agent_thought_chunk',
        'turn_completed',
      ])
      expect(collectEventText(events)).toBe('tail-test-sec')
      expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('非 text 字段的尾部无法证明归属时被丢弃', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-title-tail-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'tool_call_update', title: 'x-test-sec' } } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ kind: string; payload: Record<string, unknown> }> = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { kind: string; payload: Record<string, unknown> })
      }

      // title 尾部不能改写成 text 字段，因此丢弃而不是凭空造事件。
      expect(events.some((event) => event.kind === 'agent_message_chunk')).toBe(false)
      expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('嵌套字段的尾部被丢弃而不是提到顶层 text', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-nested-tail-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', content: [{ type: 'text', text: 'x-test-sec' }] } } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ kind: string; payload: Record<string, unknown> }> = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { kind: string; payload: Record<string, unknown> })
      }

      expect(events.some((event) => typeof event.payload.text === 'string')).toBe(false)
      expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('归属不唯一的尾部被丢弃', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-mixed-tail-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_message_chunk', text: 'tail-test-sec' } } });",
          "send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'session-001', update: { sessionUpdate: 'agent_thought_chunk', text: 'test-sec' } } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ kind: string; payload: Record<string, unknown> }> = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { kind: string; payload: Record<string, unknown> })
      }

      // 尾部跨越 message / thought 两种归属，无法证明唯一归属，直接丢弃。
      expect(collectEventText(events)).toBe('tail-test-sec')
      expect(JSON.stringify(events)).not.toContain(TEST_SECRET)
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('numeric 1 pending 时 string "1" 应答被拒绝，numeric 仍可应答', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-numeric-pending-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: { sessionId: 'session-001' } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      for await (const _event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        // 消费完事件流
      }

      // 数字 1 仍 pending：字符串 "1" 必须 fail-closed，不能命中它。
      await expect(runtime.respondPermission({ session, requestId: '1', optionId: 'allow' }))
        .rejects.toMatchObject({ code: 'acp_permission_id_not_found' })
      // 原数字请求仍可正常应答。
      await expect(runtime.respondPermission({ session, requestId: 1, optionId: 'allow' })).resolves.toBeUndefined()
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('string "1" pending 时 numeric 1 应答被拒绝，string 仍可应答', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-string-pending-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', id: '1', method: 'session/request_permission', params: { sessionId: 'session-001' } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      for await (const _event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        // 消费完事件流
      }

      await expect(runtime.respondPermission({ session, requestId: 1, optionId: 'allow' }))
        .rejects.toMatchObject({ code: 'acp_permission_id_not_found' })
      await expect(runtime.respondPermission({ session, requestId: '1', optionId: 'allow' })).resolves.toBeUndefined()
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('number 与 string 同值权限请求并存为两条独立请求，可分别应答', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-numeric-event-'))
    const redaction = new SpyRedaction()
    const runtime = new AcpAgentRuntime(fakeCredentialStore, redaction)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 'session-001' } });",
          "send({ jsonrpc: '2.0', id: '7', method: 'session/request_permission', params: { sessionId: 'session-001' } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ kind: string; payload: Record<string, unknown> }> = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { kind: string; payload: Record<string, unknown> })
      }

      // 类型不同 = 两个独立请求，都被接受，且事件保留各自的原始类型。
      const permissionEvents = events.filter((event) => event.kind === 'permission_requested')
      expect(permissionEvents).toHaveLength(2)
      expect(permissionEvents.map((event) => typeof event.payload.request_id)).toEqual(['number', 'string'])

      // 分别应答互不影响。
      await expect(runtime.respondPermission({ session, requestId: 7, optionId: 'allow' })).resolves.toBeUndefined()
      await expect(runtime.respondPermission({ session, requestId: '7', optionId: 'allow' })).resolves.toBeUndefined()
      // 两者都已应答，重复应答 fail-closed。
      await expect(runtime.respondPermission({ session, requestId: 7, optionId: 'allow' })).rejects.toBeTruthy()

      // 关闭时无遗留 pending。
      await expect(runtime.closeConnection(connection.connectionId)).resolves.toBeUndefined()
      connection = null
      expect(redaction.scopes[0]?.closed).toBe(true)
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('合法边界 ID（负/最大 safe integer、非空 string）可分别应答并持久化往返', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-valid-id-domain-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null
    const validIds = [-1, Number.MAX_SAFE_INTEGER, 'request-1']

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          ...validIds.map((id) => `send({ jsonrpc: '2.0', id: ${JSON.stringify(id)}, method: 'session/request_permission', params: { sessionId: 'session-001' } });`),
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ kind: string; payload: Record<string, unknown> }> = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { kind: string; payload: Record<string, unknown> })
      }

      const permissionEvents = events.filter((event) => event.kind === 'permission_requested')
      expect(permissionEvents.map((event) => event.payload.request_id)).toEqual(validIds)

      for (const id of validIds) {
        await expect(runtime.respondPermission({ session, requestId: id, optionId: 'allow' })).resolves.toBeUndefined()
      }
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('非法权限请求 ID 不登记 pending、不发布 permission_requested 且连接收敛', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-invalid-id-'))
    const redaction = new SpyRedaction()
    const runtime = new AcpAgentRuntime(fakeCredentialStore, redaction)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          // 空 string、小数、超安全整数：全部在 ingress 被拒。
          "send({ jsonrpc: '2.0', id: '', method: 'session/request_permission', params: { sessionId: 'session-001' } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ kind: string }> = []
      // 非法帧触发 fatal，sendTurn 以稳定错误收敛（不含原始帧）。
      const failure = await (async () => {
        try {
          for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
            events.push(event as unknown as { kind: string })
          }
          return null
        } catch (error: unknown) {
          return error as { code?: string; message?: string }
        }
      })()

      expect(failure).toMatchObject({ code: 'ACP_INVALID_FRAME' })
      expect(String(failure?.message)).not.toContain('session/request_permission')
      // 没有登记 permission 事件，connection 也随 fatal 收敛。
      expect(events.filter((event) => event.kind === 'permission_requested')).toHaveLength(0)
      await waitFor(() => redaction.scopes[0]?.closed === true)
      expect(redaction.scopes[0]?.closed).toBe(true)
      await expect(runtime.respondPermission({ session, requestId: '', optionId: 'allow' })).rejects.toBeTruthy()
      connection = null
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('同类型同值的重复权限请求 fail-closed，不覆盖已有 pending', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-permission-id-'))
    const runtime = new AcpAgentRuntime(fakeCredentialStore)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, [
        '-e',
        adapterScriptWithHandlers([
          "if (m.method === 'session/prompt') {",
          "send({ jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: { sessionId: 'session-001' } });",
          "send({ jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: { sessionId: 'session-001' } });",
          "send({ jsonrpc: '2.0', id: m.id, result: { stopReason: 'end_turn' } })",
          '}',
        ].join(' ')),
      ]))
      const session = await runtime.createSession(connection, runtimeDirectory)
      const events: Array<{ kind: string }> = []
      for await (const event of runtime.sendTurn({ session, contextBundle: textContextBundle() })) {
        events.push(event as unknown as { kind: string })
      }

      // 真正的冲突（同类型同值）被拒绝：只有一条 permission_requested。
      expect(events.filter((event) => event.kind === 'permission_requested')).toHaveLength(1)

      // 原 pending 仍可正常应答，说明没有被第二个请求覆盖。
      await expect(runtime.respondPermission({ session, requestId: 1, optionId: 'allow' })).resolves.toBeUndefined()
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('inherited 模式下错误 data 顶层数组也被递归脱敏', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-array-data-'))
    const runtime = new AcpAgentRuntime()
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      const script = [
        "const readline = require('node:readline')",
        "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
          + " if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } });"
          + " if (m.method === 'session/new') send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'rejected', data: [{ api_key: 'leaked-value' }, 'api_key=leaked-value'] } }); })",
      ].join(';')
      connection = await runtime.connect({
        providerKind: 'claude',
        adapterCommand: process.execPath,
        adapterArgs: ['-e', script],
        cwd: runtimeDirectory,
        env: {},
        adapterVersion: '1.0.0',
        environmentMode: 'inherited',
        runtimeDirectory,
      })

      const error = await runtime.createSession(connection, runtimeDirectory).then(
        () => null,
        (rejected: unknown) => rejected as { data: unknown },
      )

      expect(error).not.toBeNull()
      expect(JSON.stringify(error?.data)).not.toContain('leaked-value')
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('stdio 半关闭但子进程存活时也触发统一清理', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-half-close-'))
    const redaction = new SpyRedaction()
    const runtime = new AcpAgentRuntime(fakeCredentialStore, redaction)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      // 握手后只关闭 stdout，子进程保持存活：AcpProcess.exited 不会触发。
      const script = [
        "const readline = require('node:readline')",
        "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
          + " if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } });"
          + ' setTimeout(() => process.stdout.end(), 30); } })',
      ].join(';')
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, ['-e', script]))
      const created = connection

      await waitFor(() => redaction.scopes[0]?.closed === true)
      expect(redaction.scopes[0]?.closed).toBe(true)
      await expect(runtime.createSession(created, runtimeDirectory)).rejects.toBeTruthy()
      await expect(runtime.closeConnection(created.connectionId)).resolves.toBeUndefined()
      connection = null
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })

  it('Adapter 发出非法帧触发 fatal 后清理 Context 与 scope', async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), 'rolecast-runtime-fatal-'))
    const redaction = new SpyRedaction()
    const runtime = new AcpAgentRuntime(fakeCredentialStore, redaction)
    let connection: Awaited<ReturnType<AcpAgentRuntime['connect']>> | null = null

    try {
      // 连接建立后写入非法帧，触发 framing fatal。
      const script = [
        "const readline = require('node:readline')",
        "const send = value => process.stdout.write(JSON.stringify(value) + '\\n')",
        "readline.createInterface({ input: process.stdin }).on('line', line => { const m = JSON.parse(line);"
          + " if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: 'fake', version: '0.1.0' }, authMethods: [] } });"
          + " setTimeout(() => process.stdout.write('not-a-json-frame\\n'), 30); } })",
      ].join(';')
      connection = await runtime.connect(isolatedClaudeInput(runtimeDirectory, process.execPath, ['-e', script]))
      const created = connection

      await waitFor(() => redaction.scopes[0]?.closed === true)
      expect(redaction.scopes[0]?.closed).toBe(true)
      await expect(runtime.createSession(created, runtimeDirectory)).rejects.toBeTruthy()
      await expect(runtime.closeConnection(created.connectionId)).resolves.toBeUndefined()
      connection = null
    } finally {
      if (connection !== null) {
        await runtime.closeConnection(connection.connectionId)
      }
      await rm(runtimeDirectory, { recursive: true, force: true })
    }
  })
})
