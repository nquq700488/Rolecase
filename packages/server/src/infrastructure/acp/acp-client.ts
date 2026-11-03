import { createInterface, type Interface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

import { isJsonRpcRequestId } from '@rolecast/contract'

interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** ACP JSON-RPC framing 层的资源限制和 fatal 回调。 */
export interface AcpJsonRpcClientOptions {
  readonly maxFrameBytes?: number
  readonly onFatalError?: (error: Error) => void
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
  removeAbortListener?: () => void
}

const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024

/** ACP 请求在调用方提前结束时被取消。 */
export class AcpRequestAbortedError extends Error {
  readonly code = 'ACP_REQUEST_ABORTED'

  constructor(method: string) {
    super(`ACP request aborted: ${method}`)
    this.name = 'AcpRequestAbortedError'
  }
}

/** ACP 单帧超过受控上限。 */
export class AcpOutputLimitError extends Error {
  readonly code = 'ACP_OUTPUT_LIMIT'

  constructor(maxFrameBytes: number) {
    super(`ACP output frame exceeded ${maxFrameBytes} bytes`)
    this.name = 'AcpOutputLimitError'
  }
}

/**
 * ACP 输入流在非主动关闭的情况下结束。
 *
 * Adapter 半关闭 stdout 或崩溃时子进程可能仍然存活，因此不能只等进程退出。
 */
export class AcpInputClosedError extends Error {
  readonly code = 'ACP_INPUT_CLOSED'

  constructor() {
    super('ACP input stream closed unexpectedly')
    this.name = 'AcpInputClosedError'
  }
}

/**
 * ACP 帧不是合法 JSON 或不是合法 JSON-RPC 报文。
 *
 * 错误信息刻意保持稳定且不含原始行：JSON.parse 的报错会把输入片段带进 message，
 * 而 Adapter 原文可能包含 Secret。
 */
export class AcpInvalidFrameError extends Error {
  readonly code = 'ACP_INVALID_FRAME'

  constructor() {
    super('ACP message frame is not a valid JSON-RPC message')
    this.name = 'AcpInvalidFrameError'
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * JSON-RPC ID 判据直接复用 Contract 的唯一合法域。
 *
 * 这里不能放宽到「任意有限 number / 任意 string」：空 string、小数和超安全
 * 整数能进入 Runtime pending，却会在 DTO / SQLite codec 处被丢弃，留下无法
 * 应答的权限请求。
 */
function isRpcId(value: unknown): value is number | string {
  return isJsonRpcRequestId(value)
}

function isRpcError(value: unknown): value is { code: number; message: string; data?: unknown } {
  if (!isJsonRecord(value) || typeof value.code !== 'number' || typeof value.message !== 'string') {
    return false
  }
  return true
}

function isRpcMessage(value: Record<string, unknown>): boolean {
  if (value.jsonrpc !== '2.0') {
    return false
  }
  if ('method' in value) {
    return typeof value.method === 'string' && (!('id' in value) || isRpcId(value.id))
  }
  if (!('id' in value) || !isRpcId(value.id)) {
    return false
  }
  if ('error' in value) {
    return isRpcError(value.error)
  }
  return 'result' in value
}

/** ACP JSON-RPC 客户端的请求处理函数。 */
export type AcpRequestHandler = (request: JsonRpcRequest) => unknown | Promise<unknown>

/** ACP JSON-RPC 通知处理函数。 */
export type AcpNotificationHandler = (notification: JsonRpcNotification) => void

/** JSON-RPC 请求超时错误。 */
export class AcpRequestTimeoutError extends Error {
  readonly code = 'ACP_REQUEST_TIMEOUT'

  constructor(method: string, timeoutMs: number) {
    super(`ACP request timed out: ${method} (${timeoutMs}ms)`)
    this.name = 'AcpRequestTimeoutError'
  }
}

/** JSON-RPC 远端错误。 */
export class AcpRemoteError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(error: { code: number; message: string; data?: unknown }) {
    super(error.message)
    this.name = 'AcpRemoteError'
    this.code = error.code
    this.data = error.data
  }
}

/**
 * 通过 stdio 行协议收发 ACP JSON-RPC 消息。
 *
 * 该类不管理子进程生命周期，只负责 framing、请求关联和消息分发。
 */
export class AcpJsonRpcClient {
  private readonly pending = new Map<number | string, PendingRequest>()
  private readonly readline: Interface
  private readonly notificationHandlers = new Set<AcpNotificationHandler>()
  private readonly maxFrameBytes: number
  private readonly onFatalError: ((error: Error) => void) | undefined
  private requestHandler: AcpRequestHandler | null = null
  private nextRequestId = 1
  private currentFrameBytes = 0
  private closed = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    options: AcpJsonRpcClientOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
    this.onFatalError = options.onFatalError
    this.input.on('data', (chunk: Buffer | string) => this.handleInputChunk(chunk))
    this.readline = createInterface({ input: this.input })
    this.readline.on('line', (line) => this.handleLine(line))
    // 非主动关闭的 stdio 中断（Adapter 半关闭 / 崩溃）必须转成统一 fatal 状态，
    // 否则调用方只能靠子进程退出感知，Context / scope / pending 会一直残留。
    this.input.on('error', (error: Error) => this.failFatal(error))
    this.input.on('close', () => this.failFatal(new AcpInputClosedError()))
  }

  /** 发送请求并等待对应响应。 */
  request<T>(
    method: string,
    params: unknown,
    timeoutMs = 30_000,
    signal?: AbortSignal,
    onSent?: () => void,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('ACP client is closed'))
    }
    if (signal?.aborted === true) {
      return Promise.reject(new AcpRequestAbortedError(method))
    }

    const id = this.nextRequestId++
    const message = {
      jsonrpc: '2.0' as const,
      id,
      method,
      params,
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.rejectRequest(id, new AcpRequestTimeoutError(method, timeoutMs))
      }, timeoutMs)
      const removeAbortListener = signal === undefined
        ? undefined
        : this.addAbortListener(signal, id, method)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        ...(removeAbortListener === undefined ? {} : { removeAbortListener }),
      })
      this.write(message)
      onSent?.()
    })
  }

  private addAbortListener(signal: AbortSignal, id: number, method: string): () => void {
    const handleAbort = (): void => {
      this.rejectRequest(id, new AcpRequestAbortedError(method))
    }
    signal.addEventListener('abort', handleAbort, { once: true })
    return () => signal.removeEventListener('abort', handleAbort)
  }

  private rejectRequest(id: number | string, error: Error): void {
    const pending = this.pending.get(id)
    if (pending === undefined) {
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    pending.reject(error)
  }

  private handleInputChunk(chunk: Buffer | string): void {
    if (this.closed) {
      return
    }
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    for (const byte of bytes) {
      if (byte === 0x0a) {
        this.currentFrameBytes = 0
        continue
      }
      this.currentFrameBytes += 1
      if (this.currentFrameBytes > this.maxFrameBytes) {
        this.failFatal(new AcpOutputLimitError(this.maxFrameBytes))
        return
      }
    }
  }

  private failFatal(error: Error): void {
    if (this.closed) {
      return
    }
    this.input.pause()
    this.closed = true
    this.readline.close()
    this.rejectPending(error)
    this.onFatalError?.(error)
  }

  /** 发送不等待响应的通知。 */
  notify(method: string, params: unknown): void {
    if (this.closed) {
      throw new Error('ACP client is closed')
    }
    this.write({ jsonrpc: '2.0', method, params })
  }

  /** 注册服务端通知处理器。 */
  onNotification(handler: AcpNotificationHandler): () => void {
    this.notificationHandlers.add(handler)
    return () => this.notificationHandlers.delete(handler)
  }

  /** 注册服务端请求处理器。 */
  onRequest(handler: AcpRequestHandler): () => void {
    this.requestHandler = handler
    return () => {
      if (this.requestHandler === handler) {
        this.requestHandler = null
      }
    }
  }

  /** 关闭 framing 层并拒绝未完成请求。 */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.readline.close()
    this.rejectPending(new Error('ACP client closed'))
  }

  private handleLine(line: string): void {
    if (line.trim() === '') {
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(line) as unknown
    } catch {
      // 不转发 JSON.parse 的报错：它会把原始行片段带进错误信息。
      this.failFatal(new AcpInvalidFrameError())
      return
    }
    if (!isJsonRecord(parsed) || !isRpcMessage(parsed)) {
      this.failFatal(new AcpInvalidFrameError())
      return
    }
    const message = parsed as unknown as JsonRpcMessage

    if ('id' in message && ('result' in message || 'error' in message)) {
      this.handleResponse(message)
      return
    }

    if ('id' in message && 'method' in message) {
      void this.handleRequest(message)
      return
    }

    if ('method' in message) {
      for (const handler of this.notificationHandlers) {
        handler(message)
      }
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id)
    if (pending === undefined) {
      return
    }

    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    pending.removeAbortListener?.()
    if (message.error !== undefined) {
      pending.reject(new AcpRemoteError(message.error))
      return
    }
    pending.resolve(message.result)
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    if (this.requestHandler === null) {
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      })
      return
    }

    try {
      const result = await this.requestHandler(message)
      if (this.closed) {
        return
      }
      this.write({ jsonrpc: '2.0', id: message.id, result })
    } catch (error: unknown) {
      // 连接已关闭时不再向 Adapter 写响应，避免写入已回收的 stdio。
      if (this.closed) {
        return
      }
      const messageText = error instanceof Error ? error.message : 'ACP request failed'
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: messageText },
      })
    }
  }

  private write(message: object): void {
    this.output.write(`${JSON.stringify(message)}\n`)
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.removeAbortListener?.()
      pending.reject(error)
    }
  }
}
