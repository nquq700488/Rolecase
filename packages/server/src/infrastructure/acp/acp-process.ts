import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'

/** ACP Adapter 子进程启动参数。 */
export interface AcpProcessOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  terminationGraceMs?: number
}

/** ACP Adapter 子进程退出结果。 */
export interface AcpProcessExit {
  code: number | null
  signal: NodeJS.Signals | null
}

/**
 * 管理单个 ACP Adapter 子进程及其 stdio。
 *
 * 进程使用独立进程组启动，关闭时先温和终止，超时后终止整个进程组。
 */
export class AcpProcess {
  readonly pid: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  readonly exited: Promise<AcpProcessExit>

  private readonly child: ChildProcessWithoutNullStreams
  private readonly terminationGraceMs: number
  private closePromise: Promise<void> | null = null

  private constructor(child: ChildProcessWithoutNullStreams, options: AcpProcessOptions) {
    if (child.pid === undefined) {
      throw new Error('ACP Adapter process did not expose a pid')
    }

    this.child = child
    this.pid = child.pid
    this.stdin = child.stdin
    this.stdout = child.stdout
    this.stderr = child.stderr
    // stderr 不进入 ACP 协议或日志，但必须持续消费，避免子进程阻塞在 pipe。
    this.stderr.resume()
    this.terminationGraceMs = options.terminationGraceMs ?? 2_000
    this.exited = new Promise<AcpProcessExit>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
  }

  /** 启动 ACP Adapter 子进程。 */
  static async start(options: AcpProcessOptions): Promise<AcpProcess> {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stderr.resume()

    await new Promise<void>((resolve, reject) => {
      const handleSpawn = (): void => {
        child.off('error', handleError)
        resolve()
      }
      const handleError = (error: Error): void => {
        child.off('spawn', handleSpawn)
        reject(error)
      }
      child.once('spawn', handleSpawn)
      child.once('error', handleError)
    })

    return new AcpProcess(child, options)
  }

  /** 终止子进程及其子进程组；重复调用是幂等的。 */
  async close(): Promise<void> {
    if (this.closePromise !== null) {
      return this.closePromise
    }

    this.closePromise = this.closeInternal()
    return this.closePromise
  }

  private async closeInternal(): Promise<void> {
    const alreadyExited = this.hasExited()
    this.sendSignal('SIGTERM', true)

    if (!alreadyExited) {
      const graceTimer = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), this.terminationGraceMs)
      })
      const result = await Promise.race([this.exited.then(() => 'exited' as const), graceTimer])
      if (result === 'timeout' || result === 'exited') {
        this.sendSignal('SIGKILL', true)
      }
    } else {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      this.sendSignal('SIGKILL', true)
    }

    if (!this.hasExited()) {
      await this.exited
    }
  }

  private hasExited(): boolean {
    return this.child.exitCode !== null || this.child.signalCode !== null
  }

  private sendSignal(signal: NodeJS.Signals, force = false): void {
    if (!force && this.hasExited()) {
      return
    }

    if (process.platform !== 'win32' && this.pid > 0) {
      try {
        process.kill(-this.pid, signal)
        return
      } catch (error: unknown) {
        if (!(error instanceof Error) || !('code' in error) || (error.code !== 'ESRCH' && error.code !== 'EPERM')) {
          throw error
        }
      }
    }

    if (!this.hasExited()) {
      this.child.kill(signal)
    }
  }
}
