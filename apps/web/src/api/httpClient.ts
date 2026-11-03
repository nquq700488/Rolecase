import axios, { isAxiosError } from 'axios'
import { z } from 'zod'

import { apiErrorSchema } from '@rolecast/contract'

/** 统一的 Web API 错误。 */
export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly requestId: string | null,
    /** 服务端返回的结构化详情；只含非秘密信息，例如冲突时的既有引用。 */
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'ApiClientError'
  }
}

const client = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '',
  timeout: 10_000,
})

client.interceptors.request.use((config) => {
  const token = getLocalToken()
  const requestId = crypto.randomUUID()
  const headers = config.headers
  headers.set('X-Request-Id', requestId)
  if (token !== null) {
    headers.set('Authorization', `Bearer ${token}`)
  }
  return config
})

/**
 * @name apiRequest
 * @description 通过统一 axios 实例发起请求并在边界校验响应 Schema
 * @param {object} config axios 请求配置
 * @param {z.ZodType<T>} schema 成功数据 Schema
 * @return {Promise<T>} 校验后的数据
 */
export async function apiRequest<T>(
  config: Parameters<typeof client.request>[0],
  schema: z.ZodType<T>,
): Promise<T> {
  try {
    const response = await client.request<unknown>(config)
    const envelope = z.object({ ok: z.literal(true), data: schema }).strict().safeParse(response.data)
    if (!envelope.success) {
      throw new ApiClientError('服务响应格式无效', 'invalid_response', response.status, null)
    }
    return envelope.data.data
  } catch (error: unknown) {
    if (error instanceof ApiClientError) {
      throw error
    }
    throw normalizeAxiosError(error)
  }
}

/** 读取当前 Web 会话的 Local Token。 */
export function getLocalToken(): string | null {
  if (typeof window === 'undefined') {
    return null
  }
  const hashParams = new URLSearchParams(window.location.hash.slice(1))
  const hashToken = hashParams.get('token')
  if (hashToken !== null && hashToken.length > 0) {
    window.sessionStorage.setItem('rolecast.local_token', hashToken)
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}`)
    return hashToken
  }
  return window.sessionStorage.getItem('rolecast.local_token')
}

const normalizeAxiosError = (error: unknown): ApiClientError => {
  if (isAxiosError(error)) {
    const data: unknown = error.response?.data
    if (typeof data === 'object' && data !== null && 'error' in data) {
      const parsed = apiErrorSchema.safeParse(data.error)
      if (parsed.success) {
        return new ApiClientError(
          parsed.data.message,
          parsed.data.code,
          error.response?.status ?? 0,
          parsed.data.request_id,
          parsed.data.details,
        )
      }
    }
    return new ApiClientError('无法连接到 Rolecast Server', 'network_error', error.response?.status ?? 0, null)
  }
  return new ApiClientError('请求失败', 'internal_error', 0, null)
}
