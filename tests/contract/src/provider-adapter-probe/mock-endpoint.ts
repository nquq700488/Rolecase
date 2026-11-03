import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/** 一次被 mock endpoint 记录的请求（不含请求体与任何凭据）。 */
export interface MockRequestRecord {
  readonly method: string
  readonly path: string
  readonly host: string
  /** 认证来源类别，不记录具体凭据值。 */
  readonly authSource: 'authorization-header' | 'x-api-key-header' | 'none'
  /** 仅记录请求头**名称**，用于判断认证来源；绝不记录取值。 */
  readonly headerNames: readonly string[]
}

/** 本地 mock endpoint：记录 host/path/method 与认证来源类别。 */
export interface MockEndpoint {
  readonly port: number
  readonly baseUrl: string
  readonly requests: readonly MockRequestRecord[]
  /** 清空已记录请求，便于按 case 隔离断言。 */
  reset(): void
  close(): Promise<void>
}

/**
 * @name startMockEndpoint
 * @description 启动只监听 127.0.0.1 的 mock Provider endpoint
 * @param {number} port 端口；传 0 时由系统分配
 * @return {Promise<MockEndpoint>} 可查询命中记录的 mock endpoint
 * @example const mock = await startMockEndpoint(0)
 */
export async function startMockEndpoint(port = 0): Promise<MockEndpoint> {
  const requests: MockRequestRecord[] = []
  const server: Server = createServer((request, response) => {
    requests.push(record(request.method ?? 'GET', request.url ?? '/', request.headers))
    // 只回最小化的 Anthropic/OpenAI 形状，足以让 Adapter 判断为可解析响应。
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  const address = server.address() as AddressInfo

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests
    },
    reset: () => {
      requests.length = 0
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

function record(method: string, url: string, headers: IncomingHttpHeaders): MockRequestRecord {
  // 只记录认证来源类别：绝不保留 header 值本身。
  const authSource = headers.authorization !== undefined
    ? 'authorization-header'
    : headers['x-api-key'] !== undefined
      ? 'x-api-key-header'
      : 'none'
  return {
    method,
    // 只取 pathname：query string 可能携带凭据，不能进入记录或断言输出。
    path: pathnameOf(url),
    host: typeof headers.host === 'string' ? headers.host : '',
    authSource,
    headerNames: Object.keys(headers).sort(),
  }
}

/** 提取 pathname；解析失败时返回固定占位符，绝不回退到原始 URL。 */
function pathnameOf(url: string): string {
  try {
    return new URL(url, 'http://127.0.0.1').pathname
  } catch {
    return '<unparsable-url>'
  }
}
