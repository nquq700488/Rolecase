import { PassThrough, Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { AcpJsonRpcClient } from './acp-client.js'

/** 记录写入顺序的 Writable；用于验证 onSent 与写入的先后关系。 */
class RecordingWritable extends Writable {
  readonly frames: string[] = []
  readonly order: string[] = []

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.frames.push(chunk.toString('utf8'))
    this.order.push('write')
    callback()
  }
}

/** 写入同步抛错的 Writable；用于验证写失败时不会触发 onSent。 */
class FailingWritable extends Writable {
  override write(): boolean {
    throw new Error('write failed')
  }

  override _write(): void {
    throw new Error('unreachable')
  }
}

const nextLine = async (stream: PassThrough): Promise<Record<string, unknown>> => {
  const chunk = await new Promise<Buffer>((resolve) => {
    stream.once('data', (value: Buffer) => resolve(value))
  })
  return JSON.parse(chunk.toString('utf8')) as Record<string, unknown>
}

describe('AcpJsonRpcClient', () => {
  it('关联请求响应并解析 JSON-RPC 行', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const client = new AcpJsonRpcClient(input, output)

    const responsePromise = client.request<{ ok: boolean }>('initialize', { protocolVersion: 1 })
    const request = await nextLine(output)

    expect(request).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1 },
    })

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`)
    await expect(responsePromise).resolves.toEqual({ ok: true })
    client.close()
  })

  it('分发通知和服务端请求，并回写请求结果', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const client = new AcpJsonRpcClient(input, output)
    const notifications: string[] = []
    client.onNotification((message) => notifications.push(message.method))
    client.onRequest(async (message) => ({ accepted: message.method === 'session/request_permission' }))

    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {} })}\n`,
    )
    input.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: {} })}\n`,
    )

    await new Promise((resolve) => setImmediate(resolve))
    const response = await nextLine(output)

    expect(notifications).toEqual(['session/update'])
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 9,
      result: { accepted: true },
    })
    client.close()
  })

  it('onSent 在请求帧写入后才触发', () => {
    const input = new PassThrough()
    const output = new RecordingWritable()
    const client = new AcpJsonRpcClient(input, output)

    const pending = client.request(
      'session/prompt',
      { sessionId: 'session-1' },
      10_000,
      undefined,
      () => output.order.push('sent'),
    )
    // 请求尚未收到响应：挂起 Promise 由 close 收敛，避免未处理拒绝。
    pending.catch(() => undefined)

    expect(output.order).toEqual(['write', 'sent'])
    expect(JSON.parse(output.frames[0] ?? '')).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/prompt',
      params: { sessionId: 'session-1' },
    })
    client.close()
  })

  it('请求帧写入抛错时不触发 onSent', async () => {
    const input = new PassThrough()
    const client = new AcpJsonRpcClient(input, new FailingWritable())
    let sent = 0

    await expect(client.request('session/prompt', {}, 10_000, undefined, () => {
      sent += 1
    })).rejects.toThrow('write failed')
    expect(sent).toBe(0)
    client.close()
  })

  it('请求超时后拒绝 Promise', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const client = new AcpJsonRpcClient(input, output)

    const responsePromise = client.request('slow', {}, 10)
    await expect(responsePromise).rejects.toMatchObject({ code: 'ACP_REQUEST_TIMEOUT' })
    client.close()
  })

  it('拒绝合法 JSON 但不是对象的 ACP 帧并触发 fatal', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let fatalError: Error | null = null
    const client = new AcpJsonRpcClient(input, output, {
      onFatalError: (error) => {
        fatalError = error
      },
    })

    const responsePromise = client.request('invalid', {})
    await nextLine(output)
    input.write('null\n')
    await expect(responsePromise).rejects.toMatchObject({ code: 'ACP_INVALID_FRAME' })
    expect(fatalError).toMatchObject({ code: 'ACP_INVALID_FRAME' })
    client.close()
  })

  it('非法 JSON 触发 fatal 且错误不携带原始行', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let fatalError: Error | null = null
    const client = new AcpJsonRpcClient(input, output, {
      onFatalError: (error) => {
        fatalError = error
      },
    })

    const responsePromise = client.request('broken', {})
    await nextLine(output)
    input.write('{"broken": "RAW-FRAME-SECRET"\n')

    const error = await responsePromise.then(() => null, (rejected: unknown) => rejected as Error)
    expect(error).toMatchObject({ code: 'ACP_INVALID_FRAME' })
    expect(String(error?.message)).not.toContain('RAW-FRAME-SECRET')
    expect(JSON.stringify(fatalError)).not.toContain('RAW-FRAME-SECRET')
    client.close()
  })

  it('关闭后不向已关闭的 Adapter 写响应', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const client = new AcpJsonRpcClient(input, output)
    const writes: string[] = []
    output.on('data', (chunk: Buffer) => writes.push(chunk.toString('utf8')))

    const settleCallbacks: Array<() => void> = []
    client.onRequest(() => new Promise((_resolve, reject) => {
      settleCallbacks.push(() => reject(new Error('ACP connection closed')))
    }))

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: {} })}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    client.close()
    for (const settle of settleCallbacks) {
      settle()
    }
    await new Promise((resolve) => setImmediate(resolve))

    expect(writes).toEqual([])
  })

  it('输入流非主动关闭时转为 fatal 状态并拒绝 pending', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let fatalError: Error | null = null
    const client = new AcpJsonRpcClient(input, output, {
      onFatalError: (error) => {
        fatalError = error
      },
    })

    const responsePromise = client.request('session/prompt', {})
    await nextLine(output)
    // Adapter 半关闭 stdout，但子进程仍存活。
    input.end()

    await expect(responsePromise).rejects.toMatchObject({ code: 'ACP_INPUT_CLOSED' })
    expect(fatalError).toMatchObject({ code: 'ACP_INPUT_CLOSED' })
    // 已进入 fatal 状态：后续请求直接失败，不再挂起。
    await expect(client.request('session/prompt', {})).rejects.toBeTruthy()
  })

  it('请求 ID 合法域与 Contract / codec 一致：拒绝空 string、小数和超安全整数', async () => {
    for (const id of ['', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const input = new PassThrough()
      const output = new PassThrough()
      let fatalError: Error | null = null
      const client = new AcpJsonRpcClient(input, output, {
        onFatalError: (error) => {
          fatalError = error
        },
      })
      const responsePromise = client.request('session/prompt', {})
      await nextLine(output)

      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {} })}\n`)

      // 非法 ID 在进入 Runtime 前就被拒绝，且错误不含原始帧。
      await expect(responsePromise).rejects.toMatchObject({ code: 'ACP_INVALID_FRAME' })
      expect(fatalError).toMatchObject({ code: 'ACP_INVALID_FRAME' })
      expect(JSON.stringify(fatalError)).not.toContain('session/request_permission')
      client.close()
    }
  })

  it('请求 ID 接受负 safe integer、最大 safe integer 与非空 string', async () => {
    for (const id of [-1, Number.MAX_SAFE_INTEGER, 'request-1']) {
      const input = new PassThrough()
      const output = new PassThrough()
      const received: unknown[] = []
      const client = new AcpJsonRpcClient(input, output)
      client.onRequest((message) => {
        received.push(message.id)
        return {}
      })

      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {} })}\n`)
      await new Promise((resolve) => setImmediate(resolve))

      expect(received).toEqual([id])
      client.close()
    }
  })

  it('主动 close 不触发 fatal 回调', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let fatalCount = 0
    const client = new AcpJsonRpcClient(input, output, {
      onFatalError: () => {
        fatalCount += 1
      },
    })

    client.close()
    input.end()
    await new Promise((resolve) => setImmediate(resolve))

    expect(fatalCount).toBe(0)
  })

  it('AbortSignal 取消 pending request 并清理等待状态', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const client = new AcpJsonRpcClient(input, output)
    const controller = new AbortController()

    const responsePromise = client.request('slow', {}, 10_000, controller.signal)
    await nextLine(output)
    controller.abort()

    await expect(responsePromise).rejects.toMatchObject({ code: 'ACP_REQUEST_ABORTED' })
    client.close()
  })

  it('ACP 单帧超过上限时触发 fatal 回调并拒绝请求', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let fatalError: Error | null = null
    const client = new AcpJsonRpcClient(input, output, {
      maxFrameBytes: 32,
      onFatalError: (error) => {
        fatalError = error
      },
    })

    const responsePromise = client.request('oversized', {})
    await nextLine(output)
    input.write(`${'x'.repeat(64)}\n`)

    await expect(responsePromise).rejects.toMatchObject({ code: 'ACP_OUTPUT_LIMIT' })
    expect(fatalError).toMatchObject({ code: 'ACP_OUTPUT_LIMIT' })
    client.close()
  })
})
