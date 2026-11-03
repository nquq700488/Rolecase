import { createHash } from 'node:crypto'

/**
 * @name digestMessageContent
 * @description 计算用户输入的不可逆摘要，用于判定同一 request_id 是否被换成了不同输入
 * @param {string} content 原始用户消息文本
 * @return {string} 64 位十六进制 SHA-256 摘要
 * @example
 * digestMessageContent('继续工作') // 'c0f0…'
 */
export function digestMessageContent(content: string): string {
  // 纯函数、无 I/O：只用于回执比较，不落原文、不进入公共 DTO。
  return createHash('sha256').update(content, 'utf8').digest('hex')
}
