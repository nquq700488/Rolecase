import type { CredentialStorePort } from '../../application/ports/credential-store-port.js'
import {
  CredentialDeniedError,
  CredentialIdempotencyConflictError,
  CredentialInvalidError,
  CredentialNotFoundError,
  CredentialStoreUnavailableError,
  isCredentialOperationKeyValid,
  isCredentialValueValid,
} from '../../application/ports/credential-store-port.js'
import { deriveCredentialReference } from './credential-reference.js'
import {
  runSecurityCommand,
  type SecurityCommandResult,
  type SecurityCommandRunner,
} from './security-command-runner.js'

const DEFAULT_SERVICE = 'com.rolecast.credentials.v1'

// security CLI 把 OSStatus 截断成 8 位退出码，这里只保留需要区分分类的取值。
const EXIT_CODE_ITEM_NOT_FOUND = 44
const EXIT_CODE_INTERACTION_NOT_ALLOWED = 36
const EXIT_CODE_AUTH_FAILED = 51

/** macOS Keychain generic-password CredentialStore 实现。 */
export class MacOsKeychainCredentialStore implements CredentialStorePort {
  private static readonly locks = new Map<string, Promise<void>>()

  constructor(
    private readonly runner: SecurityCommandRunner = { run: runSecurityCommand },
    private readonly service = DEFAULT_SERVICE,
  ) {}

  async save(operationKey: string, secret: string): Promise<string> {
    if (!isCredentialOperationKeyValid(operationKey)) {
      throw new CredentialInvalidError()
    }
    this.assertSecret(secret)
    const reference = deriveCredentialReference(operationKey)
    return this.withReferenceLock(reference, async () => {
      const existing = await this.runner.run(this.findArguments(reference, true))
      if (!isNotFoundResult(existing)) {
        assertCommandSuccess(existing)
        if (removeTrailingLineBreak(existing.stdout) !== secret) {
          throw new CredentialIdempotencyConflictError(reference)
        }
        return reference
      }
      // 创建使用不带 `-U` 的 add：Keychain 对已存在条目返回重复项错误，
      // 而不是静默覆盖。这样两个进程同时创建同一条目时，只有一个能成功。
      const created = await this.runner.run(this.createArguments(reference), secret)
      if (created.exitCode === 0) {
        return reference
      }
      // 创建失败可能是并发创建已抢到条目：重读并按 Secret 判定，
      // 只有确实不存在时才把原始失败分类抛出。
      const raced = await this.runner.run(this.findArguments(reference, true))
      if (isNotFoundResult(raced)) {
        assertCommandSuccess(created)
        return reference
      }
      assertCommandSuccess(raced)
      if (removeTrailingLineBreak(raced.stdout) !== secret) {
        throw new CredentialIdempotencyConflictError(reference)
      }
      return reference
    })
  }

  async get(reference: string): Promise<string | null> {
    if (reference.length === 0) {
      return null
    }
    const result = await this.runner.run(this.findArguments(reference, true))
    if (isNotFoundResult(result)) {
      return null
    }
    assertCommandSuccess(result)
    const secret = removeTrailingLineBreak(result.stdout)
    if (!isCredentialValueValid(secret)) {
      throw new CredentialStoreUnavailableError()
    }
    return secret
  }

  async validate(reference: string): Promise<boolean> {
    if (reference.length === 0) {
      return false
    }
    const result = await this.runner.run(this.findArguments(reference, false))
    if (isNotFoundResult(result)) {
      return false
    }
    assertCommandSuccess(result)
    return true
  }

  async rotate(reference: string, secret: string): Promise<void> {
    this.assertSecret(secret)
    await this.withReferenceLock(reference, async () => {
      const existing = await this.runner.run(this.findArguments(reference, false))
      if (isNotFoundResult(existing)) {
        throw new CredentialNotFoundError()
      }
      assertCommandSuccess(existing)
      const result = await this.runner.run(this.updateArguments(reference), secret)
      assertCommandSuccess(result)
    })
  }

  async delete(reference: string): Promise<void> {
    if (reference.length === 0) {
      return
    }
    await this.withReferenceLock(reference, async () => {
      const result = await this.runner.run([
        'delete-generic-password',
        '-a',
        reference,
        '-s',
        this.service,
      ])
      if (isNotFoundResult(result)) {
        return
      }
      assertCommandSuccess(result)
    })
  }

  /** 创建语义：不带 `-U`，条目已存在时命令失败，不会覆盖。 */
  private createArguments(reference: string): string[] {
    return [
      'add-generic-password',
      '-a',
      reference,
      '-s',
      this.service,
      '-w',
    ]
  }

  /** 更新语义：只用于 rotate，引用不变、值替换。 */
  private updateArguments(reference: string): string[] {
    return [
      'add-generic-password',
      '-a',
      reference,
      '-s',
      this.service,
      '-U',
      '-w',
    ]
  }

  private findArguments(reference: string, includeSecret: boolean): string[] {
    return [
      'find-generic-password',
      '-a',
      reference,
      '-s',
      this.service,
      ...(includeSecret ? ['-w'] : []),
    ]
  }

  private assertSecret(secret: string): void {
    if (!isCredentialValueValid(secret)) {
      throw new CredentialInvalidError()
    }
  }

  private async withReferenceLock<T>(reference: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = `${this.service}:${reference}`
    const previous = MacOsKeychainCredentialStore.locks.get(lockKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => current)
    MacOsKeychainCredentialStore.locks.set(lockKey, queued)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (MacOsKeychainCredentialStore.locks.get(lockKey) === queued) {
        MacOsKeychainCredentialStore.locks.delete(lockKey)
      }
    }
  }
}

function assertCommandSuccess(result: SecurityCommandResult): void {
  if (result.exitCode === 0) {
    return
  }
  if (isNotFoundResult(result)) {
    throw new CredentialNotFoundError()
  }
  if (isDeniedResult(result)) {
    throw new CredentialDeniedError()
  }
  throw new CredentialStoreUnavailableError()
}

// 退出码是稳定信号，优先使用；文案只作为无法识别退出码时的兜底。
function isNotFoundResult(result: SecurityCommandResult): boolean {
  if (result.exitCode === EXIT_CODE_ITEM_NOT_FOUND) {
    return true
  }
  if (!isUnrecognizedFailure(result)) {
    return false
  }
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
  return text.includes('could not be found')
    || text.includes('item not found')
    || text.includes('errsecitemnotfound')
}

function isDeniedResult(result: SecurityCommandResult): boolean {
  if (result.exitCode === EXIT_CODE_INTERACTION_NOT_ALLOWED || result.exitCode === EXIT_CODE_AUTH_FAILED) {
    return true
  }
  if (!isUnrecognizedFailure(result)) {
    return false
  }
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase()
  return text.includes('user interaction is not allowed')
    || text.includes('interaction not allowed')
    || text.includes('authorization denied')
    || text.includes('access denied')
    || text.includes('errsecinteractionnotallowed')
    || text.includes('errsecauthfailed')
}

/**
 * 是否只能在文案兜底路径上分类。
 *
 * 成功退出码的 stdout 就是 Secret 原文，绝不能拿它做关键词匹配，否则合法
 * Secret 里出现「could not be found」等普通文本就会被误判为 not found。
 */
function isUnrecognizedFailure(result: SecurityCommandResult): boolean {
  return result.exitCode !== 0 && result.exitCode !== EXIT_CODE_ITEM_NOT_FOUND
    && result.exitCode !== EXIT_CODE_INTERACTION_NOT_ALLOWED
    && result.exitCode !== EXIT_CODE_AUTH_FAILED
}

function removeTrailingLineBreak(value: string): string {
  return value.replace(/\r?\n$/, '')
}
