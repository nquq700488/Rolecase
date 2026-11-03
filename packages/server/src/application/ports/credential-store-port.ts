/** CredentialStore 接受的 Secret UTF-8 最大字节数。 */
export const MAX_CREDENTIAL_BYTES = 64 * 1024

/** 判断 Secret 是否在公共大小上限内。 */
export function isCredentialSizeValid(secret: string): boolean {
  return new TextEncoder().encode(secret).byteLength <= MAX_CREDENTIAL_BYTES
}

/**
 * @name isCredentialValueValid
 * @description 判断 Secret 是否满足所有 CredentialStore 实现共用的取值契约
 * @param {string} secret 待校验的 Secret
 * @return {boolean} 非空、不超限且不含行分隔符时为 true
 * @example
 * isCredentialValueValid('sk-test') // true
 * isCredentialValueValid('line1\nline2') // false
 */
export function isCredentialValueValid(secret: string): boolean {
  // 行分隔符会破坏按行传递 Secret 的写入协议，所有后端统一拒绝以保证契约一致。
  return secret.length > 0 && !/[\r\n]/.test(secret) && isCredentialSizeValid(secret)
}

/** 幂等键最大长度；键只用于推导引用，不承载秘密。 */
export const MAX_CREDENTIAL_OPERATION_KEY_LENGTH = 128

/**
 * @name isCredentialOperationKeyValid
 * @description 判断幂等键是否可用于推导稳定的凭据引用
 * @param {string} operationKey 客户端为单次创建操作生成的键
 * @return {boolean} 非空、不超长且不含行分隔符时为 true
 * @example
 * isCredentialOperationKeyValid('7d444840-9dc0-11d1-b245-5ffdce74fad2') // true
 */
export function isCredentialOperationKeyValid(operationKey: string): boolean {
  return operationKey.length > 0
    && operationKey.length <= MAX_CREDENTIAL_OPERATION_KEY_LENGTH
    && !/[\r\n]/.test(operationKey)
}

/** 幂等键已用于保存另一份 Secret：拒绝覆盖，并带回可继续使用的既有引用。 */
export class CredentialIdempotencyConflictError extends Error {
  readonly code = 'credential_idempotency_conflict'

  /**
   * @param {string} credentialRef 既有条目引用；它不是 Secret，调用方可用它恢复配置
   */
  constructor(readonly credentialRef: string) {
    super('同一幂等键已保存过不同的 Secret')
    this.name = 'CredentialIdempotencyConflictError'
  }
}

/** 凭据引用不存在。 */
export class CredentialNotFoundError extends Error {
  readonly code = 'credential_not_found'

  constructor() {
    super('凭据引用不存在')
    this.name = 'CredentialNotFoundError'
  }
}

/** Keychain 或系统凭据服务明确拒绝访问。 */
export class CredentialDeniedError extends Error {
  readonly code = 'credential_denied'

  constructor() {
    super('凭据访问被拒绝')
    this.name = 'CredentialDeniedError'
  }
}

/** 凭据输入不符合要求。 */
export class CredentialInvalidError extends Error {
  readonly code = 'credential_invalid'

  constructor() {
    super('凭据无效')
    this.name = 'CredentialInvalidError'
  }
}

/** 凭据存储不可用。 */
export class CredentialStoreUnavailableError extends Error {
  readonly code = 'credentials_unavailable'

  constructor() {
    super('凭据存储不可用')
    this.name = 'CredentialStoreUnavailableError'
  }
}

/** 凭据存储边界；调用者只在 Adapter 启动的短生命周期内取得原文。 */
export interface CredentialStorePort {
  /**
   * 以幂等键保存 Secret，返回稳定引用。
   *
   * 条目不存在则创建；已存在且 Secret 相同则返回既有引用（安全重试）；
   * 已存在且 Secret 不同则抛 `CredentialIdempotencyConflictError`，**绝不覆盖**——
   * 覆盖会让创建入口隐式具备轮换能力。
   */
  save(operationKey: string, secret: string): Promise<string>
  /** 按引用读取原文。 */
  get(reference: string): Promise<string | null>
  /** 检查引用是否存在，不返回凭据原文。 */
  validate(reference: string): Promise<boolean>
  /** 在不改变引用的前提下替换凭据。 */
  rotate(reference: string, secret: string): Promise<void>
  /** 删除凭据。 */
  delete(reference: string): Promise<void>
}

/** 对日志、错误和事件进行秘密脱敏的边界。 */
export interface SecretRedactionPort {
  /** 生成只用于运行时等值匹配的单向指纹，不返回或保存 Secret 原文。 */
  fingerprint(secret: string): string
  /** 将可能包含秘密的文本替换为固定标记。 */
  redact(value: string): string
  /** 递归脱敏事件和日志结构，保持字段形状。 */
  redactRecord(
    value: Readonly<Record<string, unknown>>,
    secretFingerprints?: readonly string[],
  ): Readonly<Record<string, unknown>>
  /**
   * 为一次 Adapter 连接创建只在连接期间持有 Secret 的脱敏 scope。
   *
   * 空 Secret fail-closed；scope 不序列化、不写日志、不进入 Runtime Event。
   */
  createScope(secret: string): SecretRedactionScope
}

/**
 * 文本流窗口扣住的安全尾部。
 *
 * 尾部一定是 Secret 的**真前缀**，因此单独出现时不构成完整 Secret；按字段路径
 * 分别返回，绝不把不同路径的尾部拼成一段文本。
 */
export interface SecretStreamTail {
  /** 产生该尾部的字段路径，例如 `text` 或 `content.0.text`。 */
  readonly path: string
  /**
   * 调用方传入的不透明归属标签（Runtime 传入事件 kind）。
   *
   * 尾部跨越不同归属的 chunk 时为 null，表示无法证明唯一归属，调用方必须丢弃。
   */
  readonly owner: string | null
  /** 被窗口扣住的文本片段。 */
  readonly text: string
}

/**
 * 短生命周期 Secret 脱敏 scope。
 *
 * scope 通过闭包持有 Secret 原文，只用于精确子串脱敏；按 Session 文本流维护
 * 「最长 Secret 前缀后缀窗口」，使跨 ACP message chunk 的 Secret 不会出现在
 * 任何已 yield 的 Runtime Event 中。
 */
export interface SecretRedactionScope {
  /** 直接脱敏一段文本，不参与流窗口。 */
  redact(value: string): string
  /** 递归脱敏任意结构，字符串按直接脱敏处理，不参与流窗口。 */
  redactValue(value: unknown): unknown
  /**
   * 按指定文本流脱敏：只有 `text` 字段参与跨 chunk 窗口，其余字段直接脱敏。
   *
   * `owner` 是不透明归属标签（Runtime 传入事件 kind），随窗口记录并在 flush 时原样返回。
   */
  redactStreamRecord(value: unknown, streamId: string, owner?: string): unknown
  /**
   * turn 正常结束：按字段路径分别返回并清空该流的待定尾部。
   *
   * 返回结构保留字段路径，调用方不得把不同路径的尾部拼接成一段普通文本。
   */
  flushStream(streamId: string): readonly SecretStreamTail[]
  /** 取消 / 异常 / 关闭：丢弃该流的窗口，不返回任何尾部。 */
  dropStream(streamId: string): void
  /** 幂等释放 Secret 引用；释放后所有脱敏调用 fail-closed。 */
  close(): void
}
