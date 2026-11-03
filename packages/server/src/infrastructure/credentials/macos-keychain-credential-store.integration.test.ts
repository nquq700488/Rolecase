import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { MacOsKeychainCredentialStore } from './macos-keychain-credential-store.js'

// 真实 Keychain smoke 默认跳过：只在显式设置 RUN_MACOS_KEYCHAIN_INTEGRATION=1 时运行。
const runIntegration = process.env.RUN_MACOS_KEYCHAIN_INTEGRATION === '1' && process.platform === 'darwin'

/**
 * 断言两个 Secret 相等，失败时不把 Secret 原文带进断言输出。
 */
const sameSecret = (actual: string | null, expected: string): boolean => actual === expected

describe.skipIf(!runIntegration)('MacOsKeychainCredentialStore 真实 Keychain smoke', () => {
  it('save → get → rotate → delete 使用唯一 service 并清理', async () => {
    // 合成 Secret + 唯一 service，避免触碰用户真实凭据。
    const service = `com.rolecast.credentials.test.${randomUUID()}`
    const store = new MacOsKeychainCredentialStore(undefined, service)
    const initialSecret = `synthetic-${randomUUID()}`
    const rotatedSecret = `synthetic-${randomUUID()}`
    let reference: string | null = null

    let cleanupError: unknown = null
    let primaryError: unknown = null
    try {
      reference = await store.save(`smoke-${randomUUID()}`, initialSecret)
      expect(sameSecret(await store.get(reference), initialSecret)).toBe(true)
      expect(await store.validate(reference)).toBe(true)

      await store.rotate(reference, rotatedSecret)
      expect(sameSecret(await store.get(reference), rotatedSecret)).toBe(true)

      await store.delete(reference)
      expect(await store.get(reference)).toBeNull()
      expect(await store.validate(reference)).toBe(false)
      reference = null
    } catch (error: unknown) {
      primaryError = error
    } finally {
      // 尽力清理，但不吞掉失败：残留会在真实 Keychain 里可见，必须让测试失败。
      if (reference !== null) {
        cleanupError = await store.delete(reference).then(
          () => null,
          (error: unknown) => error ?? new Error('unknown cleanup failure'),
        )
      }
    }
    if (cleanupError !== null) {
      // 清理失败与主测试异常同时发生时，两者都要报告，避免清理失败被主异常掩盖。
      // 只输出错误类型名与非敏感的唯一 service 标识，不打印 Secret 或存储内容。
      const cleanupName = cleanupError instanceof Error ? cleanupError.name : typeof cleanupError
      const primaryName = primaryError instanceof Error ? primaryError.name : typeof primaryError
      const primarySuffix = primaryError === null ? '' : `; primary=${primaryName}`
      throw new Error(
        `真实 Keychain smoke 清理失败，请手动删除 service=${service} 下的测试条目（cleanup=${cleanupName}${primarySuffix}）`,
      )
    }
    if (primaryError !== null) {
      throw primaryError
    }
  }, 60_000)
})
