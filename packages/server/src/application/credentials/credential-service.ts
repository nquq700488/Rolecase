import { ApplicationError } from '../errors.js'
import type { CredentialStorePort } from '../ports/credential-store-port.js'
import {
  CredentialDeniedError,
  CredentialIdempotencyConflictError,
  CredentialInvalidError,
  CredentialStoreUnavailableError,
} from '../ports/credential-store-port.js'

/** 创建凭据用例的输入。 */
export interface CreateCredentialInput {
  /** 客户端为单次创建操作生成的幂等键，不是链路追踪 ID。 */
  readonly idempotencyKey: string
  /** API key 原文；只在本次调用内存在，不进入任何持久化结构。 */
  readonly secret: string
}

/** 创建凭据用例的输出：只有不透明引用，不回显 Secret。 */
export interface CreateCredentialResult {
  readonly credential_ref: string
}

/** 凭据创建用例；不读取、不回显、不缓存 Secret。 */
export class CredentialService {
  constructor(private readonly credentialStore: CredentialStorePort) {}

  /**
   * @name create
   * @description 把 API key 写入 CredentialStore，返回可用的 credential_ref
   * @param {CreateCredentialInput} input 幂等键与 Secret
   * @return {Promise<CreateCredentialResult>} 不透明凭据引用
   * @example
   * await service.create({ idempotencyKey, secret: apiKey })
   * // { credential_ref: 'credential-…' }
   */
  async create(input: CreateCredentialInput): Promise<CreateCredentialResult> {
    try {
      // save 内部保证同一幂等键 + 同一 Secret 返回同一引用；同键异值抛冲突。
      const reference = await this.credentialStore.save(input.idempotencyKey, input.secret)
      return { credential_ref: reference }
    } catch (error: unknown) {
      throw mapCredentialError(error)
    }
  }
}

function mapCredentialError(error: unknown): unknown {
  if (error instanceof CredentialInvalidError) {
    return new ApplicationError('凭据无效', 'credential_invalid', 422)
  }
  if (error instanceof CredentialDeniedError) {
    return new ApplicationError('凭据访问被拒绝', 'credential_denied', 403)
  }
  if (error instanceof CredentialStoreUnavailableError) {
    return new ApplicationError('凭据存储不可用', 'credentials_unavailable', 503)
  }
  if (error instanceof CredentialIdempotencyConflictError) {
    // 引用不是 Secret：回传它，调用方才能继续使用已保存的凭据而不是重新创建。
    return new ApplicationError(
      '同一幂等键已保存过不同的凭据',
      'credential_idempotency_conflict',
      409,
      { credential_ref: error.credentialRef },
    )
  }
  // 未知错误原样上抛，交给统一错误路径，不能伪装成成功。
  return error
}
