import { randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_BYTES = 32

/** 进程内 Local Token 服务，不把 Token 写入 SQLite。 */
export class LocalTokenService {
  private readonly token: Buffer

  constructor(token?: string) {
    this.token = token === undefined ? randomBytes(TOKEN_BYTES) : Buffer.from(token, 'utf8')
  }

  /** 返回仅供启动入口拼接 URL fragment 的 Token。 */
  value(): string {
    return this.token.toString('base64url')
  }

  /** 常量时间比较 REST/WS 提交的 Token。 */
  matches(candidate: string): boolean {
    const bytes = Buffer.from(candidate, 'base64url')
    return bytes.length === this.token.length && timingSafeEqual(bytes, this.token)
  }

  /** 构造本地 Web 入口；Token 只放在 fragment。 */
  webEntryUrl(origin: string): string {
    const url = new URL(origin)
    url.hash = `token=${encodeURIComponent(this.value())}`
    return url.toString()
  }
}
