import process from 'node:process'

import { describe, expect, it } from 'vitest'

import { AcpProcess } from './acp-process.js'

describe('AcpProcess', () => {
  it('启动子进程并暴露 stdio', async () => {
    const acpProcess = await AcpProcess.start({
      command: process.execPath,
      args: ['-e', 'process.stdin.resume()'],
      cwd: process.cwd(),
      env: { ...process.env, ROLECAST_TEST_CHILD: '1' },
    })

    expect(acpProcess.pid).toBeGreaterThan(0)
    expect(acpProcess.stdin).toBeDefined()
    expect(acpProcess.stdout).toBeDefined()
    await acpProcess.close()
    await expect(acpProcess.exited).resolves.toBeDefined()
  })

  it('close 可重复调用并最终回收子进程', async () => {
    const acpProcess = await AcpProcess.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      cwd: process.cwd(),
      env: process.env,
    })

    await acpProcess.close()
    await acpProcess.close()

    const exit = await acpProcess.exited
    expect(exit.code === null || typeof exit.code === 'number').toBe(true)
  })

  it('父 Adapter 先退出时仍回收同一进程组的子进程', async () => {
    const script = [
      "const { spawn } = require('node:child_process')",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => undefined, 10000)\"])",
      "process.stdout.write(String(child.pid) + '\\n')",
      "setTimeout(() => process.exit(0), 40)",
    ].join(';')
    const acpProcess = await AcpProcess.start({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: process.env,
    })
    const childPid = await new Promise<number>((resolve) => {
      acpProcess.stdout.once('data', (value: Buffer) => resolve(Number(value.toString().trim())))
    })

    try {
      const closePromise = acpProcess.close()
      await acpProcess.exited
      await closePromise
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      let alive = true
      try {
        process.kill(childPid, 0)
      } catch {
        alive = false
      }
      expect(alive).toBe(false)
    } finally {
      try {
        process.kill(childPid, 'SIGKILL')
      } catch {
        // 子进程已经被回收时无需再次处理。
      }
    }
  })

  it('持续写入 stderr 时不会因未消费 pipe 阻塞退出', async () => {
    const script = "process.stderr.write('x'.repeat(4 * 1024 * 1024)); process.exit(0)"
    const acpProcess = await AcpProcess.start({
      command: process.execPath,
      args: ['-e', script],
      cwd: process.cwd(),
      env: process.env,
    })

    try {
      await expect(Promise.race([
        acpProcess.exited,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stderr drain timeout')), 2_000)),
      ])).resolves.toBeDefined()
    } finally {
      await acpProcess.close()
    }
  })
})
