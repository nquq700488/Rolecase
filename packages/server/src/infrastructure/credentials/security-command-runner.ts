import { spawn } from 'node:child_process'

import { CredentialStoreUnavailableError, MAX_CREDENTIAL_BYTES } from '../../application/ports/credential-store-port.js'

const SECURITY_COMMAND = '/usr/bin/security'
const DEFAULT_COMMAND_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = MAX_CREDENTIAL_BYTES + 4_096

/** macOS security CLI 的无 TTY 命令结果。 */
export interface SecurityCommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

/** 可替换的 security 命令执行边界。 */
export interface SecurityCommandRunner {
  run(args: readonly string[], input?: string): Promise<SecurityCommandResult>
}

/** 测试或平台适配可调的 Runner 限制。 */
export interface SecurityCommandRunnerOptions {
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
}

/** 创建指定命令的无 TTY Runner；生产默认命令是 macOS security。 */
export function createSecurityCommandRunner(
  command = SECURITY_COMMAND,
  options: SecurityCommandRunnerOptions = {},
): SecurityCommandRunner {
  return {
    run: (args, input) => runCommand(command, args, input, options),
  }
}

/**
 * @name runSecurityCommand
 * @description 以无 TTY、有限输出和超时方式执行 macOS security 命令
 * @param {readonly string[]} args security 子命令参数，不能包含 Secret
 * @param {string | undefined} input 通过 stdin 传入的 Secret
 * @return {Promise<SecurityCommandResult>} 命令结果
 */
export function runSecurityCommand(
  args: readonly string[],
  input?: string,
): Promise<SecurityCommandResult> {
  return runCommand(SECURITY_COMMAND, args, input, {})
}

function runCommand(
  command: string,
  args: readonly string[],
  input: string | undefined,
  options: SecurityCommandRunnerOptions,
): Promise<SecurityCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  return new Promise<SecurityCommandResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let failure: Error | null = null
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      failure = new CredentialStoreUnavailableError()
      child.kill('SIGKILL')
    }, timeoutMs)

    const append = (target: Buffer[], chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > maxOutputBytes) {
        failure = new CredentialStoreUnavailableError()
        child.kill('SIGKILL')
        return
      }
      target.push(chunk)
    }

    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    child.stdin.on('error', () => {
      failure = new CredentialStoreUnavailableError()
      child.kill('SIGKILL')
    })
    child.once('error', () => {
      failure = new CredentialStoreUnavailableError()
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      reject(failure)
    })
    child.once('close', (exitCode: number | null) => {
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      if (failure !== null) {
        reject(failure)
        return
      }
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })

    // macOS security 的交互式密码写入会连续读取两次（输入 + 复核），
    // 因此同一 Secret 必须写成两行相同值，否则 security 会以「passwords don't match」失败。
    child.stdin.end(input === undefined ? undefined : `${input}\n${input}\n`)
  })
}
