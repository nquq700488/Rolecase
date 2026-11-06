import type { FastifyReply, FastifyRequest } from 'fastify'

import { apiErrorSchema, type ApiError } from '@rolecast/contract'

import { ApplicationError, isCodedError } from '../application/errors.js'

/**
 * @name sendApiError
 * @description 按契约 schema 自校验后发送统一错误信封
 * @param {FastifyReply} reply Fastify reply
 * @param {number} status HTTP 状态码
 * @param {ApiError} error 错误信封内容
 * @return {void}
 */
export function sendApiError(reply: FastifyReply, status: number, error: ApiError): void {
  apiErrorSchema.parse(error)
  reply.code(status).send({ ok: false, error })
}

/**
 * @name requestId
 * @description 读取错误信封的 request_id：优先请求头，回退 Fastify 自动 id
 * @param {FastifyRequest} request Fastify request
 * @return {string} request_id
 */
export function requestId(request: FastifyRequest): string {
  const value = request.headers['x-request-id']
  return typeof value === 'string' && value.length > 0 ? value : request.id
}

/**
 * @name rejectEmptyRootPath
 * @description 空字符串属于非法路径值；在 schema 的 min(1) 拒绝前按契约映射为 422 workspace_root_invalid
 * @param {unknown} body 请求体
 * @param {FastifyReply} reply Fastify reply
 * @param {FastifyRequest} request Fastify request
 * @return {boolean} 是否已拦截并发送响应
 */
export function rejectEmptyRootPath(body: unknown, reply: FastifyReply, request: FastifyRequest): boolean {
  if (typeof body !== 'object' || body === null || (body as { readonly root_path?: unknown }).root_path !== '') {
    return false
  }
  sendApiError(reply, 422, {
    code: 'workspace_root_invalid',
    message: '根目录路径无效，请输入本机服务端可访问的现存目录',
    details: {},
    request_id: requestId(request),
  })
  return true
}

/** 按统一错误信封发送 Contract 校验问题。 */
export function sendValidationError(
  reply: FastifyReply,
  request: FastifyRequest,
  issues: readonly { path: PropertyKey[]; message: string }[],
): void {
  sendApiError(reply, 400, {
    code: 'invalid_request',
    message: '请求参数无效',
    details: { issues: issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })) },
    request_id: requestId(request),
  })
}

/** 把 Application 错误及稳定运行时错误转换为统一 API 错误。 */
export function sendMappedError(reply: FastifyReply, request: FastifyRequest, error: unknown): void {
  const mapped = mapError(error, requestId(request))
  sendApiError(reply, mapped.status, mapped.error)
}

function mapError(error: unknown, requestIdValue: string): { status: number; error: ApiError } {
  if (error instanceof ApplicationError) {
    return {
      status: error.statusCode,
      error: { code: error.code, message: error.message, details: error.details, request_id: requestIdValue },
    }
  }
  const code = isCodedError(error) ? error.code : 'internal_error'
  const status = code === 'permission_not_found' ? 404 : code === 'permission_timeout' ? 409 : 500
  return {
    status,
    error: {
      code,
      message: status === 500 ? '服务内部错误' : '请求无法完成',
      details: {},
      request_id: requestIdValue,
    },
  }
}
