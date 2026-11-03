import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AcpJsonRpcClient, AcpProcess, resolveAdapterCommand } from '@rolecast/server'

import { ensureAdapterExited } from './adapter-cleanup.js'
import { startMockEndpoint, type MockEndpoint } from './mock-endpoint.js'
import { buildProbeEnvironment, isSensitiveEnvironmentKey, sandboxCommand, writeLoopbackOnlyProfile } from './sandbox.js'

// Batch 0 硬门槛：默认跳过，只有显式 RUN_PROVIDER_ADAPTER_PROBE=1 才运行。
const probeEnabled = process.env.RUN_PROVIDER_ADAPTER_PROBE === '1'
const sandbox = sandboxCommand()

/** 一次 Probe case 的结果摘要；只记录非敏感元数据。 */
interface ProbeOutcome {
  readonly connectOk: boolean
  readonly sessionOk: boolean
  readonly turnSettled: boolean
  readonly errorKind: string
}

/** 每个 Provider 至少必须观测到的业务请求（Adapter 连通性探测不算业务请求）。 */
const EXPECTED_BUSINESS_REQUEST: Record<'claude' | 'codex', { method: string; path: string }> = {
  claude: { method: 'POST', path: '/v1/messages' },
  codex: { method: 'POST', path: '/responses' },
}

/**
 * 业务请求的认证来源必须与当前实测一致。
 *
 * Claude 使用注入的合成 API Key（`x-api-key`）；Codex 在 custom endpoint 上
 * **不带任何认证头**——这正是「Codex custom endpoint 认证未证、不得声明 ready」
 * 的证据来源。Adapter 行为若发生变化，这里必须失败并触发重新评审。
 */
const EXPECTED_AUTH_SOURCE: Record<'claude' | 'codex', 'x-api-key-header' | 'none'> = {
  claude: 'x-api-key-header',
  codex: 'none',
}

/** 关闭 mock 并递归删除 profile 目录；两者都失败时聚合报告，任一失败都让测试失败。 */
async function closeMockAndDirectory(
  mock: MockEndpoint,
  directory: string | null,
): Promise<Error | null> {
  const mockError = await mock.close().then(
    () => null,
    (error: unknown) => error ?? new Error('unknown mock close failure'),
  )
  const directoryError = directory === null
    ? null
    : await rm(directory, { recursive: true, force: true }).then(
        () => null,
        (error: unknown) => error ?? new Error('unknown directory cleanup failure'),
      )
  if (mockError !== null && directoryError !== null) {
    return new Error('Probe 清理失败：mock endpoint 与 profile 目录均未清理')
  }
  if (mockError !== null) {
    return new Error('Probe 清理失败：mock endpoint 未正常关闭')
  }
  if (directoryError !== null) {
    return new Error('Probe 清理失败：profile 目录未删除')
  }
  return null
}

/**
 * 在 sandbox 内启动锁定 Adapter 并执行 initialize → session/new → 最小 prompt。
 *
 * 子进程只拿到最小 allowlist 环境 + 本用例的合成配置；不继承真实凭据或代理。
 */
async function runProbe(options: {
  provider: 'claude' | 'codex'
  environmentMode: 'inherited' | 'isolated'
  baseUrl: string
  profile: string
  mock: MockEndpoint
}): Promise<ProbeOutcome> {
  const workDirectory = await mkdtemp(join(tmpdir(), 'rolecast-adapter-probe-'))
  const runtimeDirectory = join(workDirectory, 'provider-config')
  const syntheticSecret = `synthetic-${randomUUID()}`
  let adapterProcess: AcpProcess | null = null
  let outcome: ProbeOutcome | null = null
  let primaryError: unknown = null
  let cleanupError: unknown = null
  /** 进程未确认退出时保留的目录；为 null 表示目录已被删除。 */
  let keptDirectory: string | null = null

  // 目录创建之后的所有 setup 都必须能被 finally 回收。
  try {
    await chmod(workDirectory, 0o700)
    await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })

    const synthetic: Record<string, string> = {}
    if (options.provider === 'claude') {
      // Claude 读取 ANTHROPIC_BASE_URL；认证只来自本用例注入的合成值。
      synthetic.ANTHROPIC_BASE_URL = options.baseUrl
      synthetic.CLAUDE_CONFIG_DIR = runtimeDirectory
      synthetic.ANTHROPIC_API_KEY = syntheticSecret
    } else {
      // Codex 不读取 OPENAI_BASE_URL：只认 CODEX_HOME/config.toml。用临时
      // CODEX_HOME 复现生产路径，不触碰用户真实配置。
      synthetic.CODEX_HOME = runtimeDirectory
      if (options.environmentMode === 'isolated') {
        synthetic.OPENAI_API_KEY = syntheticSecret
      }
      await writeFile(
        join(runtimeDirectory, 'config.toml'),
        [
          'model = "probe-model"',
          'model_provider = "rolecast"',
          '',
          '[model_providers.rolecast]',
          'name = "Rolecast"',
          `base_url = "${options.baseUrl}"`,
          'wire_api = "responses"',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o600 },
      )
    }

    const environment = buildProbeEnvironment(workDirectory, synthetic)
    // 回归保护：allowlist 结果里不允许出现任何敏感类变量。
    for (const key of Object.keys(environment)) {
      if (!(key in synthetic)) {
        expect(isSensitiveEnvironmentKey(key)).toBe(false)
      }
    }

    const adapter = resolveAdapterCommand(options.provider, undefined)
    // Adapter 子进程同样必须运行在 sandbox 内；sandbox-exec 会向子进程继承策略。
    adapterProcess = await AcpProcess.start({
      command: '/usr/bin/sandbox-exec',
      args: ['-f', options.profile, adapter.command, ...adapter.args],
      cwd: workDirectory,
      env: environment,
    })
    outcome = await driveAdapter(adapterProcess, options.provider, workDirectory)
  } catch (error: unknown) {
    primaryError = error
  } finally {
    // close 正常路径会等到进程确认退出；close 本身失败时强制回收并再次确认。
    let adapterExited = true
    if (adapterProcess !== null) {
      const cleanup = await ensureAdapterExited(adapterProcess)
      adapterExited = cleanup.exited
      cleanupError = cleanup.error
    }
    if (adapterExited) {
      const directoryError = await rm(workDirectory, { recursive: true, force: true }).then(
        () => null,
        (error: unknown) => error ?? new Error('unknown directory cleanup failure'),
      )
      if (cleanupError === null) {
        cleanupError = directoryError
      }
    } else {
      // 进程未确认退出：保留目录用于诊断，且不能让 Probe 看起来通过。
      keptDirectory = workDirectory
      cleanupError = new Error('adapter process did not exit; work directory kept for diagnosis')
    }
  }

  if (cleanupError !== null) {
    // 清理失败优先报告，避免被主异常掩盖；只提示实际仍存在的目录。
    const name = cleanupError instanceof Error ? cleanupError.name : typeof cleanupError
    const location = keptDirectory === null
      ? '请检查是否有残留 Adapter 进程'
      : `工作目录 ${keptDirectory} 已保留用于诊断`
    throw new Error(`Probe 清理失败（cleanup=${name}）：${location}`)
  }
  if (primaryError !== null) {
    throw primaryError
  }
  if (outcome === null) {
    throw new Error('Probe 未产生结果')
  }
  return outcome
}

/** 驱动 ACP 握手与一次最小 prompt，返回观测结果。 */
async function driveAdapter(
  adapterProcess: AcpProcess,
  provider: 'claude' | 'codex',
  workDirectory: string,
): Promise<ProbeOutcome> {
  const client = new AcpJsonRpcClient(adapterProcess.stdout, adapterProcess.stdin)
  client.onRequest(() => ({ outcome: { outcome: 'cancelled' } }))
  let connectOk = false
  let sessionOk = false
  let turnSettled = false
  let errorKind = ''

  try {
    const initialize = await client.request<Record<string, unknown>>('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    }, 60_000)
    connectOk = initialize.protocolVersion !== undefined

    const session = await client.request<Record<string, unknown>>('session/new', {
      cwd: workDirectory,
      mcpServers: [],
    }, 60_000)
    const sessionId = session.sessionId
    sessionOk = typeof sessionId === 'string' && sessionId.length > 0

    if (sessionOk) {
      try {
        await client.request('session/prompt', {
          sessionId,
          prompt: [{ type: 'text', text: `probe-${provider}` }],
        }, 20_000)
        turnSettled = true
      } catch (error: unknown) {
        // 合成凭据下 turn 失败是预期结果；只记录错误类别，不记录 message。
        errorKind = error instanceof Error ? error.name : 'unknown'
      }
    }
  } catch (error: unknown) {
    errorKind = error instanceof Error ? error.name : 'unknown'
  } finally {
    client.close()
  }

  return { connectOk, sessionOk, turnSettled, errorKind }
}

describe.skipIf(!probeEnabled || !sandbox.available)('Provider Adapter Contract Probe', () => {
  for (const provider of ['claude', 'codex'] as const) {
    for (const environmentMode of ['isolated', 'inherited'] as const) {
      it(`${provider} ${environmentMode} custom endpoint 命中预期业务请求`, async () => {
        const mock = await startMockEndpoint(0)
        // profile 目录在 finally 中回收；初始化失败也不能遗留。
        let directory: string | null = null
        let cleanupError: unknown = null

        try {
          directory = await mkdtemp(join(tmpdir(), `rolecast-probe-${provider}-${environmentMode}-`))
          await chmod(directory, 0o700)
          const profile = await writeLoopbackOnlyProfile(directory)
          const outcome = await runProbe({
            provider,
            environmentMode,
            baseUrl: mock.baseUrl,
            profile,
            mock,
          })
          const requests = mock.requests

          // 正向证据：握手与会话必须成功，不能靠「没有请求」蒙混通过。
          expect(outcome.connectOk).toBe(true)
          expect(outcome.sessionOk).toBe(true)
          expect(requests.length).toBeGreaterThan(0)

          const expected = EXPECTED_BUSINESS_REQUEST[provider]
          const business = requests.filter((request) => request.method === expected.method
            && request.path === expected.path)
          expect(business.length).toBeGreaterThan(0)

          // 认证来源锁定当前实测行为：Adapter 行为变化必须让测试失败，
          // 而不是静默改变「Codex custom endpoint 认证未证」的支持结论。
          for (const request of business) {
            expect(request.authSource).toBe(EXPECTED_AUTH_SOURCE[provider])
          }

          // 所有命中都必须落在 mock 的 loopback 地址上。
          for (const request of requests) {
            expect(request.host).toBe(`127.0.0.1:${mock.port}`)
          }

          // 只输出非敏感元数据（path 已剥离 query）。
          console.log(`PROBE_${provider}_${environmentMode}`, JSON.stringify({
            connectOk: outcome.connectOk,
            sessionOk: outcome.sessionOk,
            turnSettled: outcome.turnSettled,
            errorKind: outcome.errorKind,
            hitCount: requests.length,
            businessHits: business.length,
            paths: [...new Set(requests.map((request) => `${request.method} ${request.path}`))],
            authSources: [...new Set(business.map((request) => request.authSource))],
          }))
        } finally {
          cleanupError = await closeMockAndDirectory(mock, directory)
        }
        if (cleanupError !== null) {
          throw cleanupError
        }
      }, 120_000)
    }
  }

  it('非 loopback endpoint 被 sandbox 拒绝，Adapter 不会命中 mock', async () => {
    const mock = await startMockEndpoint(0)
    let directory: string | null = null

    try {
      directory = await mkdtemp(join(tmpdir(), 'rolecast-probe-adapter-sentinel-'))
      await chmod(directory, 0o700)
      const profile = await writeLoopbackOnlyProfile(directory)
      const outcome = await runProbe({
        provider: 'claude',
        environmentMode: 'isolated',
        baseUrl: 'http://192.0.2.1:9',
        profile,
        mock,
      })
      // 非 loopback endpoint 不可达：Adapter 不得命中 mock。
      expect(outcome.connectOk && outcome.sessionOk).toBe(true)
      expect(mock.requests).toEqual([])
    } finally {
      const cleanupError = await closeMockAndDirectory(mock, directory)
      if (cleanupError !== null) {
        throw cleanupError
      }
    }
  }, 120_000)
})

describe.skipIf(!probeEnabled)('Probe 子进程环境 allowlist', () => {
  it('不继承真实凭据或代理变量（含大小写变体）', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-probe-env-'))
    try {
      // 模拟开发机上常见的泄漏来源。
      const saved = {
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        'http_proxy': process.env['http_proxy'],
      }
      process.env.ANTHROPIC_AUTH_TOKEN = 'should-not-leak'
      process.env.HTTPS_PROXY = 'http://127.0.0.1:9'
      process.env['http_proxy'] = 'http://127.0.0.1:9'
      try {
        const environment = buildProbeEnvironment(directory, { ANTHROPIC_API_KEY: 'synthetic' })
        expect(environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
        expect(environment.HTTPS_PROXY).toBeUndefined()
        expect(environment['http_proxy']).toBeUndefined()
        expect(environment.HOME).toBe(directory)
        expect(environment.ANTHROPIC_API_KEY).toBe('synthetic')
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('mock 只记录 pathname，query 中的凭据不会进入记录', async () => {
    const mock = await startMockEndpoint(0)
    try {
      await new Promise<void>((resolve, reject) => {
        const script = [
          "const http = require('node:http')",
          'const request = http.get(process.argv[1], (response) => { response.resume(); response.on("end", () => process.exit(0)) })',
          'request.on("error", () => process.exit(1))',
        ].join(';')
        const request = spawn(process.execPath, ['-e', script, `${mock.baseUrl}/v1/messages?api_key=synthetic-query-secret`], {
          stdio: 'ignore',
        })
        request.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('probe request failed'))))
        request.once('error', reject)
      })

      const recorded = JSON.stringify(mock.requests)
      expect(mock.requests[0]?.path).toBe('/v1/messages')
      expect(recorded).not.toContain('synthetic-query-secret')
    } finally {
      await mock.close()
    }
  })
})
