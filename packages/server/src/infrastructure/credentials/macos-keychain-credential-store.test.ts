import { describe, expect, it } from 'vitest'

import {
  CredentialDeniedError,
  CredentialIdempotencyConflictError,
  CredentialInvalidError,
  CredentialNotFoundError,
  CredentialStoreUnavailableError,
} from '../../application/ports/credential-store-port.js'
import type {
  SecurityCommandResult,
  SecurityCommandRunner,
} from './security-command-runner.js'
import { deriveCredentialReference } from './credential-reference.js'
import { MacOsKeychainCredentialStore } from './macos-keychain-credential-store.js'

class ScriptedRunner implements SecurityCommandRunner {
  readonly calls: Array<{ args: readonly string[]; input?: string }> = []

  constructor(private readonly responses: SecurityCommandResult[]) {}

  async run(args: readonly string[], input?: string): Promise<SecurityCommandResult> {
    this.calls.push({ args, ...(input === undefined ? {} : { input }) })
    const response = this.responses.shift()
    if (response === undefined) {
      throw new Error('missing scripted response')
    }
    return response
  }
}

const ok = (stdout = ''): SecurityCommandResult => ({ exitCode: 0, stdout, stderr: '' })
const missing = (): SecurityCommandResult => ({
  exitCode: 1,
  stdout: '',
  stderr: 'The specified item could not be found in the keychain.',
})

describe('MacOsKeychainCredentialStore', () => {
  it('通过 stdin 传递 Secret，argv 不包含 Secret', async () => {
    const runner = new ScriptedRunner([missing(), ok()])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    const reference = await store.save('operation-a', 'test-secret')

    expect(reference).toBe(deriveCredentialReference('operation-a'))
    expect(runner.calls[0]?.args).toEqual([
      'find-generic-password',
      '-a',
      reference,
      '-s',
      'test.service',
      '-w',
    ])
    // 创建不带 `-U`：条目已存在时命令失败，避免跨进程静默覆盖。
    expect(runner.calls[1]?.args).toEqual([
      'add-generic-password',
      '-a',
      reference,
      '-s',
      'test.service',
      '-w',
    ])
    expect(runner.calls[1]?.args.join(' ')).not.toContain('test-secret')
    expect(runner.calls[1]?.input).toBe('test-secret')
  })

  it('并发创建已抢到同值条目时重读并返回同一引用', async () => {
    const runner = new ScriptedRunner([
      missing(),
      { exitCode: 1, stdout: '', stderr: 'The specified item already exists.' },
      ok('test-secret\n'),
    ])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    const reference = await store.save('operation-race', 'test-secret')

    expect(reference).toBe(deriveCredentialReference('operation-race'))
    expect(runner.calls).toHaveLength(3)
    expect(runner.calls[2]?.args[0]).toBe('find-generic-password')
  })

  it('并发创建已抢到异值条目时返回冲突并回传既有引用', async () => {
    const runner = new ScriptedRunner([
      missing(),
      { exitCode: 1, stdout: '', stderr: 'The specified item already exists.' },
      ok('another-secret\n'),
    ])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    await expect(store.save('operation-race', 'test-secret')).rejects.toMatchObject({
      name: 'CredentialIdempotencyConflictError',
      credentialRef: deriveCredentialReference('operation-race'),
    })
    expect(runner.calls).toHaveLength(3)
  })

  it('创建失败且重读仍不存在时按原失败分类', async () => {
    const runner = new ScriptedRunner([
      missing(),
      { exitCode: 36, stdout: '', stderr: 'User interaction is not allowed.' },
      missing(),
    ])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    await expect(store.save('operation-race', 'test-secret')).rejects.toBeInstanceOf(CredentialDeniedError)
  })

  it('同一幂等键与同一 Secret 返回既有引用且不重复写入', async () => {
    const runner = new ScriptedRunner([ok('test-secret\n')])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    const reference = await store.save('operation-a', 'test-secret')

    expect(reference).toBe(deriveCredentialReference('operation-a'))
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.args[0]).toBe('find-generic-password')
  })

  it('同一幂等键与不同 Secret 拒绝覆盖且不写入', async () => {
    const runner = new ScriptedRunner([ok('another-secret\n')])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    await expect(store.save('operation-a', 'test-secret'))
      .rejects.toBeInstanceOf(CredentialIdempotencyConflictError)
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.args[0]).toBe('find-generic-password')
  })

  it('写入成功但命令超时后，同一幂等键重试不产生第二份凭据', async () => {
    const runner = new WriteThenFailRunner()
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    // 命令被超时杀掉时无法判断是否已写入，调用方看到不可用错误。
    await expect(store.save('operation-retry', 'test-secret'))
      .rejects.toBeInstanceOf(CredentialStoreUnavailableError)

    // 重试先读后写：读到已写入的同值条目，直接返回同一引用，不再执行 add。
    const reference = await store.save('operation-retry', 'test-secret')

    expect(reference).toBe(deriveCredentialReference('operation-retry'))
    expect(runner.accounts.size).toBe(1)
  })

  it('拒绝包含行分隔符的 Secret 和非法幂等键，不执行命令', async () => {
    const runner = new ScriptedRunner([])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    await expect(store.save('operation-a', 'test-secret\nsecond-line')).rejects.toBeInstanceOf(CredentialInvalidError)
    await expect(store.save('operation-a\r', 'test-secret')).rejects.toBeInstanceOf(CredentialInvalidError)
    await expect(store.save('', 'test-secret')).rejects.toBeInstanceOf(CredentialInvalidError)
    await expect(store.rotate('credential-001', 'test-secret\rsecond-line')).rejects.toBeInstanceOf(CredentialInvalidError)
    expect(runner.calls).toHaveLength(0)
  })

  it('优先按 exit code 分类，忽略无法识别的文案', async () => {
    const notFound = new ScriptedRunner([{ exitCode: 44, stdout: '', stderr: 'unknown failure' }])
    await expect(new MacOsKeychainCredentialStore(notFound, 'test.service').rotate('credential-001', 'test-secret'))
      .rejects.toBeInstanceOf(CredentialNotFoundError)

    const denied = new ScriptedRunner([{ exitCode: 36, stdout: '', stderr: 'unknown failure' }])
    await expect(new MacOsKeychainCredentialStore(denied, 'test.service').rotate('credential-001', 'test-secret'))
      .rejects.toBeInstanceOf(CredentialDeniedError)

    const authFailed = new ScriptedRunner([{ exitCode: 51, stdout: '', stderr: 'unknown failure' }])
    await expect(new MacOsKeychainCredentialStore(authFailed, 'test.service').rotate('credential-001', 'test-secret'))
      .rejects.toBeInstanceOf(CredentialDeniedError)

    const unavailable = new ScriptedRunner([{ exitCode: 1, stdout: '', stderr: 'unknown failure' }])
    await expect(new MacOsKeychainCredentialStore(unavailable, 'test.service').rotate('credential-001', 'test-secret'))
      .rejects.toBeInstanceOf(CredentialStoreUnavailableError)
  })

  it('无法识别的 exit code 仍按文案兜底分类', async () => {
    const notFound = new ScriptedRunner([{
      exitCode: 1,
      stdout: '',
      stderr: 'The specified item could not be found in the keychain.',
    }])
    await expect(new MacOsKeychainCredentialStore(notFound, 'test.service').rotate('credential-001', 'test-secret'))
      .rejects.toBeInstanceOf(CredentialNotFoundError)
  })

  it('成功退出码不扫描输出，Secret 含 not found 文案时仍正常返回', async () => {
    const secret = 'value-could not be found-in-secret'
    const runner = new ScriptedRunner([ok(`${secret}\n`), ok(`${secret}\n`)])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    // 断言布尔结果，避免失败输出打印 Secret 原文。
    expect((await store.get('credential-001')) === secret).toBe(true)
    expect(await store.validate('credential-001')).toBe(true)
  })

  it('已识别退出码优先于冲突文案', async () => {
    const conflict = new ScriptedRunner([{
      exitCode: 44,
      stdout: 'The specified item could not be found in the keychain.',
      stderr: 'User interaction is not allowed.',
    }])
    await expect(new MacOsKeychainCredentialStore(conflict, 'test.service').rotate('credential-001', 'test-secret'))
      .rejects.toBeInstanceOf(CredentialNotFoundError)
  })

  it('区分 get、validate、delete 并保持 Secret 不进入命令参数', async () => {
    const runner = new ScriptedRunner([ok('test-secret\n'), ok('metadata'), ok()])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    await expect(store.get('credential-001')).resolves.toBe('test-secret')
    await expect(store.validate('credential-001')).resolves.toBe(true)
    await expect(store.delete('credential-001')).resolves.toBeUndefined()
    expect(runner.calls[0]?.args).not.toContain('test-secret')
    expect(runner.calls[1]?.args).not.toContain('-w')
  })

  it('未知引用 rotate 不会执行更新命令', async () => {
    const runner = new ScriptedRunner([missing()])
    const store = new MacOsKeychainCredentialStore(runner, 'test.service')

    await expect(store.rotate('missing', 'test-secret')).rejects.toBeInstanceOf(CredentialNotFoundError)
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]?.args[0]).toBe('find-generic-password')
  })

  it('区分访问拒绝和超限输出', async () => {
    const denied = new ScriptedRunner([{
      exitCode: 1,
      stdout: '',
      stderr: 'User interaction is not allowed.',
    }])
    const deniedStore = new MacOsKeychainCredentialStore(denied, 'test.service')
    await expect(deniedStore.get('credential-001')).rejects.toBeInstanceOf(CredentialDeniedError)

    const oversized = new ScriptedRunner([ok(`${'x'.repeat(64 * 1024 + 1)}\n` )])
    const oversizedStore = new MacOsKeychainCredentialStore(oversized, 'test.service')
    await expect(oversizedStore.get('credential-001')).rejects.toBeInstanceOf(CredentialStoreUnavailableError)
  })

  it('不同 Store 实例对同一引用使用进程级串行锁', async () => {
    const runner = new ConcurrencyRunner()
    const first = new MacOsKeychainCredentialStore(runner, 'test.service')
    const second = new MacOsKeychainCredentialStore(runner, 'test.service')

    await Promise.all([
      first.rotate('credential-001', 'first-secret'),
      second.rotate('credential-001', 'second-secret'),
    ])

    expect(runner.maxInFlight).toBe(1)
  })
})

/**
 * 模拟「Keychain 已写入，但命令超时被杀」：首次 add 记录 account 后抛超时，
 * 后续 find 能读到已写入的值。
 */
class WriteThenFailRunner implements SecurityCommandRunner {
  readonly accounts = new Set<string>()
  private stored: string | null = null
  private failed = false

  async run(args: readonly string[], input?: string): Promise<SecurityCommandResult> {
    if (args[0] === 'find-generic-password') {
      return this.stored === null ? missing() : ok(`${this.stored}\n`)
    }
    const accountIndex = args.indexOf('-a')
    this.accounts.add(args[accountIndex + 1] ?? '')
    this.stored = input ?? ''
    if (!this.failed) {
      this.failed = true
      throw new CredentialStoreUnavailableError()
    }
    return ok()
  }
}

class ConcurrencyRunner implements SecurityCommandRunner {
  inFlight = 0
  maxInFlight = 0

  async run(args: readonly string[]): Promise<SecurityCommandResult> {
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.inFlight -= 1
    return args[0] === 'find-generic-password' ? ok('metadata') : ok()
  }
}
