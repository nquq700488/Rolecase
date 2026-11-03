import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { lstat, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'


/** macOS sandbox-exec 的 loopback-only 出口策略文件名。 */
export const SANDBOX_PROFILE_NAME = 'loopback-only.sb'

const STRICT_SANDBOX_PROFILE_NAME = 'session-resume-strict.sb'
const SANDBOX_PROBE_TIMEOUT_MS = 8_000
const SANDBOX_PROBE_KILL_GRACE_MS = 2_000
const SANDBOX_PROBE_SCRIPT = [
  'const net = require("node:net")',
  'const fs = require("node:fs")',
  'const mode = process.argv[1]',
  'if (mode === "connect") {',
  '  const socket = net.connect({ host: process.argv[2], port: Number(process.argv[3]), timeout: 1500 })',
  '  socket.once("connect", () => { process.stdout.write("OK"); socket.destroy() })',
  '  socket.once("error", (error) => { process.stdout.write(`ERROR:${error.code ?? "UNKNOWN"}`) })',
  '  socket.once("timeout", () => { process.stdout.write("TIMEOUT"); socket.destroy() })',
  '} else {',
  '  try { fs.writeFileSync(process.argv[2], "probe", { flag: "wx" }); process.stdout.write("OK") }',
  '  catch (error) { process.stdout.write(`ERROR:${error.code ?? "UNKNOWN"}`) }',
  '}',
].join('\n')

/**
 * 默认拒绝所有网络，仅放行 loopback 出站连接。
 *
 * `(allow default)` 保留文件/进程能力，网络单独收紧。策略会继承到 Adapter 子进程。
 */
const LOOPBACK_ONLY_PROFILE = `(version 1)
(allow default)
(deny network*)
(allow network-outbound (remote ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
`

/**
 * 子进程环境的最小 allowlist。
 *
 * 只保留进程启动与临时目录所需的非敏感键。认证相关键（ANTHROPIC_* / OPENAI_* / CLAUDE_* / CODEX_*，
 * 含大小写变体）和代理键（HTTP_PROXY / HTTPS_PROXY / ALL_PROXY 等）一律不继承。
 */
const BASE_ENV_ALLOWLIST = ['PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'] as const

/** 会被显式剔除的敏感变量模式（大小写不敏感）。 */
const SENSITIVE_ENV_PATTERN = /^(?:.*(?:api_?key|auth_?token|oauth|access_?token|secret|password).*|(?:anthropic|openai|claude|codex|azure|aws|bedrock|vertex|gemini|google)_?.*|(?:https?|all|no|socks)_?proxy|node_options)$/i

/** sandbox-exec 启动命令。 */
export interface SandboxedCommand {
  command: string
  args: string[]
}

/**
 * sandbox probe 进程退出无法确认。
 *
 * 调用方必须保留临时目录，不能扫描或删除可能仍被该进程占用的树。
 */
export class SandboxProbeExitUnconfirmedError extends Error {
  readonly code = 'SANDBOX_PROBE_EXIT_UNCONFIRMED'

  constructor() {
    super('sandbox preflight helper exit was not confirmed')
    this.name = 'SandboxProbeExitUnconfirmedError'
  }
}

/**
 * @name writeLoopbackOnlyProfile
 * @description 在指定临时目录写入 loopback-only sandbox profile
 * @param {string} directory 0700 临时目录
 * @return {Promise<string>} profile 绝对路径
 * @example const profile = await writeLoopbackOnlyProfile('/tmp/rolecast-probe-xxx')
 */
export async function writeLoopbackOnlyProfile(directory: string): Promise<string> {
  const path = join(directory, SANDBOX_PROFILE_NAME)
  await writeFile(path, LOOPBACK_ONLY_PROFILE, { encoding: 'utf8', mode: 0o600 })
  return path
}

/**
 * @name writeStrictSandboxProfile
 * @description 写入限制网络和文件写入范围的 Adapter 测试 profile
 * @param {string} parentRoot 私有临时父目录的规范绝对路径
 * @param {string} adapterRoot Adapter 唯一可写子目录
 * @param {string} controlRoot profile 与控制侧临时项所在的只读子目录
 * @return {Promise<string>} profile 绝对路径
 * @example const profile = await writeStrictSandboxProfile(root, adapterRoot, controlRoot)
 */
export async function writeStrictSandboxProfile(
  parentRoot: string,
  adapterRoot: string,
  controlRoot: string,
): Promise<string> {
  const layout = await validateSandboxLayout(parentRoot, adapterRoot, controlRoot)
  const profilePath = join(layout.controlRoot, STRICT_SANDBOX_PROFILE_NAME)
  const profile = `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))\n(deny file-write*)\n(allow file-write* (subpath "${escapeSbplPath(layout.adapterRoot)}"))\n`
  await writeFile(profilePath, profile, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return profilePath
}

/**
 * @name writeLiveSandboxProfile
 * @description 写入只允许连接固定 loopback broker 端口的 live smoke profile
 * @param {string} parentRoot 私有临时父目录的规范绝对路径
 * @param {string} adapterRoot Adapter 唯一可写子目录
 * @param {string} controlRoot profile 与控制侧临时项所在的只读子目录
 * @param {number} brokerPort 控制侧 CONNECT broker 的固定 loopback 端口
 * @return {Promise<string>} profile 绝对路径
 * @example await writeLiveSandboxProfile(root, adapterRoot, controlRoot, broker.port)
 */
export async function writeLiveSandboxProfile(
  parentRoot: string,
  adapterRoot: string,
  controlRoot: string,
  brokerPort: number,
): Promise<string> {
  assertValidBrokerPort(brokerPort)
  const layout = await validateSandboxLayout(parentRoot, adapterRoot, controlRoot)
  const profilePath = join(layout.controlRoot, 'session-resume-live.sb')
  // Adapter 只能连接本轮固定 broker 端口；direct egress 与其他 loopback 端口仍被拒绝。
  const profile = `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:${String(brokerPort)}"))\n(deny file-write*)\n(allow file-write* (subpath "${escapeSbplPath(layout.adapterRoot)}"))\n`
  await writeFile(profilePath, profile, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  return profilePath
}

function assertValidBrokerPort(brokerPort: number): void {
  if (!Number.isInteger(brokerPort) || brokerPort <= 0 || brokerPort > 65_535) {
    throw new Error('broker port must be a valid TCP port')
  }
}

/**
 * @name sandboxCommand
 * @description 判断当前平台是否支持本项目已验证的 sandbox-exec 探针
 * @return {{ available: boolean; reason: string }} 平台可用性；不代表具体 profile 已验证
 * @example sandboxCommand() // { available: true, reason: 'darwin sandbox-exec' }
 */
export function sandboxCommand(): { available: boolean; reason: string } {
  if (process.platform !== 'darwin') {
    return {
      available: false,
      reason: `loopback-only 隔离只在 darwin sandbox-exec 上验证过，当前平台是 ${process.platform}`,
    }
  }
  return { available: true, reason: 'darwin sandbox-exec' }
}

/**
 * @name sandboxedCommand
 * @description 将目标命令包在指定 sandbox-exec profile 中
 * @param {string} profilePath 规范化的 profile 绝对路径
 * @param {string} command 目标命令绝对路径
 * @param {readonly string[]} args 目标命令参数
 * @return {SandboxedCommand} 可直接传给 spawn 的命令和参数
 * @example sandboxedCommand('/tmp/control/strict.sb', '/usr/bin/node', ['--version'])
 */
export function sandboxedCommand(
  profilePath: string,
  command: string,
  args: readonly string[],
): SandboxedCommand {
  if (!isAbsolute(profilePath) || !isAbsolute(command)) {
    throw new Error('sandbox 命令和 profile 必须使用绝对路径')
  }
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-f', profilePath, command, ...args],
  }
}

/** sandbox probe 运行函数；测试可注入替身，避免启动真实 Adapter。 */
export type SandboxProbeRunner = (
  profilePath: string,
  adapterRoot: string,
  environment: NodeJS.ProcessEnv,
  probeArgs: readonly string[],
) => Promise<string>

/**
 * @name removeAfterConfirmedProbeExit
 * @description 仅在 probe 进程退出已确认时清理其可能仍在使用的路径。
 * @param {readonly string[]} paths 待清理的文件或目录
 * @param {boolean} exitUnconfirmed exit / stdout close 是否未确认
 * @return {Promise<void>} 清理完成，或按 fail-closed 跳过
 * @example await removeAfterConfirmedProbeExit([probePath], false)
 */
export async function removeAfterConfirmedProbeExit(
  paths: readonly string[],
  exitUnconfirmed: boolean,
): Promise<void> {
  if (exitUnconfirmed) {
    return
  }
  await Promise.all(paths.map((path) => rm(path, { recursive: true, force: true })))
}

/**
 * @name verifyStrictSandbox
 * @description 在 Adapter 启动前验证指定 profile 的网络和文件写入边界
 * @param {string} profilePath controlRoot 内的严格 profile
 * @param {string} adapterRoot Adapter 唯一可写根目录
 * @param {string} controlRoot Adapter 不可写的控制目录
 * @param {NodeJS.ProcessEnv} environment 由 allowlist 生成且 HOME / TMPDIR 位于 adapterRoot 的环境
 * @param {SandboxProbeRunner} runProbe probe 运行函数；测试可注入替身
 * @return {Promise<void>} 所有隔离断言通过时完成
 * @example await verifyStrictSandbox(profile, adapterRoot, controlRoot, environment)
 */
export async function verifyStrictSandbox(
  profilePath: string,
  adapterRoot: string,
  controlRoot: string,
  environment: NodeJS.ProcessEnv,
  runProbe: SandboxProbeRunner = runSandboxProbe,
): Promise<void> {
  const sandbox = sandboxCommand()
  if (!sandbox.available) {
    throw new Error('严格 sandbox 在当前平台不可用')
  }
  await validateProfileForPreflight(profilePath, adapterRoot, controlRoot, environment)
  const listener = createServer()
  const address = await listenLoopback(listener)
  const privateProbePath = join(adapterRoot, `.sandbox-private-${randomUUID()}`)
  const protectedProbePath = join(controlRoot, `.sandbox-protected-${randomUUID()}`)

  let exitUnconfirmed = false
  try {
    const localResult = await runProbe(profilePath, adapterRoot, environment, ['connect', '127.0.0.1', String(address.port)])
    if (localResult !== 'OK') {
      throw new Error('sandbox loopback preflight failed')
    }
    const externalResult = await runProbe(profilePath, adapterRoot, environment, ['connect', '192.0.2.1', '80'])
    if (externalResult !== 'ERROR:EPERM') {
      throw new Error('sandbox non-loopback egress was not denied with EPERM')
    }
    const privateWriteResult = await runProbe(profilePath, adapterRoot, environment, ['write', privateProbePath])
    if (privateWriteResult !== 'OK') {
      throw new Error('sandbox rejected a private-root write')
    }
    const protectedWriteResult = await runProbe(profilePath, adapterRoot, environment, ['write', protectedProbePath])
    if (protectedWriteResult !== 'ERROR:EPERM') {
      throw new Error('sandbox did not deny a protected sibling write with EPERM')
    }
  } catch (error: unknown) {
    // 未确认退出时 probe 进程可能仍在使用这些路径；调用方也不得删除父目录。
    exitUnconfirmed = error instanceof SandboxProbeExitUnconfirmedError
    throw error
  } finally {
    // listener 不依赖 probe 子进程，始终关闭；文件只在退出确认后清理。
    await closeServer(listener)
    await removeAfterConfirmedProbeExit([privateProbePath, protectedProbePath], exitUnconfirmed)
  }
}

/**
 * @name buildProbeEnvironment
 * @description 构造不含真实凭据与代理的最小 Adapter 子进程环境
 * @param {string} workDirectory 该用例的私有工作目录（同时作为 HOME）
 * @param {Readonly<Record<string, string>>} synthetic 该用例显式提供的非继承覆盖项
 * @return {NodeJS.ProcessEnv} 最小环境
 * @example
 * buildProbeEnvironment('/tmp/probe', { ANTHROPIC_API_KEY: 'synthetic-xxx' })
 */
export function buildProbeEnvironment(
  workDirectory: string,
  synthetic: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of BASE_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (value !== undefined) {
      environment[key] = value
    }
  }
  // HOME 指向临时目录：Adapter 既不会读到用户真实配置，也不会写入用户主目录。
  environment.HOME = workDirectory
  return { ...environment, ...synthetic }
}

/**
 * @name isSensitiveEnvironmentKey
 * @description 判断变量名是否属于敏感类（供回归测试验证 allowlist 不泄漏）
 * @param {string} key 变量名
 * @return {boolean} 是否属于敏感类
 * @example isSensitiveEnvironmentKey('HTTPS_PROXY') // true
 */
export function isSensitiveEnvironmentKey(key: string): boolean {
  return SENSITIVE_ENV_PATTERN.test(key)
}

async function validateSandboxLayout(
  parentRoot: string,
  adapterRoot: string,
  controlRoot: string,
): Promise<{ parentRoot: string; adapterRoot: string; controlRoot: string }> {
  const canonicalParent = await requireCanonicalDirectory(parentRoot)
  const canonicalAdapter = await requireCanonicalDirectory(adapterRoot)
  const canonicalControl = await requireCanonicalDirectory(controlRoot)
  if (
    canonicalParent !== resolve(parentRoot)
    || canonicalAdapter !== resolve(adapterRoot)
    || canonicalControl !== resolve(controlRoot)
    || dirname(canonicalAdapter) !== canonicalParent
    || dirname(canonicalControl) !== canonicalParent
    || canonicalAdapter === canonicalControl
  ) {
    throw new Error('sandbox 目录不能包含 symlink，且 adapter/control 必须是同一临时父目录的子目录')
  }
  return {
    parentRoot: canonicalParent,
    adapterRoot: canonicalAdapter,
    controlRoot: canonicalControl,
  }
}

async function validateProfileForPreflight(
  profilePath: string,
  adapterRoot: string,
  controlRoot: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const layout = await validateSandboxLayout(dirname(adapterRoot), adapterRoot, controlRoot)
  const profileStat = await lstat(profilePath)
  const canonicalProfile = await realpath(profilePath)
  if (
    profileStat.isSymbolicLink()
    || !profileStat.isFile()
    || canonicalProfile !== resolve(profilePath)
    || dirname(canonicalProfile) !== layout.controlRoot
    || isPathWithin(layout.adapterRoot, canonicalProfile)
  ) {
    throw new Error('sandbox profile 必须是 controlRoot 中的普通文件')
  }
  await requireContainedDirectory(layout.adapterRoot, environment.HOME ?? '')
  await requireContainedDirectory(layout.adapterRoot, environment.TMPDIR ?? '')
  for (const key of Object.keys(environment)) {
    if (isSensitiveEnvironmentKey(key)) {
      throw new Error('sandbox preflight environment contains a sensitive variable')
    }
  }
}

/** Adapter 连接前需要重新校验的运行时路径。 */
export interface RuntimePathGuardInput {
  readonly adapterRoot: string
  readonly cwd: string
  readonly runtimeDirectory: string
  /** 必须是生成子进程环境的同一份对象（HOME / TMPDIR 从中读取）。 */
  readonly environment: NodeJS.ProcessEnv
}

/**
 * @name verifyRuntimePaths
 * @description 在 Runtime.connect / 凭据读取前重新校验 cwd、runtimeDirectory、
 * HOME、TMPDIR 与 Codex config.toml 目标：目录和已存在配置文件都不能是 symlink，
 * 且必须位于 adapterRoot 内。
 * @param {RuntimePathGuardInput} input 私有 adapterRoot、运行时路径和环境
 * @return {Promise<void>} 全部路径可信时完成；否则 fail-closed
 * @example
 * await verifyRuntimePaths({ adapterRoot, cwd, runtimeDirectory, environment })
 */
export async function verifyRuntimePaths(input: RuntimePathGuardInput): Promise<void> {
  const adapterRoot = await requireCanonicalDirectory(input.adapterRoot)
  if (adapterRoot !== resolve(input.adapterRoot)) {
    throw new Error('sandbox path must be a real directory')
  }
  await requireContainedDirectory(adapterRoot, input.cwd)
  await requireContainedDirectory(adapterRoot, input.runtimeDirectory)
  await requireContainedDirectory(adapterRoot, input.environment.HOME ?? '')
  await requireContainedDirectory(adapterRoot, input.environment.TMPDIR ?? '')

  // Adapter A 可能把 config.toml 替换为指向外部的 symlink；
  // 物化配置前的第二次检查必须拒绝，否则 writeFile 会跟随 symlink 越界写入。
  const configPath = join(input.runtimeDirectory, 'config.toml')
  const configStat = await lstatIfExists(configPath)
  if (configStat === null) {
    return
  }
  if (configStat.isSymbolicLink() || !configStat.isFile()) {
    throw new Error('runtime config target must be a regular file')
  }
  // 同卷硬链接不是 symlink，但 writeFile 会直接覆盖链接目标，必须拒绝。
  if (configStat.nlink !== 1) {
    throw new Error('runtime config target must not be hard linked')
  }
  const canonicalConfig = await realpath(configPath)
  if (
    canonicalConfig !== resolve(configPath)
    || dirname(canonicalConfig) !== resolve(input.runtimeDirectory)
    || !isPathWithin(input.runtimeDirectory, canonicalConfig)
  ) {
    throw new Error('runtime config target escapes runtimeDirectory')
  }
}

async function lstatIfExists(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path)
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) {
      return null
    }
    throw error
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code
}

async function requireCanonicalDirectory(path: string): Promise<string> {
  const fileStat = await lstat(path)
  if (fileStat.isSymbolicLink() || !fileStat.isDirectory()) {
    throw new Error('sandbox path must be a real directory')
  }
  return realpath(path)
}

async function requireContainedDirectory(root: string, path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new Error('sandbox environment path must be absolute')
  }
  const canonical = await requireCanonicalDirectory(path)
  if (canonical !== resolve(path) || !isPathWithin(root, canonical)) {
    throw new Error('sandbox environment path escapes adapterRoot')
  }
}

function isPathWithin(root: string, path: string): boolean {
  const relativePath = relative(root, path)
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`))
}

function escapeSbplPath(path: string): string {
  if (!isAbsolute(path) || /[\u0000\r\n]/.test(path)) {
    throw new Error('sandbox path cannot be represented safely')
  }
  return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

async function listenLoopback(server: Server): Promise<{ port: number }> {
  await new Promise<void>((resolveListen, reject) => {
    const handleError = (error: Error): void => {
      server.off('listening', handleListening)
      reject(error)
    }
    const handleListening = (): void => {
      server.off('error', handleError)
      resolveListen()
    }
    server.once('error', handleError)
    server.once('listening', handleListening)
    server.listen(0, '127.0.0.1')
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('sandbox loopback listener did not expose a TCP port')
  }
  return { port: address.port }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error === undefined ? resolveClose() : reject(error)))
  })
}

function runSandboxProbe(
  profilePath: string,
  adapterRoot: string,
  environment: NodeJS.ProcessEnv,
  probeArgs: readonly string[],
): Promise<string> {
  const sandboxed = sandboxedCommand(profilePath, process.execPath, ['-e', SANDBOX_PROBE_SCRIPT, ...probeArgs])
  const child = spawn(sandboxed.command, sandboxed.args, {
    cwd: adapterRoot,
    detached: process.platform !== 'win32',
    env: { ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return readSandboxProbeResult(child)
}

/**
 * 读取 probe 结果；超时或输出超限后必须确认进程退出与 stdout 关闭才 settle。
 *
 * @param child 已启动的 probe 子进程
 * @param options 测试可覆盖的超时与 kill 后等待窗口
 * @return {Promise<string>} stdout 输出
 */
export function readSandboxProbeResult(
  child: ReturnType<typeof spawn>,
  options: { timeoutMs?: number; killGraceMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? SANDBOX_PROBE_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? SANDBOX_PROBE_KILL_GRACE_MS
  return new Promise<string>((resolveResult, rejectResult) => {
    let output = ''
    let diagnostic = ''
    let exitCode: number | null = null
    let exited = false
    let closed = false
    let settled = false
    // 延迟构造失败信息：输出超限时报告 settle 时实际保留的 UTF-16 code units。
    let pendingFailure: (() => Error) | null = null
    let timeout: NodeJS.Timeout | undefined
    let killTimer: NodeJS.Timeout | undefined
    const settle = (action: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      if (killTimer !== undefined) {
        clearTimeout(killTimer)
      }
      action()
    }
    const requestKill = (failure: () => Error): void => {
      if (pendingFailure !== null) {
        return
      }
      pendingFailure = failure
      killProbeProcess(child)
      // exit 与 stdout close 未确认前不能 settle：调用方可能删除仍被占用的临时树。
      killTimer = setTimeout(() => {
        settle(() => rejectResult(new SandboxProbeExitUnconfirmedError()))
      }, killGraceMs)
    }
    timeout = setTimeout(() => {
      requestKill(() => new Error('sandbox preflight helper timed out'))
    }, timeoutMs)
    const finish = (): void => {
      if (!exited || !closed) {
        return
      }
      settle(() => {
        if (pendingFailure !== null) {
          rejectResult(pendingFailure())
          return
        }
        if (exitCode !== 0) {
          rejectResult(new Error(`sandbox preflight helper exited with ${String(exitCode)} (${diagnostic.slice(0, 240) || output || 'no result'})`))
          return
        }
        resolveResult(output)
      })
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      diagnostic = `${diagnostic}${chunk.toString('utf8')}`.slice(0, 512)
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      // 已请求 kill（超时 / 输出超限）：退出未确认前不再保留后续输出。
      if (pendingFailure !== null) {
        return
      }
      const next = `${output}${chunk.toString('utf8')}`
      if (next.length > 128) {
        // 只保留有限前缀用于诊断，缓冲不再随失控输出增长。
        output = next.slice(0, 128)
        requestKill(() => new Error(`sandbox preflight helper returned unexpected output (${String(output.length)} UTF-16 code units retained)`))
        return
      }
      output = next
    })
    child.stdout?.once('close', () => {
      closed = true
      finish()
    })
    child.once('error', () => {
      // 已发起 kill（超时 / 输出超限）时必须等到 exit / close 确认；
      // error 事件本身不构成退出证据。
      if (pendingFailure !== null) {
        return
      }
      settle(() => rejectResult(new Error('sandbox preflight helper failed to start')))
    })
    child.once('exit', (code) => {
      exitCode = code
      exited = true
      finish()
    })
  })
}

function killProbeProcess(child: ReturnType<typeof spawn>): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // sandbox-exec may have exited before the group kill; fall back to its direct child handle.
      child.kill('SIGKILL')
      return
    }
  }
  child.kill('SIGKILL')
}
