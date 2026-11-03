import { once } from 'node:events'
import { connect, createServer, Socket, type Server } from 'node:net'

import { describe, expect, it } from 'vitest'

import {
  assertPublicAddress,
  parseConnectAuthority,
  resolveClaudeEgressTarget,
  startClaudeEgressBroker,
  type ClaudeEgressTarget,
} from './claude-egress-broker.js'

const target: ClaudeEgressTarget = {
  host: 'api.anthropic.com',
  port: 443,
  addresses: ['8.8.8.8'],
}

const readStatus = async (socket: Socket): Promise<string> => {
  const [chunk] = await once(socket, 'data') as [Buffer]
  return chunk.toString('latin1').split('\r\n')[0] ?? ''
}

const openTunnel = async (brokerPort: number, authority = 'api.anthropic.com:443') => {
  const socket = connect({ host: '127.0.0.1', port: brokerPort })
  await once(socket, 'connect')
  socket.write(`CONNECT ${authority} HTTP/1.1\r\n\r\n`)
  const status = await readStatus(socket)
  return { socket, status }
}

const startEchoUpstream = async (): Promise<{ server: Server; port: number }> => {
  const server = createServer((socket) => socket.on('data', (chunk) => socket.write(chunk)))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('echo upstream did not expose a port')
  }
  return { server, port: address.port }
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()))

const waitForSocketClose = (socket: Socket, timeoutMs = 1_000): Promise<void> => {
  if (socket.closed) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('close', handleClose)
      reject(new Error('socket did not close within the limit'))
    }, timeoutMs)
    const handleClose = (): void => {
      clearTimeout(timeout)
      resolve()
    }
    socket.once('close', handleClose)
  })
}

const startSinkUpstream = async (): Promise<{
  readonly server: Server
  readonly port: number
  readonly received: Buffer[]
}> => {
  const received: Buffer[] = []
  const server = createServer((socket) => {
    socket.on('data', (chunk) => received.push(Buffer.from(chunk)))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('sink upstream did not expose a port')
  }
  return { server, port: address.port, received }
}

describe('Claude egress broker 解析与地址校验', () => {
  it('只允许精确 api.anthropic.com:443', () => {
    expect(parseConnectAuthority('CONNECT api.anthropic.com:443 HTTP/1.1')).toEqual({
      host: 'api.anthropic.com',
      port: 443,
    })
    for (const line of [
      'CONNECT api.anthropic.com:8443 HTTP/1.1',
      'CONNECT evil.example:443 HTTP/1.1',
      'CONNECT user@api.anthropic.com:443 HTTP/1.1',
      'CONNECT api.anthropic.com HTTP/1.1',
      'GET http://api.anthropic.com/ HTTP/1.1',
    ]) {
      expect(() => parseConnectAuthority(line)).toThrow()
    }
  })

  it('拒绝 loopback/私网/link-local/保留/文档测试地址', () => {
    for (const address of [
      '0.0.0.1',
      '10.1.2.3',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.1.1',
      '172.16.0.1',
      '192.0.0.1',
      '192.0.2.1',
      '192.88.99.1',
      '192.168.1.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.10',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
    ]) {
      expect(() => assertPublicAddress(address)).toThrow()
    }
    expect(() => assertPublicAddress('1.1.1.1')).not.toThrow()
    expect(() => assertPublicAddress('8.8.8.8')).not.toThrow()
  })

  it('控制侧解析并固定通过校验的 IPv4 地址', async () => {
    const resolvedHosts: string[] = []
    const resolved = await resolveClaudeEgressTarget(async (host) => {
      resolvedHosts.push(host)
      return ['1.1.1.1', '8.8.8.8']
    })
    expect(resolvedHosts).toEqual(['api.anthropic.com'])
    expect(resolved).toEqual({ host: 'api.anthropic.com', port: 443, addresses: ['1.1.1.1', '8.8.8.8'] })
  })

  it('DNS 返回私网或保留地址时 fail-closed', async () => {
    await expect(resolveClaudeEgressTarget(async () => ['203.0.113.10'])).rejects.toThrow()
  })
})

describe('Claude egress broker 隧道', () => {
  it('只向启动时固定的公网 IP:443 建立 TLS passthrough 隧道', async () => {
    const upstream = await startEchoUpstream()
    const addresses = ['8.8.8.8']
    const fixedTarget: ClaudeEgressTarget = { ...target, addresses }
    const connectTargets: Array<{ address: string; port: number }> = []
    const broker = await startClaudeEgressBroker({
      target: fixedTarget,
      limits: { connectTimeoutMs: 1_000, idleTimeoutMs: 2_000 },
      dependencies: {
        connectUpstream: (address, port) => {
          connectTargets.push({ address, port })
          return connect(upstream.port, '127.0.0.1')
        },
      },
    })
    addresses[0] = '127.0.0.1'
    try {
      const { socket, status } = await openTunnel(broker.port)
      expect(status).toBe('HTTP/1.1 200 Connection Established')
      socket.write('ping')
      const [echo] = await once(socket, 'data') as [Buffer]
      expect(echo.toString('utf8')).toBe('ping')
      expect(connectTargets).toEqual([{ address: '8.8.8.8', port: 443 }])
      socket.destroy()
    } finally {
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('启动前拒绝错误 authority、空地址集和非公网 target', async () => {
    const invalidTargets = [
      { ...target, host: 'evil.example' },
      { ...target, port: 8443 },
      { ...target, addresses: [] },
      { ...target, addresses: ['127.0.0.1'] },
    ] as unknown as ClaudeEgressTarget[]

    for (const invalidTarget of invalidTargets) {
      const result = await startClaudeEgressBroker({ target: invalidTarget }).then(
        async (broker) => {
          await broker.close()
          return 'started' as const
        },
        () => 'rejected' as const,
      )
      expect(result).toBe('rejected')
    }
  })

  it('client reset during CONNECT is handled and does not stop the broker', async () => {
    const upstream = await startEchoUpstream()
    const broker = await startClaudeEgressBroker({
      target,
      dependencies: { connectUpstream: () => connect(upstream.port, '127.0.0.1') },
    })
    const resetClient = connect({ host: '127.0.0.1', port: broker.port })
    resetClient.on('error', () => undefined)
    await once(resetClient, 'connect')
    const resetClosed = waitForSocketClose(resetClient)

    try {
      resetClient.destroy(new Error('test reset'))
      await resetClosed
      expect(broker.tripped).toBe(false)
      const valid = await openTunnel(broker.port)
      expect(valid.status).toBe('HTTP/1.1 200 Connection Established')
      valid.socket.destroy()
    } finally {
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('超过上限且同帧结束的 CONNECT header 在上游连接前拒绝', async () => {
    const upstream = await startEchoUpstream()
    let upstreamConnects = 0
    const broker = await startClaudeEgressBroker({
      target,
      dependencies: {
        connectUpstream: () => {
          upstreamConnects += 1
          return connect(upstream.port, '127.0.0.1')
        },
      },
    })
    const client = connect({ host: '127.0.0.1', port: broker.port })
    await once(client, 'connect')
    const closed = waitForSocketClose(client)

    try {
      client.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\nX-Large: ${'x'.repeat(9 * 1024)}\r\n\r\n`)
      await closed
      expect(upstreamConnects).toBe(0)
    } finally {
      client.destroy()
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('拒绝非 allowlist authority', async () => {
    const broker = await startClaudeEgressBroker({ target })
    try {
      const { socket, status } = await openTunnel(broker.port, 'evil.example:443')
      expect(status).toBe('HTTP/1.1 403 Forbidden')
      socket.destroy()
      expect(broker.upstreamConnects).toBe(0)
      expect(broker.tripped).toBe(false)
    } finally {
      await broker.close()
    }
  })

  it('并发 tunnel 上限拒绝第二个连接', async () => {
    const upstream = await startEchoUpstream()
    const broker = await startClaudeEgressBroker({
      target,
      limits: { maxConcurrentTunnels: 1, maxConnectAttempts: 10, connectTimeoutMs: 2_000, idleTimeoutMs: 2_000 },
      dependencies: { connectUpstream: () => connect(upstream.port, '127.0.0.1') },
    })
    try {
      const first = await openTunnel(broker.port)
      expect(first.status).toBe('HTTP/1.1 200 Connection Established')
      const second = await openTunnel(broker.port)
      expect(second.status).toBe('HTTP/1.1 429 Concurrent Tunnel Limit')
      first.socket.destroy()
      second.socket.destroy()
    } finally {
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('CONNECT 尝试超限后断开两端并永久 tripped', async () => {
    const upstream = await startEchoUpstream()
    const broker = await startClaudeEgressBroker({
      target,
      limits: { maxConnectAttempts: 1 },
      dependencies: { connectUpstream: () => connect(upstream.port, '127.0.0.1') },
    })
    try {
      const first = await openTunnel(broker.port)
      const firstClosed = waitForSocketClose(first.socket)
      const second = connect({ host: '127.0.0.1', port: broker.port })
      second.on('error', () => undefined)
      await once(second, 'connect')
      const secondClosed = waitForSocketClose(second)
      second.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n')
      expect(await readStatus(second)).toBe('HTTP/1.1 429 Too Many Requests')
      await Promise.all([firstClosed, secondClosed])
      expect(broker.tripped).toBe(true)
      expect(broker.connectAttempts).toBe(2)
      // tripped 后 listener 已关闭：新连接被拒绝。
      await expect(once(connect({ host: '127.0.0.1', port: broker.port }), 'connect')).rejects.toBeTruthy()
    } finally {
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('单 tunnel 字节预算边界可用，超限后两端断开并永久 tripped', async () => {
    const upstream = await startSinkUpstream()
    const upstreamConnection = once(upstream.server, 'connection') as Promise<[Socket]>
    const broker = await startClaudeEgressBroker({
      target,
      limits: { maxTunnelBytes: 8, maxWindowBytes: 32, connectTimeoutMs: 2_000, idleTimeoutMs: 2_000 },
      dependencies: { connectUpstream: () => connect(upstream.port, '127.0.0.1') },
    })
    try {
      const { socket, status } = await openTunnel(broker.port)
      expect(status).toBe('HTTP/1.1 200 Connection Established')
      const [upstreamSocket] = await upstreamConnection
      const firstData = once(upstreamSocket, 'data') as Promise<[Buffer]>
      socket.write('x'.repeat(8))
      const [accepted] = await firstData
      expect(accepted.byteLength).toBe(8)
      expect(broker.tripped).toBe(false)

      const clientClosed = waitForSocketClose(socket)
      const upstreamClosed = waitForSocketClose(upstreamSocket)
      socket.write('y')
      await Promise.all([clientClosed, upstreamClosed])
      expect(broker.tripped).toBe(true)
      expect(Buffer.concat(upstream.received)).toHaveLength(8)
    } finally {
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('总字节窗口跨隧道累计并在超限后断开两端', async () => {
    const upstream = await startSinkUpstream()
    const broker = await startClaudeEgressBroker({
      target,
      limits: { maxTunnelBytes: 16, maxWindowBytes: 8, maxConnectAttempts: 4, idleTimeoutMs: 2_000 },
      dependencies: { connectUpstream: () => connect(upstream.port, '127.0.0.1') },
    })
    try {
      const firstConnection = once(upstream.server, 'connection') as Promise<[Socket]>
      const first = await openTunnel(broker.port)
      const [firstUpstream] = await firstConnection
      const firstData = once(firstUpstream, 'data') as Promise<[Buffer]>
      first.socket.write('12345678')
      await firstData
      expect(broker.tripped).toBe(false)

      const firstClientClosed = waitForSocketClose(first.socket)
      const firstUpstreamClosed = waitForSocketClose(firstUpstream)
      first.socket.destroy()
      await Promise.all([firstClientClosed, firstUpstreamClosed])

      const secondConnection = once(upstream.server, 'connection') as Promise<[Socket]>
      const second = await openTunnel(broker.port)
      const [secondUpstream] = await secondConnection
      const secondClientClosed = waitForSocketClose(second.socket)
      const secondUpstreamClosed = waitForSocketClose(secondUpstream)
      second.socket.write('x')
      await Promise.all([secondClientClosed, secondUpstreamClosed])
      expect(broker.tripped).toBe(true)
      expect(broker.connectAttempts).toBe(2)
      expect(Buffer.concat(upstream.received)).toHaveLength(8)
    } finally {
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('CONNECT 同帧的初始 payload 在转发前计入隧道字节上限', async () => {
    const forwarded: Buffer[] = []
    const upstream = createServer((socket) => {
      socket.on('data', (chunk) => forwarded.push(Buffer.from(chunk)))
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const upstreamAddress = upstream.address()
    if (upstreamAddress === null || typeof upstreamAddress === 'string') {
      throw new Error('fake upstream did not expose a port')
    }
    const broker = await startClaudeEgressBroker({
      target,
      limits: { maxTunnelBytes: 8, maxWindowBytes: 64, connectTimeoutMs: 1_000, idleTimeoutMs: 2_000 },
      dependencies: { connectUpstream: () => connect(upstreamAddress.port, '127.0.0.1') },
    })
    const client = connect({ host: '127.0.0.1', port: broker.port })
    await once(client, 'connect')
    const clientClosed = once(client, 'close').then(() => 'closed' as const)
    const upstreamReceived = new Promise<'forwarded'>((resolve) => {
      upstream.once('connection', (socket) => socket.once('data', () => resolve('forwarded')))
    })
    let timeout: NodeJS.Timeout | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), 1_000)
    })

    try {
      client.write(`CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n${'x'.repeat(9)}`)
      const outcome = await Promise.race([clientClosed, upstreamReceived, timedOut])
      expect(outcome).toBe('closed')
      expect(broker.tripped).toBe(true)
      expect(Buffer.concat(forwarded)).toHaveLength(0)
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout)
      }
      client.destroy()
      await broker.close()
      await closeServer(upstream)
    }
  })

  it('单 tunnel 存活时间超限后在两端断开并永久 tripped', async () => {
    const upstream = await startSinkUpstream()
    const upstreamConnection = once(upstream.server, 'connection') as Promise<[Socket]>
    const broker = await startClaudeEgressBroker({
      target,
      limits: { maxTunnelLifetimeMs: 40, idleTimeoutMs: 2_000, windowMs: 5_000 },
      dependencies: { connectUpstream: () => connect(upstream.port, '127.0.0.1') },
    })
    try {
      const { socket, status } = await openTunnel(broker.port)
      expect(status).toBe('HTTP/1.1 200 Connection Established')
      const [upstreamSocket] = await upstreamConnection
      await Promise.all([waitForSocketClose(socket), waitForSocketClose(upstreamSocket)])
      expect(broker.tripped).toBe(true)
      expect(broker.connectAttempts).toBe(1)
      expect(broker.upstreamConnects).toBe(1)
    } finally {
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('idle 超限后在两端断开并永久 tripped', async () => {
    const upstream = await startSinkUpstream()
    const upstreamConnection = once(upstream.server, 'connection') as Promise<[Socket]>
    const broker = await startClaudeEgressBroker({
      target,
      limits: { maxTunnelLifetimeMs: 2_000, idleTimeoutMs: 40, windowMs: 5_000 },
      dependencies: { connectUpstream: () => connect(upstream.port, '127.0.0.1') },
    })
    try {
      const { socket, status } = await openTunnel(broker.port)
      expect(status).toBe('HTTP/1.1 200 Connection Established')
      const [upstreamSocket] = await upstreamConnection
      await Promise.all([waitForSocketClose(socket), waitForSocketClose(upstreamSocket)])
      expect(broker.tripped).toBe(true)
      expect(broker.connectAttempts).toBe(1)
      expect(broker.upstreamConnects).toBe(1)
    } finally {
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('总 egress 时间窗口超限后关闭活动两端并永久 tripped', async () => {
    const upstream = await startSinkUpstream()
    const upstreamConnection = once(upstream.server, 'connection') as Promise<[Socket]>
    const broker = await startClaudeEgressBroker({
      target,
      limits: { windowMs: 200, maxTunnelLifetimeMs: 2_000, idleTimeoutMs: 2_000 },
      dependencies: { connectUpstream: () => connect(upstream.port, '127.0.0.1') },
    })
    try {
      const { socket, status } = await openTunnel(broker.port)
      expect(status).toBe('HTTP/1.1 200 Connection Established')
      const [upstreamSocket] = await upstreamConnection
      await Promise.all([waitForSocketClose(socket), waitForSocketClose(upstreamSocket)])
      expect(broker.tripped).toBe(true)
      expect(broker.connectAttempts).toBe(1)
      expect(broker.upstreamConnects).toBe(1)
    } finally {
      await broker.close()
      await closeServer(upstream.server)
    }
  })

  it('上游建连超时后在一秒内关闭两端并永久 tripped', async () => {
    let resolveUpstream: (socket: Socket) => void = () => undefined
    const upstreamSocketPromise = new Promise<Socket>((resolve) => {
      resolveUpstream = resolve
    })
    const broker = await startClaudeEgressBroker({
      target,
      limits: { connectTimeoutMs: 30, windowMs: 10_000 },
      dependencies: {
        connectUpstream: () => {
          const socket = new Socket()
          resolveUpstream(socket)
          return socket
        },
      },
    })
    const client = connect({ host: '127.0.0.1', port: broker.port })
    await once(client, 'connect')
    const clientClosed = waitForSocketClose(client)
    try {
      client.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\n\r\n')
      const upstreamSocket = await upstreamSocketPromise
      await Promise.all([clientClosed, waitForSocketClose(upstreamSocket)])
      expect(broker.tripped).toBe(true)
      expect(broker.connectAttempts).toBe(1)
      expect(broker.upstreamConnects).toBe(1)
    } finally {
      await broker.close()
    }
  })
})
