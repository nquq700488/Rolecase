import { createHash } from 'node:crypto'

const REFERENCE_PREFIX = 'credential-'
const REFERENCE_DOMAIN = 'rolecast.credential.v1:'
const REFERENCE_HASH_LENGTH = 32

/**
 * @name deriveCredentialReference
 * @description 由幂等键推导稳定的凭据引用，使同一创建操作重复提交落在同一条目上
 * @param {string} operationKey 客户端为单次创建操作生成的幂等键
 * @return {string} 形如 `credential-<32 hex>` 的不透明引用
 * @example
 * deriveCredentialReference('7d444840-9dc0-11d1-b245-5ffdce74fad2')
 * // 'credential-3f2a…'
 */
export function deriveCredentialReference(operationKey: string): string {
  // 引用是持久身份：改变域分隔串或摘要截断长度都会让已有引用无法再被重试命中，
  // 因此升级时必须保留旧值或提供迁移，不能静默换算法。
  const digest = createHash('sha256')
    .update(`${REFERENCE_DOMAIN}${operationKey}`, 'utf8')
    .digest('hex')
  return `${REFERENCE_PREFIX}${digest.slice(0, REFERENCE_HASH_LENGTH)}`
}
