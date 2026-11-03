import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AcpJsonRpcClient, AcpProcess, resolveAdapterCommand } from '@rolecast/server'

import { ensureAdapterExited } from '../provider-adapter-probe/adapter-cleanup.js'
import { buildProbeEnvironment, sandboxCommand, writeLoopbackOnlyProfile } from '../provider-adapter-probe/sandbox.js'
import {
  summarizeAuthMethods,
  summarizeAuthStatusEnvelope,
  summarizeUrl,
  type AuthMethodSummary,
} from './auth-summary.js'
import { decideDeviceCodeOutcome, type DeviceCodeOutcome } from './device-code-outcome.js'
import {
  classifyAdapterError,
  classifyAuthenticateFailure,
  classifyElicitation,
  observeAgentCapabilities,
} from './probe-guards.js'
import { decideCleanup, waitForStatusNotification } from './probe-window.js'

// 真实 Adapter 探针默认跳过：只有显式 opt-in 才启动锁定 Adapter。
const feasibilityEnabled = process.env.RUN_PROVIDER_AUTH_FEASIBILITY === '1'
const flowEnabled = process.env.RUN_PROVIDER_AUTH_FLOW === '1'
const sandbox = sandboxCommand()

type Provider = 'claude' | 'codex'

/** 客户端能力声明组合：只用于观察 Adapter 暴露的认证方法差异。 */
const CAPABILITY_MATRIX = [
  { name: 'default', capabilities: {} },
  // Claude 的认证方法取决于 auth.terminal 与顶层 terminal（可启动交互终端）。
  { name: 'terminal', capabilities: { terminal: true, auth: { terminal: true } } },
  // URL elicitation 是顶层能力，且 url 必须是对象：Adapter 检查 elicitation.url != null。
  { name: 'url-elicitation', capabilities: { elicitation: { url: {} } } },
  // gateway 是 auth._meta.gateway 元能力。
  { name: 'gateway', capabilities: { auth: { _meta: { gateway: true } } } },
] as const

/** 一次能力观察的非敏感结果。 */
interface CapabilityObservation {
  readonly capability: string
  readonly methods: readonly AuthMethodSummary[]
  readonly logoutDeclared: boolean
  readonly statusKinds: readonly string[]
}

/**
 * 清理失败错误：`keepDirectory` 决定外层是否允许删除父目录。
 *
 * 进程未确认退出时必须保留目录供诊断；只有确认退出后才允许递归删除。
 */
class ProbeCleanupError extends Error {
  constructor(message: string, readonly keepDirectory: boolean) {
    super(message)
    this.name = 'ProbeCleanupError'
  }
}

/** `_auth/status_update` 的有界观察窗口：超时只表示未观察到。 */
const AUTH_STATUS_WINDOW_MS = 1_500

/** Codex 需要可物化的非秘密配置才能启动；不含任何凭据。 */
const CODEX_CONFIG_TOML = [
  'model = "probe-model"',
  'model_provider = "rolecast"',
  '',
  '[model_providers.rolecast]',
  'name = "Rolecast"',
  'base_url = "http://127.0.0.1:9/v1"',
  'wire_api = "responses"',
  '',
].join('\n')

/** 写入 Codex 的最小非秘密配置目录。 */
async function prepareRuntimeDirectory(provider: Provider, runtimeDirectory: string): Promise<void> {
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  if (provider === 'codex') {
    await writeFile(join(runtimeDirectory, 'config.toml'), CODEX_CONFIG_TOML, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }
}

/**
 * 在 loopback-only sandbox 内启动锁定 Adapter，只做 initialize 并收集认证摘要。
 *
 * 不发送 prompt、不调用 authenticate、不打开浏览器、不读写用户配置。
 */
async function observeCapabilities(
  provider: Provider,
  capability: (typeof CAPABILITY_MATRIX)[number],
  profile: string,
  workDirectory: string,
): Promise<CapabilityObservation> {
  const runtimeDirectory = join(workDirectory, `config-${capability.name}`)
  await prepareRuntimeDirectory(provider, runtimeDirectory)
  const environment = buildProbeEnvironment(workDirectory, {
    ...(provider === 'claude'
      ? { CLAUDE_CONFIG_DIR: runtimeDirectory, ANTHROPIC_API_KEY: 'synthetic-probe-key' }
      : { CODEX_HOME: runtimeDirectory, OPENAI_API_KEY: 'synthetic-probe-key' }),
  })

  const adapter = resolveAdapterCommand(provider, undefined)
  const adapterProcess = await AcpProcess.start({
    command: '/usr/bin/sandbox-exec',
    args: ['-f', profile, adapter.command, ...adapter.args],
    cwd: workDirectory,
    env: environment,
  })

  // 结果暂存在 finally 之外，确保清理结论不会被 try 内的 return 绕过。
  let observation: CapabilityObservation | null = null
  let primaryError: unknown = null
  let cleanupError: Error | null = null
  let directoryRemoved = false

  try {
    const notifications: unknown[] = []
    const client = new AcpJsonRpcClient(adapterProcess.stdout, adapterProcess.stdin)
    client.onNotification((message) => {
      // 只保留 `authStatus` 包装本身；不保存完整 params 或原始帧。
      if (message.method === '_auth/status_update') {
        const params = typeof message.params === 'object' && message.params !== null
          ? (message.params as Record<string, unknown>)
          : {}
        notifications.push({ authStatus: params.authStatus })
      }
    })
    client.onRequest(() => ({ outcome: { outcome: 'cancelled' } }))

    const initialize = await client.request<Record<string, unknown>>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        ...(capability.capabilities as object),
      },
    }, 60_000)
    // 有界窗口内等待异步状态通知，再关闭 framing 层。
    await waitForStatusNotification(() => notifications.length, { deadlineMs: AUTH_STATUS_WINDOW_MS })
    client.close()

    observation = {
      capability: capability.name,
      methods: summarizeAuthMethods(initialize.authMethods),
      // 直接读 agentCapabilities.auth.logout，不用 authMethods 推断。
      logoutDeclared: observeAgentCapabilities(initialize).logoutDeclared,
      statusKinds: summarizeAuthStatusEnvelope(notifications).kinds,
    }
  } catch (error: unknown) {
    // Adapter 错误可能回显 Secret/URL/metadata：只保留稳定分类。
    primaryError = classifyAdapterError(error)
  } finally {
    const cleanup = await ensureAdapterExited(adapterProcess)
    cleanupError = cleanup.error
    const decision = decideCleanup(cleanup)
    if (decision.keepDirectory) {
      // 进程未确认退出或清理报错：保留诊断目录，并让外层也不要删除。
      throw new ProbeCleanupError(decision.reason ?? 'cleanup failed', true)
    }
    const removal = await rm(runtimeDirectory, { recursive: true, force: true }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error('directory cleanup failed')),
    )
    directoryRemoved = removal === null
    if (removal !== null) {
      cleanupError = removal
    }
  }

  if (cleanupError !== null) {
    throw new ProbeCleanupError(cleanupError.message, true)
  }
  if (primaryError !== null) {
    throw primaryError
  }
  if (observation === null || !directoryRemoved) {
    throw new ProbeCleanupError('probe did not produce a complete observation', false)
  }
  return observation
}

/** device-code 探针的内部观察状态；不直接作为通过证据。 */
interface FlowObservation {
  methodDeclared: boolean
  urlElicitationObserved: boolean
  cancellationDelivered: boolean
  authenticateSettled: boolean
  authenticateFailure: string | null
  url: ReturnType<typeof summarizeUrl> | null
  resourcesReleased: boolean
  egressBlockedEvidence: boolean
}

/**
 * 只尝试「启动 device-code 后立即取消」。
 *
 * 无论是否观察到 elicitation，都不会打开浏览器、不会提交凭据、不会扩大出口。
 */
async function probeDeviceCodeCancellation(
  profile: string,
  workDirectory: string,
): Promise<DeviceCodeOutcome> {
  const runtimeDirectory = join(workDirectory, 'config-flow')
  await prepareRuntimeDirectory('codex', runtimeDirectory)
  const environment = buildProbeEnvironment(workDirectory, {
    CODEX_HOME: runtimeDirectory,
    OPENAI_API_KEY: 'synthetic-probe-key',
  })
  const adapter = resolveAdapterCommand('codex', undefined)
  const adapterProcess = await AcpProcess.start({
    command: '/usr/bin/sandbox-exec',
    args: ['-f', profile, adapter.command, ...adapter.args],
    cwd: workDirectory,
    env: environment,
  })

  const state: FlowObservation = {
    methodDeclared: false,
    urlElicitationObserved: false,
    cancellationDelivered: false,
    authenticateSettled: false,
    authenticateFailure: null,
    url: null,
    resourcesReleased: false,
    // 只有真的拿到 sandbox/网络拒绝证据时才允许声称出口阻断。
    egressBlockedEvidence: false,
  }
  let cleanupError: Error | null = null

  try {
    const client = new AcpJsonRpcClient(adapterProcess.stdout, adapterProcess.stdin)
    // elicitation/create 是 Adapter 反向请求：必须先分类，再决定是否作为证据。
    client.onRequest((request) => {
      if (request.method === 'elicitation/create') {
        const verdict = classifyElicitation(request.params)
        if (!verdict.accepted) {
          // form 模式或畸形 URL：不构成 URL elicitation 证据。
          state.authenticateFailure = `elicitation_${verdict.reason}`
          return { action: 'cancel' }
        }
        state.urlElicitationObserved = true
        state.url = verdict.url
        state.cancellationDelivered = true
        // 拒绝：明确返回 cancelled，不提交任何用户输入。
        return { action: 'cancel' }
      }
      return {}
    })

    const initialize = await client.request<Record<string, unknown>>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
        elicitation: { url: {} },
      },
    }, 60_000)
    state.methodDeclared = summarizeAuthMethods(initialize.authMethods)
      .some((method) => method.method_id === 'chat-gpt-device-code')

    if (state.methodDeclared) {
      try {
        await client.request('authenticate', { methodId: 'chat-gpt-device-code' }, 15_000)
        // 正常返回既不是取消也不是成功证据；即使已观察 elicitation 也不能通过。
        state.authenticateSettled = false
        state.authenticateFailure = 'authenticate_resolved_without_cancellation'
      } catch (error: unknown) {
        // 只有取消类错误才算客户端拒绝；timeout / transport / remote 都是 unverified。
        state.authenticateFailure = classifyAuthenticateFailure(error)
        state.authenticateSettled = state.authenticateFailure === 'cancelled'
      }
    }
    client.close()
  } catch (error: unknown) {
    // 外层错误同样只保留分类，避免 Adapter 回显内容进入输出。
    state.authenticateFailure = classifyAdapterError(error).stage
  } finally {
    const cleanup = await ensureAdapterExited(adapterProcess)
    cleanupError = cleanup.error
    const decision = decideCleanup(cleanup)
    if (decision.keepDirectory) {
      // 未确认退出或清理报错：保留诊断目录，外层也不删除。
      throw new ProbeCleanupError(decision.reason ?? 'cleanup failed', true)
    }
    const removal = await rm(runtimeDirectory, { recursive: true, force: true }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error : new Error('directory cleanup failed')),
    )
    state.resourcesReleased = removal === null
    if (removal !== null) {
      cleanupError = removal
    }
  }

  if (cleanupError !== null) {
    throw new ProbeCleanupError(cleanupError.message, true)
  }
  if (state.authenticateFailure === 'authenticate_resolved_without_cancellation') {
    // 正常 resolve 永远不构成取消证据，无论 elicitation 是否出现。
    return { status: 'unverified', reason: 'authenticate_resolved_without_cancellation' }
  }
  if (state.authenticateFailure !== null && !state.urlElicitationObserved) {
    // 在 elicitation 之前就失败：区分「明确网络阻断」与普通错误。
    return {
      status: 'unverified',
      reason: state.egressBlockedEvidence
        ? 'elicitation_not_observed_before_network_block'
        : `elicitation_not_observed:${state.authenticateFailure}`,
    }
  }
  return decideDeviceCodeOutcome({
    methodDeclared: state.methodDeclared,
    elicitationObserved: state.urlElicitationObserved,
    cancellationDelivered: state.cancellationDelivered,
    authenticateCancelled: state.authenticateFailure === 'cancelled',
    adapterSettled: state.authenticateSettled,
    // pending 由客户端关闭后不再存在；只有真正 settle 才允许记为 0。
    pendingRequests: state.authenticateSettled ? 0 : 1,
    resourcesReleased: state.resourcesReleased,
    egressBlocked: state.egressBlockedEvidence,
    url: state.url,
  })
}

describe.skipIf(!feasibilityEnabled || !sandbox.available)('Provider Auth Feasibility Probe', () => {
  for (const provider of ['claude', 'codex'] as const) {
    it(`${provider} 在客户端能力声明下的认证方法摘要`, async () => {
      const directory = await mkdtemp(join(tmpdir(), `rolecast-auth-probe-${provider}-`))
      await chmod(directory, 0o700)
      const profile = await writeLoopbackOnlyProfile(directory)
      const observations: CapabilityObservation[] = []
      let keepDirectory = false

      try {
        for (const capability of CAPABILITY_MATRIX) {
          observations.push(await observeCapabilities(provider, capability, profile, directory))
        }
        // 只输出白名单摘要：无原始 method 对象、无 args/env 值、无 URL。
        console.log(`AUTH_PROBE_${provider}`, JSON.stringify(observations))
        for (const observation of observations) {
          for (const method of observation.methods) {
            expect(Object.keys(method).sort()).toEqual([
              'args_count',
              'args_present',
              'env_count',
              'env_present',
              'method_id',
              'type',
            ])
          }
        }
      } catch (error: unknown) {
        keepDirectory = error instanceof ProbeCleanupError && error.keepDirectory
        throw error
      } finally {
        if (!keepDirectory) {
          await rm(directory, { recursive: true, force: true })
        }
      }
    }, 180_000)
  }

  it.skipIf(!flowEnabled)('Codex device-code 取消生命周期验证', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-auth-flow-'))
    await chmod(directory, 0o700)
    const profile = await writeLoopbackOnlyProfile(directory)
    let outcome: DeviceCodeOutcome
    let keepDirectory = false

    try {
      outcome = await probeDeviceCodeCancellation(profile, directory)
      console.log('AUTH_FLOW_CODEX_DEVICE_CODE', JSON.stringify(outcome))
    } catch (error: unknown) {
      keepDirectory = error instanceof ProbeCleanupError && error.keepDirectory
      throw error
    } finally {
      if (!keepDirectory) {
        await rm(directory, { recursive: true, force: true })
      }
    }

    if (outcome.status !== 'cancelled_and_cleaned') {
      // 未验证不能算通过：把结论明确记录为跳过，而不是让绿色测试掩盖它。
      // Probe 进程清理本身已在 outcome 内体现；这里区分的是「取消生命周期是否已验证」。
      throw new Error(
        `probe_cleanup_ok_but_cancellation_unverified: ${outcome.status}/${'reason' in outcome ? outcome.reason : ''}`,
      )
    }
    // 只有完整证据（真实 elicitation + 取消 + 收敛 + 无 pending + 资源回收）才算通过。
    expect(outcome.status).toBe('cancelled_and_cleaned')
    expect(outcome.url.scheme).not.toBe('invalid')
    expect(outcome.url.host_class).not.toBe('invalid')
  }, 180_000)
})

describe.skipIf(feasibilityEnabled)('Provider Auth Feasibility Probe 默认跳过', () => {
  it('未设置 RUN_PROVIDER_AUTH_FEASIBILITY=1 时不启动真实 Adapter', () => {
    // 该用例只是让「跳过」在报告里可见，不做任何外部调用。
    expect(feasibilityEnabled).toBe(false)
  })
})
