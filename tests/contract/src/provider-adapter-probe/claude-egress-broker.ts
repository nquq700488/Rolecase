import { connect, createServer, isIP, type Server, type Socket } from 'node:net'
import { lookup } from 'node:dns/promises'

/**
 * Test-only exact-host CONNECT broker。
 *
 * 只允许精确 `api.anthropic.com:443`；控制侧预先解析并固定公网 IP，
 * broker 只连接固定 IP 的 443。TLS 原样透传，不记录请求/凭据。
 * 任一资源上限触发后永久 tripped，不重试、不重新监听。
 */

export const CLAUDE_EGRESS_HOST = 'api.anthropic.com'
export const CLAUDE_EGRESS_PORT = 443
const MAX_CONNECT_HEADER_BYTES = 8 * 1024

export interface ClaudeEgressLimits {
  readonly maxConnectAttempts: number
  readonly maxConcurrentTunnels: number
  readonly connectTimeoutMs: number
  readonly maxTunnelLifetimeMs: number
  readonly idleTimeoutMs: number
  readonly windowMs: number
  readonly maxTunnelBytes: number
  readonly maxWindowBytes: number
}

export const DEFAULT_CLAUDE_EGRESS_LIMITS: ClaudeEgressLimits = {
  maxConnectAttempts: 4,
  maxConcurrentTunnels: 1,
  connectTimeoutMs: 5_000,
  maxTunnelLifetimeMs: 120_000,
  idleTimeoutMs: 15_000,
  windowMs: 180_000,
  maxTunnelBytes: 4 * 1024 * 1024,
  maxWindowBytes: 16 * 1024 * 1024,
}

const NON_PUBLIC_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const

export interface ClaudeEgressTarget {
  readonly host: typeof CLAUDE_EGRESS_HOST
  readonly port: typeof CLAUDE_EGRESS_PORT
  /** 控制侧解析并校验后的固定公网 IP；broker 不会自行重新解析。 */
  readonly addresses: readonly string[]
}

export interface ClaudeEgressBrokerDependencies {
  /** 测试注入：默认 net.connect；返回的 socket 被视为上游。 */
  readonly connectUpstream?: (address: string, port: number) => Socket
}

export interface ClaudeEgressBroker {
  readonly port: number
  readonly address: string
  /** true 表示已因超限/超时永久停止，不再接受 CONNECT。 */
  readonly tripped: boolean
  readonly connectAttempts: number
  readonly upstreamConnects: number
  close(): Promise<void>
}

export class ClaudeEgressPolicyError extends Error {
  readonly code = 'CLAUDE_EGRESS_BLOCKED'

  constructor(message: string) {
    super(message)
    this.name = 'ClaudeEgressPolicyError'
  }
}

/** 校验 authority 只允许精确 host/port；拒绝 userinfo、IPv6、其他端口。 */
export function parseConnectAuthority(line: string): { host: string; port: number } {
  const match = /^CONNECT ([^ ]+) HTTP\/1\.[01]$/.exec(line)
  const authority = match?.[1]
  if (authority === undefined) {
    throw new ClaudeEgressPolicyError('malformed CONNECT request')
  }
  if (authority.includes('@')) {
    throw new ClaudeEgressPolicyError('CONNECT userinfo is not allowed')
  }
  const separator = authority.lastIndexOf(':')
  if (separator <= 0) {
    throw new ClaudeEgressPolicyError('CONNECT authority must include a port')
  }
  const host = authority.slice(0, separator)
  const portText = authority.slice(separator + 1)
  if (!/^\d+$/.test(portText)) {
    throw new ClaudeEgressPolicyError('CONNECT port must be numeric')
  }
  const port = Number(portText)
  if (host !== CLAUDE_EGRESS_HOST || port !== CLAUDE_EGRESS_PORT) {
    throw new ClaudeEgressPolicyError('CONNECT authority is not allowlisted')
  }
  return { host, port }
}

/** 拒绝 loopback/私网/link-local/保留地址；只保留固定公网 IP。 */
export function assertPublicAddress(address: string): void {
  if (!isIP(address)) {
    throw new ClaudeEgressPolicyError('resolved address is not an IP')
  }
  if (address.includes(':')) {
    // IPv4 以外的地址族不在本轮 SBPL 固定范围内。
    throw new ClaudeEgressPolicyError('IPv6 egress is not supported by this broker')
  }
  const addressNumber = ipv4ToNumber(address)
  if (NON_PUBLIC_IPV4_CIDRS.some((cidr) => isIpv4AddressInCidr(addressNumber, cidr))) {
    throw new ClaudeEgressPolicyError('resolved address is not a public unicast IP')
  }
}

function ipv4ToNumber(address: string): number {
  return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0)
}

function isIpv4AddressInCidr(address: number, cidr: string): boolean {
  const [network, prefixText] = cidr.split('/')
  if (network === undefined || prefixText === undefined) {
    return false
  }
  const prefixLength = Number(prefixText)
  const blockSize = 2 ** (32 - prefixLength)
  return Math.floor(address / blockSize) === Math.floor(ipv4ToNumber(network) / blockSize)
}

/** 控制侧解析并固定本轮公网地址；失败即 fail-closed。 */
export async function resolveClaudeEgressTarget(
  resolve: (host: string) => Promise<readonly string[]> = async (host) => {
    const records = await lookup(host, { all: true, family: 4 })
    return records.map((record) => record.address)
  },
): Promise<ClaudeEgressTarget> {
  const addresses = await resolve(CLAUDE_EGRESS_HOST)
  if (addresses.length === 0) {
    throw new ClaudeEgressPolicyError('no egress address resolved')
  }
  for (const address of addresses) {
    assertPublicAddress(address)
  }
  return { host: CLAUDE_EGRESS_HOST, port: CLAUDE_EGRESS_PORT, addresses }
}

export interface StartBrokerOptions {
  readonly target: ClaudeEgressTarget
  readonly limits?: Partial<ClaudeEgressLimits>
  readonly dependencies?: ClaudeEgressBrokerDependencies
}

/**
 * 启动 loopback broker。仅允许 Adapter 连接该固定端口。
 */
export async function startClaudeEgressBroker(options: StartBrokerOptions): Promise<ClaudeEgressBroker> {
  if (options.target.host !== CLAUDE_EGRESS_HOST || options.target.port !== CLAUDE_EGRESS_PORT) {
    throw new ClaudeEgressPolicyError('broker target must be api.anthropic.com:443')
  }
  const rawAddresses: unknown = options.target.addresses
  if (!Array.isArray(rawAddresses) || rawAddresses.length === 0) {
    throw new ClaudeEgressPolicyError('broker target requires at least one fixed public IPv4 address')
  }
  const fixedAddresses = Object.freeze([...new Set(rawAddresses.map((address: unknown): string => {
    if (typeof address !== 'string') {
      throw new ClaudeEgressPolicyError('broker target address must be a string')
    }
    assertPublicAddress(address)
    return address
  }))])

  const limits = { ...DEFAULT_CLAUDE_EGRESS_LIMITS, ...options.limits }
  const connectUpstream = options.dependencies?.connectUpstream
    ?? ((address: string, port: number) => connect(port, address))
  let tripped = false
  let connectAttempts = 0
  let upstreamConnects = 0
  let windowBytes = 0
  let activeTunnels = 0
  let windowTimer: NodeJS.Timeout | undefined
  const sockets = new Set<Socket>()
  const server: Server = createServer((client) => handleClient(client))

  const trip = (keep?: Socket): void => {
    tripped = true
    if (windowTimer !== undefined) {
      clearTimeout(windowTimer)
      windowTimer = undefined
    }
    server.close()
    for (const socket of sockets) {
      if (socket !== keep) {
        socket.destroy()
      }
    }
    sockets.clear()
  }

  const track = (socket: Socket): void => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('close', () => sockets.delete(socket))
  }

  const handleClient = (client: Socket): void => {
    track(client)
    if (tripped) {
      client.destroy()
      return
    }
    connectAttempts += 1
    if (connectAttempts > limits.maxConnectAttempts) {
      client.end('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      trip(client)
      return
    }
    if (activeTunnels >= limits.maxConcurrentTunnels) {
      client.end('HTTP/1.1 429 Concurrent Tunnel Limit\r\n\r\n')
      return
    }
    let buffered = ''
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('latin1')
      const headerEnd = buffered.indexOf('\r\n\r\n')
      if (headerEnd < 0) {
        if (buffered.length > MAX_CONNECT_HEADER_BYTES) {
          client.destroy()
        }
        return
      }
      if (headerEnd > MAX_CONNECT_HEADER_BYTES) {
        client.destroy()
        return
      }
      client.off('data', onData)
      const requestLine = buffered.slice(0, buffered.indexOf('\r\n'))
      let authority: { host: string; port: number }
      try {
        authority = parseConnectAuthority(requestLine)
      } catch {
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n')
        return
      }
      openTunnel(client, authority, buffered.slice(headerEnd + 4))
    }
    client.on('data', onData)
  }

  const openTunnel = (
    client: Socket,
    _authority: { host: string; port: number },
    initialPayload: string,
  ): void => {
    if (tripped) {
      client.destroy()
      return
    }
    const address = fixedAddresses[upstreamConnects % fixedAddresses.length]
    if (address === undefined) {
      trip()
      client.destroy()
      return
    }
    upstreamConnects += 1
    let upstream: Socket
    try {
      upstream = connectUpstream(address, CLAUDE_EGRESS_PORT)
    } catch {
      trip()
      client.destroy()
      return
    }
    activeTunnels += 1
    track(upstream)
    let tunnelBytes = 0
    let settled = false
    const connectTimer = setTimeout(() => {
      trip()
    }, limits.connectTimeoutMs)
    const lifetimeTimer = setTimeout(() => {
      trip()
    }, limits.maxTunnelLifetimeMs)
    const idleTimer = setTimeout(() => {
      trip()
    }, limits.idleTimeoutMs)

    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(connectTimer)
      clearTimeout(lifetimeTimer)
      clearTimeout(idleTimer)
      activeTunnels = Math.max(0, activeTunnels - 1)
      client.destroy()
      upstream.destroy()
    }

    const account = (bytes: number): boolean => {
      tunnelBytes += bytes
      windowBytes += bytes
      return tunnelBytes <= limits.maxTunnelBytes && windowBytes <= limits.maxWindowBytes
    }

    upstream.once('connect', () => {
      clearTimeout(connectTimer)
      if (initialPayload.length > 0 && !account(Buffer.byteLength(initialPayload, 'latin1'))) {
        // CONNECT 同一帧中的 TLS ClientHello 也属于隧道字节预算。
        trip()
        finish()
        return
      }
      upstream.write(initialPayload, 'latin1')
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      client.on('data', (chunk: Buffer) => {
        idleTimer.refresh()
        if (!account(chunk.length)) {
          trip()
          finish()
          return
        }
        upstream.write(chunk)
      })
      upstream.on('data', (chunk: Buffer) => {
        idleTimer.refresh()
        if (!account(chunk.length)) {
          trip()
          finish()
          return
        }
        client.write(chunk)
      })
    })
    upstream.on('error', finish)
    upstream.on('close', finish)
    client.on('error', finish)
    client.on('close', finish)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new ClaudeEgressPolicyError('broker did not expose a loopback port')
  }

  windowTimer = setTimeout(() => {
    trip()
  }, limits.windowMs)

  return {
    port: address.port,
    address: address.address,
    get tripped() {
      return tripped
    },
    get connectAttempts() {
      return connectAttempts
    },
    get upstreamConnects() {
      return upstreamConnects
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        if (windowTimer !== undefined) {
          clearTimeout(windowTimer)
          windowTimer = undefined
        }
        for (const socket of sockets) {
          socket.destroy()
        }
        sockets.clear()
        if (!server.listening) {
          resolve()
          return
        }
        server.close(() => resolve())
      })
    },
  }
}
