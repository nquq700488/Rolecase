import { randomUUID } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  AcpAgentRuntime,
  resolveAdapterCommand,
  type AgentRuntimeConnectionInput,
  type CredentialStorePort,
} from '@rolecast/server'

import {
  attachTranscriptEvidence,
  describeClaudeTranscript,
  redactCanary,
  sanitizeDiagnosticText,
} from './acp-session-resume-transcript.js'

import {
  SandboxProbeExitUnconfirmedError,
  buildProbeEnvironment,
  isSensitiveEnvironmentKey,
  sandboxCommand,
  sandboxedCommand,
  verifyRuntimePaths,
  verifyStrictSandbox,
  writeStrictSandboxProfile,
} from './provider-adapter-probe/sandbox.js'

type AcpProvider = 'claude' | 'codex'
type RuntimeConnection = Awaited<ReturnType<AcpAgentRuntime['connect']>>

/** smoke 可辨识阶段；失败消息必须能定位到其中之一。 */
type SmokeStage =
  | 'fixture-setup'
  | 'sandbox-preflight'
  | 'runtime-a-connect'
  | 'runtime-a-session-new'
  | 'runtime-a-close'
  | 'runtime-b-connect'
  | 'runtime-b-session-resume'
  | 'cleanup'

/** 带阶段标签的 smoke 失败；最终诊断由 safeFailure 脱敏后重建。 */
class SmokeStageError extends Error {
  constructor(
    readonly stage: SmokeStage,
    readonly reason: Error,
  ) {
    super(`[${stage}] ${reason.message}`)
    this.name = 'SmokeStageError'
  }
}

/** setup 失败且部分创建的私有树无法删除：保留原错误并报告受控 parentRoot。 */
class SmokeResidualPathError extends Error {
  constructor(
    readonly reason: Error,
    readonly residualPath: string,
  ) {
    super(reason.message)
    this.name = 'SmokeResidualPathError'
  }
}

async function runStage<T>(stage: SmokeStage, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error: unknown) {
    throw new SmokeStageError(stage, toError(error))
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('unknown smoke failure')
}

interface ResumeSmokeFixture {
  readonly roots: Awaited<ReturnType<typeof createSandboxRoots>>
  readonly secret: string
  readonly credentialRef: string
  readonly credentials: InMemoryCredentialStore
  readonly runtimeA: AcpAgentRuntime
  readonly runtimeB: AcpAgentRuntime
  readonly environment: NodeJS.ProcessEnv
  readonly input: AgentRuntimeConnectionInput
  connectionA: RuntimeConnection | null
  connectionB: RuntimeConnection | null
  connectionAStopped: boolean
  connectionACloseFailed: boolean
  connectionStartupUnconfirmed: boolean
  /** sandbox probe 进程退出未确认：必须保留临时目录。 */
  probeExitUnconfirmed: boolean
  /** Claude transcript 元数据证据：A 退出确认后、B connect 前收集。 */
  transcriptEvidence: string | null
}

// 原 no-prompt Claude 场景只作为独立的 zero-turn 负向边界诊断。
const zeroTurnDiagnosticEnabled = process.env.RUN_CLAUDE_ZERO_TURN_DIAGNOSTIC === '1'
const zeroTurnTest = zeroTurnDiagnosticEnabled ? it : it.skip

class InMemoryCredentialStore implements CredentialStorePort {
  readonly reads: string[] = []

  constructor(
    private readonly reference: string,
    private readonly secret: string,
  ) {}

  async save(_operationKey: string, _secret: string): Promise<string> {
    throw new Error('smoke CredentialStore only supports reads')
  }

  async get(reference: string): Promise<string | null> {
    this.reads.push(reference)
    return reference === this.reference ? this.secret : null
  }

  async validate(reference: string): Promise<boolean> {
    return reference === this.reference
  }

  async rotate(_reference: string, _secret: string): Promise<void> {
    throw new Error('smoke CredentialStore does not support rotation')
  }

  async delete(_reference: string): Promise<void> {
    throw new Error('smoke CredentialStore does not support deletion')
  }
}

describe('ACP Session resume smoke 安全辅助', () => {
  it('canary 扫描遇到 symlink 时拒绝且不读取目标', async () => {
    const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-canary-scan-')))
    const adapterRoot = join(parentRoot, 'adapter')
    const outsideFile = join(parentRoot, 'outside.txt')
    const marker = 'non-secret-scan-marker'
    await mkdir(adapterRoot, { mode: 0o700 })
    await writeFile(outsideFile, marker, { encoding: 'utf8', mode: 0o600 })
    await symlink(outsideFile, join(adapterRoot, 'escape.txt'))

    try {
      await expect(scanPrivateRootForCanary(adapterRoot, marker)).rejects.toThrow('canary scan refuses symlink')
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('canary 扫描只返回相对路径，不返回 Secret 内容', async () => {
    const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-canary-scan-')))
    const adapterRoot = join(parentRoot, 'adapter')
    const marker = 'non-secret-scan-marker'
    await mkdir(adapterRoot, { mode: 0o700 })
    await writeFile(join(adapterRoot, 'artifact.txt'), `output ${marker}`, { encoding: 'utf8', mode: 0o600 })

    try {
      const matches = await scanPrivateRootForCanary(adapterRoot, marker)
      expect(matches).toEqual(['artifact.txt'])
      expect(matches.join(' ').includes(marker)).toBe(false)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })
})

/** 模拟 Adapter 远端错误：data 与绝对路径都不得进入最终诊断。 */
class FakeRemoteError extends Error {
  readonly code = -32002
  readonly data = { detail: 'must-not-appear', path: '/private/adapter/data' }

  constructor(canary: string) {
    super(`Resource not found: ${canary} at /var/folders/private/session`)
    this.name = 'AcpRemoteError'
  }
}

describe('ACP Session resume smoke 诊断脱敏', () => {
  it('阶段错误保留 stage/name/code，并移除 canary、绝对路径与 error.data', () => {
    const canary = 'synthetic-diagnostic-canary'
    const staged = new SmokeStageError('runtime-b-session-resume', new FakeRemoteError(canary))
    const failure = safeFailure(staged, canary)

    expect(failure.message).toContain('[runtime-b-session-resume]')
    expect(failure.message).toContain('AcpRemoteError')
    expect(failure.message).toContain('code=-32002')
    expect(failure.message).toContain('Resource not found')
    expect(failure.message).not.toContain(canary)
    expect(failure.message).not.toContain('/var/folders')
    expect(failure.message).not.toContain('must-not-appear')
    expect(failure.message).not.toContain('/private/adapter/data')
  })

  it('非阶段错误脱敏 canary 与 Unix/Windows 绝对路径', () => {
    const canary = 'synthetic-fs-canary'
    const unixError = new Error(`EACCES: permission denied, open '/tmp/rolecast-acp-resume-private/adapter/file' ${canary}`)
    const unixFailure = safeFailure(unixError, canary)
    expect(unixFailure.message).toContain('EACCES')
    expect(unixFailure.message).toContain('[redacted-path]')
    expect(unixFailure.message).not.toContain(canary)
    expect(unixFailure.message).not.toContain('/tmp/rolecast-acp-resume-private')

    const windowsPath = String.raw`C:\Users\rolecast\adapter\file`
    const windowsError = new Error(`EPERM: operation not permitted, open '${windowsPath}'`)
    const windowsFailure = safeFailure(windowsError, canary)
    expect(windowsFailure.message).toContain('[redacted-path]')
    expect(windowsFailure.message).not.toContain('C:')
    expect(windowsFailure.message).not.toContain('Users')

    const spacedError = new Error("EACCES: permission denied, open '/tmp/rolecast private/adapter file'")
    const spacedFailure = safeFailure(spacedError, canary)
    expect(spacedFailure.message).not.toContain('/tmp/rolecast')
    expect(spacedFailure.message).not.toContain('private/adapter')

    const uncPath = String.raw`\\server\share\rolecast\adapter\file`
    const uncError = new Error(`EACCES: permission denied, open '${uncPath}'`)
    const uncFailure = safeFailure(uncError, canary)
    expect(uncFailure.message).toContain('[redacted-path]')
    expect(uncFailure.message).not.toContain('server')
    expect(uncFailure.message).not.toContain('share')
  })

  it('runStage 为每个阶段提供可辨识标签', async () => {
    await expect(runStage('runtime-a-connect', async () => {
      throw new Error('connect failed')
    })).rejects.toMatchObject({ stage: 'runtime-a-connect' })
    await expect(runStage('fixture-setup', async () => {
      throw new Error('fixture failed')
    })).rejects.toMatchObject({ stage: 'fixture-setup' })
  })

  it('fixture setup 阶段诊断脱敏 canary 与绝对路径', () => {
    const canary = 'synthetic-setup-canary'
    const staged = new SmokeStageError('fixture-setup', new Error(`EACCES: mkdir '/tmp/rolecast-acp-resume-partial' ${canary}`))
    const failure = safeFailure(staged, canary)
    expect(failure.message).toContain('[fixture-setup]')
    expect(failure.message).toContain('[redacted-path]')
    expect(failure.message).not.toContain('/tmp/rolecast-acp-resume-partial')
    expect(failure.message).not.toContain(canary)
  })

  it('cleanup 扫描失败保留原失败与扫描原因，且不泄漏 canary 或绝对路径', async () => {
    const fixture = await createSmokeFixture('claude')
    const canary = 'synthetic-cleanup-canary'
    const outsideFile = join(fixture.roots.parentRoot, 'outside.txt')
    await writeFile(outsideFile, canary, { encoding: 'utf8', mode: 0o600 })
    await symlink(outsideFile, join(fixture.roots.adapterRoot, 'escape.txt'))

    try {
      const primary = new SmokeStageError('runtime-b-session-resume', new Error('resume failed'))
      const result = await cleanupSmokeFixture(fixture, primary)

      expect(result).not.toBeNull()
      expect(result?.message).toContain('[runtime-b-session-resume] resume failed')
      expect(result?.message).toContain('could not be scanned safely')
      expect(result?.message).toContain('canary scan refuses symlink: escape.txt')
      expect(result?.message).not.toContain(canary)
      expect(result?.message).not.toContain(fixture.roots.parentRoot)
    } finally {
      await rm(fixture.roots.parentRoot, { recursive: true, force: true })
    }
  })

  it('setup 清理失败时保留原错误并报告受控残留路径', async () => {
    const canary = 'synthetic-setup-residual-canary'
    const original = new Error(`mkdir failed '/tmp/rolecast-setup' ${canary}`)
    const residualPath = `/tmp/${canary}-residual`
    const failure = await cleanupSetupTree(original, residualPath, async () => {
      throw new Error('EBUSY')
    })

    expect(failure).toBeInstanceOf(SmokeResidualPathError)
    const diagnostic = safeFailure(new SmokeStageError('fixture-setup', failure), canary)
    expect(diagnostic.message).toContain('[fixture-setup]')
    expect(diagnostic.message).toContain('mkdir failed')
    expect(diagnostic.message).toContain('[redacted-path]')
    expect(diagnostic.message).toContain('[cleanup] private directory retained:')
    expect(diagnostic.message).toContain('/tmp/[redacted]-residual')
    expect(diagnostic.message).not.toContain(canary)
  })

  it('setup 清理成功时只保留原错误', async () => {
    const original = new Error('mkdir failed')
    const failure = await cleanupSetupTree(original, '/tmp/unused', async () => undefined)

    expect(failure).toBe(original)
    expect(failure).not.toBeInstanceOf(SmokeResidualPathError)
  })

  it('进程退出未确认时合并主错误并保留 parentRoot 路径', async () => {
    const fixture = await createSmokeFixture('claude')
    fixture.connectionStartupUnconfirmed = true

    try {
      const primary = new SmokeStageError('runtime-a-connect', new Error('connect failed'))
      const result = await cleanupSmokeFixture(fixture, primary)

      expect(result).not.toBeNull()
      expect(result?.message).toContain('[runtime-a-connect] connect failed')
      expect(result?.message).toContain('process exit was not confirmed')
      expect(result?.message).toContain(fixture.roots.parentRoot)
      expect(result?.message).not.toContain(fixture.secret)
      await expect(lstat(fixture.roots.parentRoot)).resolves.toBeTruthy()
    } finally {
      await rm(fixture.roots.parentRoot, { recursive: true, force: true })
    }
  })

  it('删除失败时合并主错误并报告残留 parentRoot', async () => {
    const fixture = await createSmokeFixture('claude')
    const primary = new SmokeStageError('runtime-b-session-resume', new Error('resume failed'))

    try {
      await chmod(fixture.roots.parentRoot, 0o500)
      const result = await cleanupSmokeFixture(fixture, primary)

      expect(result).not.toBeNull()
      expect(result?.message).toContain('[runtime-b-session-resume] resume failed')
      expect(result?.message).toContain('could not be removed')
      expect(result?.message).toContain(fixture.roots.parentRoot)
      expect(result?.message).not.toContain(fixture.secret)
      await expect(lstat(fixture.roots.parentRoot)).resolves.toBeTruthy()
    } finally {
      await chmod(fixture.roots.parentRoot, 0o700).catch(() => undefined)
      await rm(fixture.roots.parentRoot, { recursive: true, force: true })
    }
  })

  it('cleanup 遇到 filesystem 错误时脱敏 canary 与绝对路径', async () => {
    const fixture = await createSmokeFixture('claude')
    const canary = 'synthetic-fs-cleanup-canary'
    // 把 adapterRoot 变成普通文件：readdir 抛出带绝对路径的 ENOTDIR。
    await rm(fixture.roots.adapterRoot, { recursive: true, force: true })
    await writeFile(fixture.roots.adapterRoot, `not a directory ${canary}`, { encoding: 'utf8', mode: 0o600 })

    try {
      const primary = new SmokeStageError('runtime-b-session-resume', new Error('resume failed'))
      const result = await cleanupSmokeFixture(fixture, primary)

      expect(result).not.toBeNull()
      expect(result?.message).toContain('[runtime-b-session-resume] resume failed')
      expect(result?.message).toContain('could not be scanned safely')
      expect(result?.message).toContain('[redacted-path]')
      expect(result?.message).not.toContain(canary)
      expect(result?.message).not.toContain(fixture.roots.parentRoot)
    } finally {
      await rm(fixture.roots.parentRoot, { recursive: true, force: true })
    }
  })
})

describe('Claude 零轮 Session 负向诊断', () => {
  zeroTurnTest('Claude 新 Adapter 重挂接零轮 Session，不发送 prompt', () => runSessionResumeSmoke('claude'), 180_000)
})

async function runSessionResumeSmoke(provider: AcpProvider): Promise<void> {
  let fixture: ResumeSmokeFixture | null = null
  let failure: Error | null = null
  try {
    if (!sandboxCommand().available) {
      throw new SmokeStageError('fixture-setup', new Error('RUN_ACP_SESSION_RESUME_SMOKE 已启用，但 sandbox-exec 不可用'))
    }
    fixture = await runStage('fixture-setup', () => createSmokeFixture(provider))
    const sessionId = await createInitialSession(fixture)
    await resumeInFreshRuntime(fixture, sessionId)
  } catch (error: unknown) {
    if (fixture !== null && isProbeExitUnconfirmed(error)) {
      fixture.probeExitUnconfirmed = true
    }
    // setup 失败时可能尚未生成 secret：仍执行路径脱敏，canary 为空时不替换。
    failure = safeFailure(error, fixture?.secret ?? '')
    // Claude 失败时附加 A 退出后、B connect 前的 transcript 元数据证据。
    failure = attachTranscriptEvidence(failure, fixture?.transcriptEvidence ?? null)
  }
  if (fixture === null) {
    if (failure !== null) {
      throw failure
    }
    return
  }
  const finalFailure = await cleanupSmokeFixture(fixture, failure)
  if (finalFailure !== null) {
    throw finalFailure
  }
}

async function createSmokeFixture(provider: AcpProvider): Promise<ResumeSmokeFixture> {
  const roots = await createSandboxRoots()
  try {
    const secret = `synthetic-${randomUUID()}`
    const credentialRef = `credential-smoke-${randomUUID()}`
    const credentials = new InMemoryCredentialStore(credentialRef, secret)
    const environment = buildProbeEnvironment(roots.adapterRoot, { TMPDIR: roots.temporaryDirectory })
    if (Object.keys(environment).some(isSensitiveEnvironmentKey)) {
      throw new Error('sandbox environment contains an inherited sensitive variable')
    }
    return {
      roots,
      secret,
      credentialRef,
      credentials,
      runtimeA: new AcpAgentRuntime(credentials),
      runtimeB: new AcpAgentRuntime(credentials),
      environment,
      input: runtimeInput(provider, roots, credentialRef, environment),
      connectionA: null,
      connectionB: null,
      connectionAStopped: true,
      connectionACloseFailed: false,
      connectionStartupUnconfirmed: false,
      probeExitUnconfirmed: false,
      transcriptEvidence: null,
    }
  } catch (error: unknown) {
    // 尚未启动任何 Adapter：回收失败时仍保留原始错误并报告残留路径。
    throw await cleanupSetupTree(error, roots.parentRoot)
  }
}

/**
 * 回收 setup 阶段部分创建的私有树。
 *
 * 回收成功时保留原始失败；回收失败时返回同时携带原失败与残留路径的错误。
 * 残留路径是原方案要求的运维例外，输出前仍做 canary redaction。
 */
async function cleanupSetupTree(
  reason: unknown,
  path: string,
  remove: (target: string) => Promise<void> = (target) => rm(target, { recursive: true, force: true }),
): Promise<Error> {
  const original = toError(reason)
  try {
    await remove(path)
    return original
  } catch {
    return new SmokeResidualPathError(original, path)
  }
}

async function createInitialSession(fixture: ResumeSmokeFixture): Promise<string> {
  const { roots, runtimeA, input, environment } = fixture
  await runStage('sandbox-preflight', async () => {
    await verifyStrictSandbox(roots.profilePath, roots.adapterRoot, roots.controlRoot, environment)
    await verifyRuntimePathsBeforeConnect(fixture)
  })
  try {
    fixture.connectionA = await runStage('runtime-a-connect', () => runtimeA.connect(input))
  } catch (error: unknown) {
    fixture.connectionStartupUnconfirmed = true
    throw error
  }
  fixture.connectionAStopped = false
  const connection = fixture.connectionA
  if (connection === null) {
    throw new SmokeStageError('runtime-a-connect', new Error('Runtime A returned no connection'))
  }
  const session = await runStage('runtime-a-session-new', async () => {
    const created = await runtimeA.createSession(connection, roots.cwd)
    assertNoCanary({ capabilities: connection.capabilities, session: created }, fixture.secret, 'Runtime A result')
    return created
  })
  try {
    await runStage('runtime-a-close', () => runtimeA.closeConnection(connection.connectionId))
    fixture.connectionA = null
    fixture.connectionAStopped = true
  } catch (error: unknown) {
    fixture.connectionACloseFailed = true
    throw error
  }
  return session.sessionId
}

async function resumeInFreshRuntime(fixture: ResumeSmokeFixture, sessionId: string): Promise<void> {
  const { roots, runtimeB, input, environment } = fixture
  await runStage('sandbox-preflight', async () => {
    await verifyStrictSandbox(roots.profilePath, roots.adapterRoot, roots.controlRoot, environment)
    // Adapter A 已在同一私有树中运行过：连接 B 前必须重新确认路径没有被替换为 symlink。
    await verifyRuntimePathsBeforeConnect(fixture)
  })
  // A 已确认退出、B 尚未连接：仅收集 transcript 元数据用于失败归因（不读内容）。
  if (fixture.input.providerKind === 'claude') {
    fixture.transcriptEvidence = await describeClaudeTranscript(roots.adapterRoot, sessionId, fixture.secret)
  }
  try {
    fixture.connectionB = await runStage('runtime-b-connect', () => runtimeB.connect(input))
  } catch (error: unknown) {
    fixture.connectionStartupUnconfirmed = true
    throw error
  }
  const connection = fixture.connectionB
  if (connection === null) {
    throw new SmokeStageError('runtime-b-connect', new Error('Runtime B returned no connection'))
  }
  await runStage('runtime-b-session-resume', async () => {
    const session = await runtimeB.resumeSession(connection, sessionId, roots.cwd)
    expect(session.sessionId).toBe(sessionId)
    assertNoCanary({ capabilities: connection.capabilities, session }, fixture.secret, 'Runtime B result')
    expect(fixture.credentials.reads).toEqual([fixture.credentialRef, fixture.credentialRef])
    if (fixture.input.providerKind === 'codex') {
      const config = await readFile(join(roots.runtimeDirectory, 'config.toml'), 'utf8')
      assertNoCanary(config, fixture.secret, 'Codex runtime config')
    }
  })
}

/** Runtime.connect 前的第二次路径检查：覆盖 A 运行后可能被污染的 cwd/runtime/config。 */
async function verifyRuntimePathsBeforeConnect(fixture: ResumeSmokeFixture): Promise<void> {
  await verifyRuntimePaths({
    adapterRoot: fixture.roots.adapterRoot,
    cwd: fixture.roots.cwd,
    runtimeDirectory: fixture.roots.runtimeDirectory,
    environment: fixture.environment,
  })
}

async function cleanupSmokeFixture(
  fixture: ResumeSmokeFixture,
  failure: Error | null,
): Promise<Error | null> {
  let processesStopped = true
  if (fixture.connectionA !== null) {
    const stopped = await closeConnectionSafely(fixture.runtimeA, fixture.connectionA)
    processesStopped = processesStopped && stopped
    fixture.connectionAStopped = stopped && !fixture.connectionACloseFailed
  }
  if (fixture.connectionB !== null) {
    processesStopped = processesStopped && await closeConnectionSafely(fixture.runtimeB, fixture.connectionB)
  }
  processesStopped = processesStopped
    && fixture.connectionAStopped
    && !fixture.connectionStartupUnconfirmed
    && !fixture.probeExitUnconfirmed
  if (!processesStopped) {
    // 原方案要求保留目录并报告受控 parentRoot，便于人工安全清理；parentRoot 不含 canary。
    return combineFailures(failure, new Error(`[cleanup] Adapter or sandbox probe process exit was not confirmed; private directory retained: ${redactCanary(fixture.roots.parentRoot, fixture.secret)}`))
  }
  let cleanupFailure: Error | null = null
  try {
    const matches = await scanPrivateRootForCanary(fixture.roots.adapterRoot, fixture.secret)
    if (matches.length > 0) {
      cleanupFailure = new Error('[cleanup] synthetic credential canary found in Adapter-writable files')
    }
  } catch (error: unknown) {
    // 保留原失败；扫描原因只保留经 canary redaction 的 message（symlink 为相对路径）。
    cleanupFailure = new Error(`[cleanup] Adapter-writable files could not be scanned safely: ${sanitizeDiagnosticText(toError(error).message, fixture.secret)}`)
  }
  try {
    await rm(fixture.roots.parentRoot, { recursive: true, force: true })
  } catch {
    return combineFailures(failure, new Error(`[cleanup] smoke temporary directory could not be removed: ${redactCanary(fixture.roots.parentRoot, fixture.secret)}`))
  }
  return combineFailures(failure, cleanupFailure)
}

/** 阶段包装后仍需识别 probe 退出未确认，避免误删临时目录。 */
function isProbeExitUnconfirmed(error: unknown): boolean {
  let current: unknown = error
  while (current instanceof SmokeStageError) {
    current = current.reason
  }
  return current instanceof SandboxProbeExitUnconfirmedError
}

/** 保留主失败与 cleanup 失败两者，不互相覆盖。 */
function combineFailures(primary: Error | null, cleanup: Error | null): Error | null {
  if (primary === null) {
    return cleanup
  }
  if (cleanup === null) {
    return primary
  }
  return new Error(`${primary.message}; ${cleanup.message}`)
}

async function createSandboxRoots(): Promise<{
  parentRoot: string
  adapterRoot: string
  controlRoot: string
  cwd: string
  runtimeDirectory: string
  temporaryDirectory: string
  profilePath: string
}> {
  const createdRoot = await mkdtemp(join(tmpdir(), 'rolecast-acp-resume-'))
  try {
    const parentRoot = await realpath(createdRoot)
    await chmod(parentRoot, 0o700)
    const adapterRoot = join(parentRoot, 'adapter')
    const controlRoot = join(parentRoot, 'control')
    const cwd = join(adapterRoot, 'work')
    const runtimeDirectory = join(adapterRoot, 'provider-config')
    const temporaryDirectory = join(adapterRoot, 'tmp')
    await mkdir(adapterRoot, { mode: 0o700 })
    await mkdir(controlRoot, { mode: 0o700 })
    await Promise.all([
      mkdir(cwd, { mode: 0o700 }),
      mkdir(runtimeDirectory, { mode: 0o700 }),
      mkdir(temporaryDirectory, { mode: 0o700 }),
    ])
    await Promise.all([
      assertPrivateDirectory(parentRoot, adapterRoot),
      assertPrivateDirectory(parentRoot, controlRoot),
      assertPrivateDirectory(adapterRoot, cwd),
      assertPrivateDirectory(adapterRoot, runtimeDirectory),
      assertPrivateDirectory(adapterRoot, temporaryDirectory),
    ])
    const profilePath = await writeStrictSandboxProfile(parentRoot, adapterRoot, controlRoot)
    return { parentRoot, adapterRoot, controlRoot, cwd, runtimeDirectory, temporaryDirectory, profilePath }
  } catch (error: unknown) {
    // setup 阶段尚未启动 Adapter：部分创建的私有树可以安全回收。
    throw await cleanupSetupTree(error, createdRoot)
  }
}

async function assertPrivateDirectory(root: string, path: string): Promise<void> {
  const fileInfo = await lstat(path)
  if (fileInfo.isSymbolicLink() || !fileInfo.isDirectory()) {
    throw new Error('smoke path must be a private real directory')
  }
  const canonical = await realpath(path)
  const relativePath = relative(root, canonical)
  if (
    canonical !== resolve(path)
    || (relativePath !== '' && (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)))
  ) {
    throw new Error('smoke path escapes its private root')
  }
}

function runtimeInput(
  provider: AcpProvider,
  roots: Awaited<ReturnType<typeof createSandboxRoots>>,
  credentialRef: string,
  environment: NodeJS.ProcessEnv,
): AgentRuntimeConnectionInput {
  const adapter = resolveAdapterCommand(provider, undefined)
  const wrapped = sandboxedCommand(roots.profilePath, adapter.command, adapter.args)
  return {
    providerKind: provider,
    adapterCommand: wrapped.command,
    adapterArgs: wrapped.args,
    cwd: roots.cwd,
    env: environment,
    adapterVersion: provider === 'claude' ? '0.90.0' : '2.2.2',
    environmentMode: 'isolated',
    connectionKind: 'api_key',
    runtimeDirectory: roots.runtimeDirectory,
    credentialRef,
    credentialEnvironmentKey: provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY',
    ...(provider === 'codex'
      ? { importedConfig: { confirmed: true, model: 'rolecast-session-resume-smoke' } }
      : {}),
  }
}

async function closeConnectionSafely(runtime: AcpAgentRuntime, connection: RuntimeConnection): Promise<boolean> {
  try {
    await runtime.closeConnection(connection.connectionId)
    return true
  } catch {
    return false
  }
}

async function scanPrivateRootForCanary(root: string, canary: string): Promise<string[]> {
  const matches: string[] = []
  await scanDirectory(root, root, canary, matches)
  return matches
}

async function scanDirectory(
  root: string,
  directory: string,
  canary: string,
  matches: string[],
): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const relativePath = relative(root, path)
    const fileInfo = await lstat(path)
    if (fileInfo.isSymbolicLink()) {
      const safePath = relativePath.split(canary).join('[redacted]')
      throw new Error(`canary scan refuses symlink: ${safePath}`)
    }
    if (fileInfo.isDirectory()) {
      await scanDirectory(root, path, canary, matches)
    } else if (fileInfo.isFile()) {
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try {
        if (!(await handle.stat()).isFile()) {
          throw new Error('canary scan encountered a non-regular file')
        }
        if ((await handle.readFile('utf8')).includes(canary)) {
          matches.push(relativePath)
        }
      } catch {
        throw new Error('canary scan could not safely read a private file')
      } finally {
        await handle.close()
      }
    } else {
      throw new Error('canary scan encountered an unsupported file type')
    }
  }
}

function assertNoCanary(value: unknown, canary: string, label: string): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  if (serialized?.includes(canary)) {
    throw new Error(`${label} contains synthetic credential data`)
  }
}

function safeFailure(error: unknown, canary: string): Error {
  const stage = error instanceof SmokeStageError ? error : null
  const unwrapped: unknown = stage === null ? error : stage.reason
  const residual = unwrapped instanceof SmokeResidualPathError ? unwrapped : null
  const reason = toError(residual === null ? unwrapped : residual.reason)

  const base = stage === null
    ? sanitizeDiagnosticText(reason.message, canary)
    : `[${stage.stage}] ${describeStageReason(reason, canary)}`
  const message = base.length === 0 ? 'Adapter session resume smoke failed' : base
  if (residual === null) {
    return new Error(message)
  }
  // 残留目录路径是原方案要求的运维例外；仍确保 canary 不出现。
  return new Error(`${message}; [cleanup] private directory retained: ${redactCanary(residual.residualPath, canary)}`)
}

/**
 * 只保留稳定的 name / code 与脱敏后的 message。
 *
 * 绝不输出 error.data、stack、原始 stderr 或绝对目录路径。
 */
function describeStageReason(error: Error, canary: string): string {
  const label = safeDiagnosticLabel(error.name, canary)
  const code = safeDiagnosticCode(error, canary)
  const message = sanitizeDiagnosticText(error.message, canary)
  return `${label}${code === null ? '' : ` code=${code}`}: ${message}`
}

function safeDiagnosticLabel(name: string, canary: string): string {
  const safe = redactCanary(name, canary).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64)
  return safe.length === 0 ? 'Error' : safe
}

function safeDiagnosticCode(error: Error, canary: string): string | null {
  if (!('code' in error)) {
    return null
  }
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'number' && typeof code !== 'string') {
    return null
  }
  return sanitizeDiagnosticText(String(code), canary).slice(0, 64)
}
