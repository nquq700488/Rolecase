import { describe, expect, it } from 'vitest'

import { AcpTestHarness, type AcpProvider } from './harness.js'

const integrationEnabled = process.env.RUN_ACP_INTEGRATION === '1'
const providers: AcpProvider[] = process.env.ACP_PROVIDER === undefined
  ? ['claude', 'codex']
  : [process.env.ACP_PROVIDER as AcpProvider]

const integrationTest = integrationEnabled ? it : it.skip

describe('ACP Adapter Contract', () => {
  for (const provider of providers) {
    integrationTest(`${provider} 完成 initialize 和 session/new`, async () => {
      const harness = await AcpTestHarness.start(provider)
      try {
        const initialize = await harness.initialize()
        expect(initialize.protocolVersion).toBe(1)
        expect(initialize.agentCapabilities).toBeDefined()
        expect(initialize.agentInfo).toBeDefined()

        const session = await harness.newSession()
        expect(typeof session.sessionId).toBe('string')
        expect(Array.isArray(session.configOptions)).toBe(true)
      } finally {
        await harness.close()
      }
    }, 120_000)

    integrationTest(`${provider} 流式执行一轮 prompt`, async () => {
      const harness = await AcpTestHarness.start(provider)
      try {
        await harness.initialize()
        const session = await harness.newSession()
        const resultPromise = harness.request<Record<string, unknown>>(
          'session/prompt',
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: '只回复 ACP_PHASE0_OK，不调用工具。' }],
          },
          120_000,
        )
        const update = await harness.waitForNotification((message) => {
          if (message.method !== 'session/update') {
            return false
          }
          const params = message.params as { update?: { sessionUpdate?: string }} | undefined
          return ['agent_message_chunk', 'agent_thought_chunk'].includes(
            params?.update?.sessionUpdate ?? '',
          )
        }, 120_000)
        const result = await resultPromise

        expect(update.method).toBe('session/update')
        expect(result.stopReason).toBeDefined()
      } finally {
        await harness.close()
      }
    }, 180_000)

    integrationTest(`${provider} 权限请求只透传 Adapter 选项`, async () => {
      const harness = await AcpTestHarness.start(provider, { isolated: provider === 'claude' })
      let permissionRequest: Record<string, unknown> | undefined
      const removeRequestHandler = harness.onRequest(async (request) => {
        if (request.method !== 'session/request_permission') {
          return {}
        }
        permissionRequest = request.params as Record<string, unknown>
        const params = permissionRequest
        const options = params.options as Array<{ optionId?: string; kind?: string }> | undefined
        const selected = options?.find((option) => option.kind === 'allow_once') ?? options?.[0]
        if (selected?.optionId === undefined) {
          return { outcome: { outcome: 'cancelled' } }
        }
        return { outcome: { outcome: 'selected', optionId: selected.optionId } }
      })

      try {
        await harness.initialize()
        const session = await harness.newSession()
        const configOptions = session.configOptions as Array<{
          id: string
          category: string
          options?: Array<{ value: string }>
        }>
        const mode = configOptions.find((option) => option.category === 'mode')
        const restrictiveMode = provider === 'codex' ? 'read-only' : 'default'
        const selectedMode = mode?.options?.find((option) => option.value === restrictiveMode)
        if (mode !== undefined && selectedMode !== undefined) {
          await harness.request('session/set_config_option', {
            sessionId: session.sessionId,
            configId: mode.id,
            value: selectedMode.value,
          })
        }

        const result = await harness.request<Record<string, unknown>>(
          'session/prompt',
          {
            sessionId: session.sessionId,
            prompt: [{
              type: 'text',
              text: '请使用工具在当前工作目录创建 permission-phase0.txt，内容为 ACP_PERMISSION_OK。',
            }],
          },
          120_000,
        )

        expect(permissionRequest).toBeDefined()
        expect(Array.isArray((permissionRequest as { options?: unknown[] }).options)).toBe(true)
        expect(result.stopReason).toBeDefined()
      } finally {
        removeRequestHandler()
        await harness.close()
      }
    }, 180_000)

    integrationTest(`${provider} 取消正在执行的 turn`, async () => {
      const harness = await AcpTestHarness.start(provider, { isolated: provider === 'claude' })
      const removeRequestHandler = harness.onRequest(async (request) => {
        if (request.method !== 'session/request_permission') {
          return {}
        }
        const params = request.params as { options?: Array<{ optionId?: string; kind?: string }> }
        const selected = params.options?.find((option) => option.kind === 'allow_once') ?? params.options?.[0]
        return selected?.optionId === undefined
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId: selected.optionId } }
      })
      let promptPromise: Promise<Record<string, unknown>> | undefined

      try {
        await harness.initialize()
        const session = await harness.newSession()
        promptPromise = harness.request<Record<string, unknown>>(
          'session/prompt',
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: '请立即执行 sleep 20，然后回复 CANCEL_NOT_REACHED。' }],
          },
          120_000,
        )
        await harness.waitForNotification((message) => {
          if (message.method !== 'session/update') {
            return false
          }
          const params = message.params as { update?: { sessionUpdate?: string }} | undefined
          return params?.update?.sessionUpdate !== 'available_commands_update'
        }, 30_000)
        harness.notify('session/cancel', { sessionId: session.sessionId })
        const result = await promptPromise

        expect(result.stopReason).toBe('cancelled')
      } finally {
        removeRequestHandler()
        await promptPromise?.catch(() => undefined)
        await harness.close()
      }
    }, 180_000)

    integrationTest(`${provider} resume 当前 ACP Session`, async () => {
      const harness = await AcpTestHarness.start(provider)
      try {
        await harness.initialize()
        const session = await harness.newSession()
        await harness.request('session/resume', {
          sessionId: session.sessionId,
          cwd: harness.workDir,
          mcpServers: [],
        })
        const result = await harness.request<Record<string, unknown>>(
          'session/prompt',
          {
            sessionId: session.sessionId,
            prompt: [{ type: 'text', text: '只回复 ACP_RESUME_OK，不调用工具。' }],
          },
          120_000,
        )

        expect(result.stopReason).toBeDefined()
      } finally {
        await harness.close()
      }
    }, 180_000)

    integrationTest(`${provider} 动态发现并切换模型配置`, async () => {
      const harness = await AcpTestHarness.start(provider)
      try {
        await harness.initialize()
        const session = await harness.newSession()
        const configOptions = session.configOptions as Array<{
          id: string
          category: string
          options?: Array<{ value: string }>
        }>
        const model = configOptions.find((option) => option.category === 'model')
        expect(model?.options?.length).toBeGreaterThan(0)
        if (model?.options?.[0] === undefined || session.sessionId === undefined) {
          throw new Error(`${provider} did not expose a model option`)
        }

        const updated = await harness.request<{ configOptions: unknown[] }>(
          'session/set_config_option',
          {
            sessionId: session.sessionId,
            configId: model.id,
            value: model.options[0].value,
          },
        )
        expect(Array.isArray(updated.configOptions)).toBe(true)
      } finally {
        await harness.close()
      }
    }, 120_000)
  }
})

if (!integrationEnabled) {
  describe('ACP 集成测试门禁', () => {
    it('未设置 RUN_ACP_INTEGRATION 时明确跳过真实 Adapter', () => {
      expect(integrationEnabled).toBe(false)
    })
  })
}
