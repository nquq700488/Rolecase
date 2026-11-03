import { describe, expect, it } from 'vitest'

import { CredentialStoreUnavailableError } from '../../application/ports/credential-store-port.js'
import { createSecurityCommandRunner } from './security-command-runner.js'

describe('SecurityCommandRunner', () => {
  it('通过管道把输入写成两行相同值并读取无 TTY 子进程结果', async () => {
    const runner = createSecurityCommandRunner(process.execPath)
    const script = "let value=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => value += chunk); process.stdin.on('end', () => process.stdout.write(value))"

    await expect(runner.run(['-e', script], 'test-secret')).resolves.toMatchObject({
      exitCode: 0,
      stdout: 'test-secret\ntest-secret\n',
    })
  })

  it('超时、输出超限和 spawn 失败都会清理并返回稳定错误', async () => {
    const timeoutRunner = createSecurityCommandRunner(process.execPath, { timeoutMs: 30 })
    await expect(timeoutRunner.run(['-e', 'setTimeout(() => {}, 5000)']))
      .rejects.toBeInstanceOf(CredentialStoreUnavailableError)

    const outputRunner = createSecurityCommandRunner(process.execPath, { maxOutputBytes: 32 })
    await expect(outputRunner.run(['-e', "process.stdout.write('x'.repeat(1024))"]))
      .rejects.toBeInstanceOf(CredentialStoreUnavailableError)

    const missingRunner = createSecurityCommandRunner('/path/that/does/not/exist')
    await expect(missingRunner.run([])).rejects.toBeInstanceOf(CredentialStoreUnavailableError)
  })
})
