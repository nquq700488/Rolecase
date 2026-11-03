import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { connect, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { AcpAgentRuntime, type CredentialStorePort } from '@rolecast/server'

import {
  SandboxProbeExitUnconfirmedError,
  buildProbeEnvironment,
  readSandboxProbeResult,
  removeAfterConfirmedProbeExit,
  sandboxCommand,
  sandboxedCommand,
  verifyRuntimePaths,
  verifyStrictSandbox,
  writeLiveSandboxProfile,
  writeLoopbackOnlyProfile,
  writeStrictSandboxProfile,
} from './sandbox.js'

// 默认跳过：只有显式 RUN_PROVIDER_ADAPTER_PROBE=1 才做出口隔离验证。
const probeEnabled = process.env.RUN_PROVIDER_ADAPTER_PROBE === '1'
const sandbox = sandboxCommand()

type ConnectResult = {
  readonly outcome: 'OK' | 'DENIED' | 'TIMEOUT' | 'ERROR'
  /** 明确错误码（如 sandbox 拒绝的 EPERM）；用于区分「被拒绝」与「不可达」。 */
  readonly errorCode: string
  readonly exitCode: number | null
}

/** 在沙箱内尝试 TCP 连接，返回结果与明确拒绝原因。 */
const probeConnect = async (profile: string, host: string, port: number): Promise<ConnectResult> => {
  const script = [
    "const net = require('node:net')",
    'const socket = net.connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 1500 })',
    "socket.on('connect', () => { process.stdout.write('OK'); socket.destroy() })",
    'socket.on(\'error\', (error) => process.stdout.write(`ERROR:${error.code ?? "UNKNOWN"}`))',
    "socket.on('timeout', () => { process.stdout.write('TIMEOUT'); socket.destroy() })",
  ].join(';')

  return new Promise<ConnectResult>((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, '-e', script, host, String(port)], {
      stdio: ['ignore', 'pipe', 'ignore'],
      // 不继承开发者环境：代理变量会让 loopback 连接改走本地代理。
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    })
    let output = ''
    let exitCode: number | null = null
    let exited = false
    let closed = false
    // 子进程的 stdout 数据可能在 exit 之后才到达；必须等 stdio 关闭再解析，
    // 否则会偶发把有输出的结果读成空字符串。
    const finish = (): void => {
      if (!exited || !closed) {
        return
      }
      if (output.startsWith('ERROR:')) {
        resolve({ outcome: 'ERROR', errorCode: output.slice('ERROR:'.length), exitCode })
        return
      }
      if (output === 'OK') {
        resolve({ outcome: 'OK', errorCode: '', exitCode })
        return
      }
      if (output === 'TIMEOUT') {
        resolve({ outcome: 'TIMEOUT', errorCode: '', exitCode })
        return
      }
      resolve({ outcome: 'DENIED', errorCode: '', exitCode })
    }

    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stdout.once('close', () => {
      closed = true
      finish()
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      exitCode = code
      exited = true
      finish()
    })
  })
}

describe.skipIf(!probeEnabled || !sandbox.available)('loopback-only 出口隔离门禁', () => {
  it('放行 loopback；非 loopback 必须由 sandbox 以 EPERM 明确拒绝', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-probe-sandbox-'))
    const profile = await writeLoopbackOnlyProfile(directory)
    const listener: Server = createServer()
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', () => resolve()))
    const address = listener.address()
    if (address === null || typeof address === 'string') {
      throw new Error('mock listener 未返回端口')
    }

    try {
      const loopback = await probeConnect(profile, '127.0.0.1', address.port)
      expect(loopback.outcome).toBe('OK')
      expect(loopback.exitCode).toBe(0)

      // 非 loopback 必须被 sandbox 以 EPERM 拒绝；「不可达 / 超时」不算隔离生效。
      const external = await probeConnect(profile, '192.0.2.1', 80)
      expect(external.outcome).toBe('ERROR')
      expect(external.errorCode).toBe('EPERM')
      expect(external.exitCode).toBe(0)
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('loopback 代理确实能转发非 loopback 请求，因此必须靠环境 allowlist 阻断', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rolecast-probe-proxy-'))
    let proxy: ProxyListener | null = null

    try {
      // 第一步：证明「loopback 代理 → 非 loopback」是一个真实可用通道。
      // sandbox 允许 loopback，所以单靠 sandbox 无法阻止这种转发。
      proxy = await startConnectProxy()
      await runProxyConnectRequest(proxy.url, '192.0.2.1', 80)
      await waitForProxyTarget(proxy, '192.0.2.1', 80)

      // 第二步：证明 Probe 的子进程环境移除代理变量——Adapter 拿不到这个通道。
      const environment = buildProbeEnvironment(directory, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' })
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        expect(environment[key]).toBeUndefined()
      }
    } finally {
      if (proxy !== null) {
        await proxy.close()
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)

  it('live Adapter profile 只放行 broker 端口，拒绝其他 loopback 和直连外网', async () => {
    const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-live-sandbox-probe-')))
    const adapterRoot = join(parentRoot, 'adapter')
    const controlRoot = join(parentRoot, 'control')
    await mkdir(adapterRoot, { mode: 0o700 })
    await mkdir(controlRoot, { mode: 0o700 })
    const brokerListener = createServer()
    const otherListener = createServer()

    try {
      await new Promise<void>((resolve) => brokerListener.listen(0, '127.0.0.1', resolve))
      await new Promise<void>((resolve) => otherListener.listen(0, '127.0.0.1', resolve))
      const brokerAddress = brokerListener.address()
      const otherAddress = otherListener.address()
      if (
        brokerAddress === null || typeof brokerAddress === 'string'
        || otherAddress === null || typeof otherAddress === 'string'
      ) {
        throw new Error('live sandbox probe listeners did not expose TCP ports')
      }
      const profile = await writeLiveSandboxProfile(
        parentRoot,
        adapterRoot,
        controlRoot,
        brokerAddress.port,
      )

      const broker = await probeConnect(profile, '127.0.0.1', brokerAddress.port)
      expect(broker).toEqual({ outcome: 'OK', errorCode: '', exitCode: 0 })

      const otherLoopback = await probeConnect(profile, '127.0.0.1', otherAddress.port)
      expect(otherLoopback).toEqual({ outcome: 'ERROR', errorCode: 'EPERM', exitCode: 0 })

      const directEgress = await probeConnect(profile, '192.0.2.1', 80)
      expect(directEgress).toEqual({ outcome: 'ERROR', errorCode: 'EPERM', exitCode: 0 })
    } finally {
      await Promise.all([
        new Promise<void>((resolve) => brokerListener.close(() => resolve())),
        new Promise<void>((resolve) => otherListener.close(() => resolve())),
      ])
      await rm(parentRoot, { recursive: true, force: true })
    }
  }, 60_000)
})

/** 只监听 loopback 的最小 CONNECT 转发代理。 */
interface ProxyListener {
  readonly url: string
  readonly connectTargets: readonly string[]
  close(): Promise<void>
}

/**
 * 启动一个会真正向目标建立上游连接的 CONNECT 代理。
 *
 * 用途：证明 loopback 代理是「sandbox 之外」的真实转发通道。
 */
async function startConnectProxy(): Promise<ProxyListener> {
  const targets: string[] = []
  const server = createServer((client) => {
    client.once('data', (chunk) => {
      const firstLine = chunk.toString('utf8').split('\r\n')[0] ?? ''
      const match = /^CONNECT ([^:]+):(\d+)/.exec(firstLine)
      if (match === null) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      targets.push(`${match[1]}:${match[2]}`)
      const upstream = connect({ host: match[1] ?? '', port: Number(match[2] ?? 0), timeout: 1500 })
      upstream.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('timeout', () => {
        client.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n')
        upstream.destroy()
      })
      upstream.on('error', () => client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('proxy listener 未返回端口')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    get connectTargets() {
      return targets
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

/**
 * 用显式 CONNECT 的客户端对代理发起请求。
 *
 * 这里刻意手写 CONNECT 而不用 `http.Agent({ proxy: true })`：后者在本 Node 版本
 * 不读取代理环境变量，会把「直连超时」误判成「代理转发成功」。手写 CONNECT 能
 * 确定性地区分两种结果——代理收到目标地址才是通道成立。
 */
async function runProxyConnectRequest(
  proxyUrl: string,
  host: string,
  port: number,
): Promise<void> {
  const proxy = new URL(proxyUrl)
  const script = [
    'const net = require("node:net")',
    `const upstream = net.connect({ host: ${JSON.stringify(proxy.hostname)}, port: ${proxy.port}, timeout: 2000 })`,
    `upstream.on("connect", () => { upstream.write("CONNECT ${host}:${port} HTTP/1.1\\r\\nHost: ${host}:${port}\\r\\n\\r\\n") })`,
    'upstream.on("data", () => { upstream.destroy(); process.exit(0) })',
    'upstream.on("timeout", () => { upstream.destroy(); process.exit(0) })',
    'upstream.on("error", () => process.exit(0))',
  ].join(';')

  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('exit', () => resolve())
  })
}

/**
 * 等待代理确实收到指向目标的 CONNECT。
 *
 * 子进程在写入请求行后立即以超时/错误退出，因此不能只读一次数组。
 */
const waitForProxyTarget = async (
  proxy: ProxyListener,
  host: string,
  port: number,
  timeoutMs = 5_000,
): Promise<void> => {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (proxy.connectTargets.includes(`${host}:${port}`)) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
  }
  expect(proxy.connectTargets).toContain(`${host}:${port}`)
}

const resumeSmokeEnabled = process.env.RUN_ACP_SESSION_RESUME_SMOKE === '1'

describe('严格 sandbox profile 路径', () => {
  it('将 profile 放在 Adapter 可写根目录之外', async () => {
    const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-strict-sandbox-')))
    const adapterRoot = join(parentRoot, 'adapter')
    const controlRoot = join(parentRoot, 'control')
    await mkdir(adapterRoot, { mode: 0o700 })
    await mkdir(controlRoot, { mode: 0o700 })

    try {
      const profilePath = await writeStrictSandboxProfile(parentRoot, adapterRoot, controlRoot)
      const profile = await readFile(profilePath, 'utf8')

      expect(profilePath.startsWith(`${adapterRoot}/`)).toBe(false)
      expect(profile).toContain('(deny network*)')
      expect(profile).toContain('(deny file-write*)')
      expect(profile).toContain(`(allow file-write* (subpath "${adapterRoot}"))`)
      expect(profile).not.toContain(controlRoot)
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('拒绝将 symlink 用作 sandbox 根目录', async () => {
    const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-strict-sandbox-')))
    const adapterRoot = join(parentRoot, 'adapter')
    const controlRoot = join(parentRoot, 'control')
    const controlLink = join(parentRoot, 'control-link')
    await mkdir(adapterRoot, { mode: 0o700 })
    await mkdir(controlRoot, { mode: 0o700 })
    await symlink(controlRoot, controlLink, 'dir')

    try {
      await expect(writeStrictSandboxProfile(parentRoot, adapterRoot, controlLink)).rejects.toThrow(
        'sandbox path must be a real directory',
      )
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('live profile 只放行固定 broker 端口并保持文件写入边界', async () => {
    const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-live-sandbox-')))
    const adapterRoot = join(parentRoot, 'adapter')
    const controlRoot = join(parentRoot, 'control')
    await mkdir(adapterRoot, { mode: 0o700 })
    await mkdir(controlRoot, { mode: 0o700 })

    try {
      const profilePath = await writeLiveSandboxProfile(parentRoot, adapterRoot, controlRoot, 45_123)
      const profile = await readFile(profilePath, 'utf8')
      expect(profile).toContain('(deny network*)')
      expect(profile).toContain('(allow network-outbound (remote ip "localhost:45123"))')
      expect(profile).not.toContain('localhost:*')
      expect(profile).not.toContain('(allow network-inbound')
      expect(profile).toContain('(deny file-write*)')
      expect(profile).toContain(`(allow file-write* (subpath "${adapterRoot}"))`)
      await expect(writeLiveSandboxProfile(parentRoot, adapterRoot, controlRoot, 0)).rejects.toThrow('valid TCP port')
    } finally {
      await rm(parentRoot, { recursive: true, force: true })
    }
  })

  it('包装目标进程时固定使用 sandbox profile', () => {
    expect(sandboxedCommand('/tmp/control/strict.sb', '/usr/bin/node', ['--version'])).toEqual({
      command: '/usr/bin/sandbox-exec',
      args: ['-f', '/tmp/control/strict.sb', '/usr/bin/node', '--version'],
    })
  })
})

/** 记录凭据读取次数；用于断言路径预检先于凭据读取与 Runtime.connect。 */
class TrackingCredentialStore implements CredentialStorePort {
  readonly reads: string[] = []

  async save(_operationKey: string, _secret: string): Promise<string> {
    throw new Error('unused')
  }

  async get(reference: string): Promise<string | null> {
    this.reads.push(reference)
    return null
  }

  async validate(_reference: string): Promise<boolean> {
    return false
  }

  async rotate(_reference: string, _secret: string): Promise<void> {
    throw new Error('unused')
  }

  async delete(_reference: string): Promise<void> {
    throw new Error('unused')
  }
}

/** 创建与 smoke 相同的私有目录布局；不启动任何 Adapter。 */
const createRuntimePathLayout = async () => {
  const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-runtime-paths-')))
  const adapterRoot = join(parentRoot, 'adapter')
  const controlRoot = join(parentRoot, 'control')
  const outsideRoot = join(parentRoot, 'outside')
  const cwd = join(adapterRoot, 'work')
  const runtimeDirectory = join(adapterRoot, 'provider-config')
  const temporaryDirectory = join(adapterRoot, 'tmp')
  await Promise.all([
    mkdir(adapterRoot, { mode: 0o700 }),
    mkdir(controlRoot, { mode: 0o700 }),
    mkdir(outsideRoot, { mode: 0o700 }),
  ])
  await Promise.all([
    mkdir(cwd, { mode: 0o700 }),
    mkdir(runtimeDirectory, { mode: 0o700 }),
    mkdir(temporaryDirectory, { mode: 0o700 }),
  ])
  const environment = buildProbeEnvironment(adapterRoot, { TMPDIR: temporaryDirectory })
  return { parentRoot, adapterRoot, controlRoot, outsideRoot, cwd, runtimeDirectory, temporaryDirectory, environment }
}

describe('smoke 运行时路径二次预检', () => {
  it('运行时目录被替换为外部 symlink 时 fail-closed，不读取凭据也不连接 Runtime', async () => {
    const layout = await createRuntimePathLayout()
    const sentinel = join(layout.outsideRoot, 'sentinel.txt')
    await writeFile(sentinel, 'outside-sentinel', { encoding: 'utf8', mode: 0o600 })
    await rm(layout.runtimeDirectory, { recursive: true, force: true })
    await symlink(layout.outsideRoot, layout.runtimeDirectory, 'dir')

    const credentials = new TrackingCredentialStore()
    const runtime = new AcpAgentRuntime(credentials)
    const connectSpy = vi.spyOn(runtime, 'connect')

    try {
      await expect(verifyRuntimePaths({
        adapterRoot: layout.adapterRoot,
        cwd: layout.cwd,
        runtimeDirectory: layout.runtimeDirectory,
        environment: layout.environment,
      })).rejects.toThrow('sandbox path must be a real directory')
      expect(connectSpy).not.toHaveBeenCalled()
      expect(credentials.reads).toEqual([])
      expect(await readFile(sentinel, 'utf8')).toBe('outside-sentinel')
    } finally {
      await rm(layout.parentRoot, { recursive: true, force: true })
    }
  })

  it('config.toml 指向外部文件时 fail-closed，外部哨兵内容不变', async () => {
    const layout = await createRuntimePathLayout()
    const sentinel = join(layout.outsideRoot, 'sentinel.toml')
    await writeFile(sentinel, 'outside-config', { encoding: 'utf8', mode: 0o600 })
    await symlink(sentinel, join(layout.runtimeDirectory, 'config.toml'), 'file')

    const credentials = new TrackingCredentialStore()
    const runtime = new AcpAgentRuntime(credentials)
    const connectSpy = vi.spyOn(runtime, 'connect')

    try {
      await expect(verifyRuntimePaths({
        adapterRoot: layout.adapterRoot,
        cwd: layout.cwd,
        runtimeDirectory: layout.runtimeDirectory,
        environment: layout.environment,
      })).rejects.toThrow('runtime config target must be a regular file')
      expect(connectSpy).not.toHaveBeenCalled()
      expect(credentials.reads).toEqual([])
      expect(await readFile(sentinel, 'utf8')).toBe('outside-config')
    } finally {
      await rm(layout.parentRoot, { recursive: true, force: true })
    }
  })

  it('config.toml 是外部硬链接时 fail-closed，外部哨兵内容不变', async () => {
    const layout = await createRuntimePathLayout()
    const sentinel = join(layout.outsideRoot, 'sentinel-hardlink.toml')
    await writeFile(sentinel, 'outside-hardlink', { encoding: 'utf8', mode: 0o600 })
    await link(sentinel, join(layout.runtimeDirectory, 'config.toml'))

    const credentials = new TrackingCredentialStore()
    const runtime = new AcpAgentRuntime(credentials)
    const connectSpy = vi.spyOn(runtime, 'connect')

    try {
      await expect(verifyRuntimePaths({
        adapterRoot: layout.adapterRoot,
        cwd: layout.cwd,
        runtimeDirectory: layout.runtimeDirectory,
        environment: layout.environment,
      })).rejects.toThrow('runtime config target must not be hard linked')
      expect(connectSpy).not.toHaveBeenCalled()
      expect(credentials.reads).toEqual([])
      expect(await readFile(sentinel, 'utf8')).toBe('outside-hardlink')
    } finally {
      await rm(layout.parentRoot, { recursive: true, force: true })
    }
  })

  it('普通目录且尚无配置文件时允许继续连接前的后续步骤', async () => {
    const layout = await createRuntimePathLayout()
    try {
      await expect(verifyRuntimePaths({
        adapterRoot: layout.adapterRoot,
        cwd: layout.cwd,
        runtimeDirectory: layout.runtimeDirectory,
        environment: layout.environment,
      })).resolves.toBeUndefined()
    } finally {
      await rm(layout.parentRoot, { recursive: true, force: true })
    }
  })
})

describe('sandbox probe 超时清理', () => {
  it('超时后等待 probe 进程 exit 与 stdout close 确认后才失败', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let exited = false
    let closed = false
    child.once('exit', () => {
      exited = true
    })
    child.stdout?.once('close', () => {
      closed = true
    })

    await expect(readSandboxProbeResult(child, { timeoutMs: 200, killGraceMs: 5_000 }))
      .rejects.toThrow('timed out')
    // 只有 exit 与 stdout close 都已确认，helper 才会 settle。
    expect(exited).toBe(true)
    expect(closed).toBe(true)
  }, 15_000)

  it('输出超限时不提前 settle，exit 与 stdout close 确认后才返回异常', async () => {
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>
    const stdout = new EventEmitter()
    Object.assign(child, {
      pid: undefined,
      stdout,
      stderr: new EventEmitter(),
      kill: () => true,
    })
    let settled = false
    const pending = readSandboxProbeResult(child, { timeoutMs: 10_000, killGraceMs: 5_000 })
    pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    stdout.emit('data', Buffer.from('x'.repeat(129)))
    await new Promise((resolve) => setImmediate(resolve))
    // kill 已经发起，但 exit/close 尚未确认：不得提前 settle。
    expect(settled).toBe(false)

    child.emit('exit', null)
    stdout.emit('close')
    await expect(pending).rejects.toThrow('unexpected output')
  })

  it('输出超限后持续输出不会增长保留缓冲，失败语义不变', async () => {
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>
    const stdout = new EventEmitter()
    Object.assign(child, {
      pid: undefined,
      stdout,
      stderr: new EventEmitter(),
      kill: () => true,
    })

    const pending = readSandboxProbeResult(child, { timeoutMs: 10_000, killGraceMs: 5_000 })
    stdout.emit('data', Buffer.from('x'.repeat(129)))
    // kill 已发起但退出未确认：后续 chunk 不得继续累积。
    stdout.emit('data', Buffer.from('y'.repeat(64)))
    stdout.emit('data', Buffer.from('z'.repeat(64)))
    await new Promise((resolve) => setImmediate(resolve))

    child.emit('exit', null)
    stdout.emit('close')
    await expect(pending).rejects.toThrow('unexpected output (128 UTF-16 code units retained)')
  })

  it('多字节输出超限时诊断单位与保留量准确', async () => {
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>
    const stdout = new EventEmitter()
    Object.assign(child, {
      pid: undefined,
      stdout,
      stderr: new EventEmitter(),
      kill: () => true,
    })

    const pending = readSandboxProbeResult(child, { timeoutMs: 10_000, killGraceMs: 5_000 })
    // 129 个 UTF-16 code unit（387 UTF-8 bytes）：按 code unit 截断为 128。
    stdout.emit('data', Buffer.from('你'.repeat(129), 'utf8'))
    await new Promise((resolve) => setImmediate(resolve))

    child.emit('exit', null)
    stdout.emit('close')
    await expect(pending).rejects.toThrow('unexpected output (128 UTF-16 code units retained)')
  })

  it('输出超限且退出无法确认时使用 unconfirmed 错误', async () => {
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>
    const stdout = new EventEmitter()
    Object.assign(child, {
      pid: undefined,
      stdout,
      stderr: new EventEmitter(),
      kill: () => true,
    })

    const pending = readSandboxProbeResult(child, { timeoutMs: 10_000, killGraceMs: 20 })
    stdout.emit('data', Buffer.from('x'.repeat(129)))

    await expect(pending).rejects.toBeInstanceOf(SandboxProbeExitUnconfirmedError)
  })

  it('进程退出无法确认时保守失败，调用方必须保留临时树', async () => {
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>
    Object.assign(child, {
      pid: undefined,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: () => true,
    })

    await expect(readSandboxProbeResult(child, { timeoutMs: 20, killGraceMs: 20 }))
      .rejects.toBeInstanceOf(SandboxProbeExitUnconfirmedError)
  })
})

describe('sandbox probe 退出确认前的清理', () => {
  it('退出未确认时保留路径，确认后才删除', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-probe-cleanup-')))
    const privatePath = join(directory, '.sandbox-private-test')
    const protectedPath = join(directory, '.sandbox-protected-test')
    await writeFile(privatePath, 'probe', { encoding: 'utf8', mode: 0o600 })
    await writeFile(protectedPath, 'probe', { encoding: 'utf8', mode: 0o600 })

    try {
      await removeAfterConfirmedProbeExit([privatePath, protectedPath], true)
      await expect(readFile(privatePath, 'utf8')).resolves.toBe('probe')
      await expect(readFile(protectedPath, 'utf8')).resolves.toBe('probe')

      await removeAfterConfirmedProbeExit([privatePath, protectedPath], false)
      await expect(readFile(privatePath, 'utf8')).rejects.toBeTruthy()
      await expect(readFile(protectedPath, 'utf8')).rejects.toBeTruthy()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!sandbox.available)('严格 preflight 未确认退出清理', () => {
  const createLayout = async () => {
    const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-strict-unconfirmed-')))
    const adapterRoot = join(parentRoot, 'adapter')
    const controlRoot = join(parentRoot, 'control')
    const temporaryDirectory = join(adapterRoot, 'tmp')
    await mkdir(adapterRoot, { mode: 0o700 })
    await mkdir(controlRoot, { mode: 0o700 })
    await mkdir(temporaryDirectory, { mode: 0o700 })
    const profilePath = await writeStrictSandboxProfile(parentRoot, adapterRoot, controlRoot)
    const environment = buildProbeEnvironment(adapterRoot, { TMPDIR: temporaryDirectory })
    return { parentRoot, adapterRoot, controlRoot, profilePath, environment }
  }

  it('probe 退出未确认时保留 probe 文件', async () => {
    const layout = await createLayout()
    let calls = 0
    const runProbe = async (
      _profilePath: string,
      _adapterRoot: string,
      _environment: NodeJS.ProcessEnv,
      args: readonly string[],
    ): Promise<string> => {
      calls += 1
      if (args[0] === 'write') {
        await writeFile(args[1] ?? '', 'probe', { encoding: 'utf8', mode: 0o600 })
        if (calls === 4) {
          throw new SandboxProbeExitUnconfirmedError()
        }
        return 'OK'
      }
      return calls === 1 ? 'OK' : 'ERROR:EPERM'
    }

    try {
      await expect(verifyStrictSandbox(
        layout.profilePath,
        layout.adapterRoot,
        layout.controlRoot,
        layout.environment,
        runProbe,
      )).rejects.toBeInstanceOf(SandboxProbeExitUnconfirmedError)

      const adapterEntries = await readdir(layout.adapterRoot)
      expect(adapterEntries.some((name) => name.startsWith('.sandbox-private-'))).toBe(true)
      const controlEntries = await readdir(layout.controlRoot)
      expect(controlEntries.some((name) => name.startsWith('.sandbox-protected-'))).toBe(true)
    } finally {
      await rm(layout.parentRoot, { recursive: true, force: true })
    }
  })

  it('普通预检失败（退出已确认）会删除 probe 文件', async () => {
    const layout = await createLayout()
    let calls = 0
    const runProbe = async (
      _profilePath: string,
      _adapterRoot: string,
      _environment: NodeJS.ProcessEnv,
      args: readonly string[],
    ): Promise<string> => {
      calls += 1
      if (args[0] === 'write') {
        await writeFile(args[1] ?? '', 'probe', { encoding: 'utf8', mode: 0o600 })
        return 'OK'
      }
      return calls === 1 ? 'OK' : 'ERROR:EPERM'
    }

    try {
      // 第 4 次（protected write）返回 OK：sandbox 未拒绝，属于普通失败。
      await expect(verifyStrictSandbox(
        layout.profilePath,
        layout.adapterRoot,
        layout.controlRoot,
        layout.environment,
        runProbe,
      )).rejects.toThrow('sandbox did not deny a protected sibling write with EPERM')

      const adapterEntries = await readdir(layout.adapterRoot)
      expect(adapterEntries.some((name) => name.startsWith('.sandbox-private-'))).toBe(false)
      const controlEntries = await readdir(layout.controlRoot)
      expect(controlEntries.some((name) => name.startsWith('.sandbox-protected-'))).toBe(false)
    } finally {
      await rm(layout.parentRoot, { recursive: true, force: true })
    }
  })
})

describe.skipIf(!resumeSmokeEnabled || !sandbox.available)('Adapter resume 严格 sandbox 预检', () => {
  it('loopback 可用且网络与文件写入均 fail-closed', async () => {
    const parentRoot = await realpath(await mkdtemp(join(tmpdir(), 'rolecast-strict-sandbox-')))
    const adapterRoot = join(parentRoot, 'adapter')
    const controlRoot = join(parentRoot, 'control')
    const temporaryDirectory = join(adapterRoot, 'tmp')
    await Promise.all([
      mkdir(adapterRoot, { mode: 0o700 }),
      mkdir(controlRoot, { mode: 0o700 }),
    ])
    await mkdir(temporaryDirectory, { mode: 0o700 })

    let exitUnconfirmed = false
    try {
      const profilePath = await writeStrictSandboxProfile(parentRoot, adapterRoot, controlRoot)
      const environment = buildProbeEnvironment(adapterRoot, { TMPDIR: temporaryDirectory })
      await verifyStrictSandbox(profilePath, adapterRoot, controlRoot, environment)
    } catch (error: unknown) {
      // probe 退出未确认：父目录可能仍被 helper 使用，必须保留。
      exitUnconfirmed = error instanceof SandboxProbeExitUnconfirmedError
      throw error
    } finally {
      await removeAfterConfirmedProbeExit([parentRoot], exitUnconfirmed)
    }
  }, 60_000)
})
