/** Application 层可映射为稳定 API 错误的异常。 */
export class ApplicationError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message)
    this.name = 'ApplicationError'
  }
}

/**
 * @name isCodedError
 * @description 判断异常是否携带可作为 API 错误码的稳定 code
 * @param {unknown} error 待判断的异常
 * @param {string} [code] 传入时同时要求 code 相等
 * @return {boolean} 携带合法 code（且与传入 code 相等）时为 true
 * @example
 * isCodedError(error, 'credential_environment_mismatch') // true
 */
export function isCodedError(error: unknown, code?: string): error is { code: string } {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') {
    return false
  }
  // Node/Adapter 的系统错误码（如 ENOENT）不是可直接返回的 API 错误码。
  if (!/^[a-z][a-z0-9_]*$/.test(error.code)) {
    return false
  }
  return code === undefined || error.code === code
}
