import { describe, expect, it } from 'vitest'

import { ensureAdapterExited, type ClosableAdapter } from './adapter-cleanup.js'

/** 构造一个可控的 Adapter 桩：close 行为与退出时机由用例决定。 */
const createAdapter = (options: {
  close?: () => Promise<void>
  exited?: Promise<unknown>
  pid?: number
}): ClosableAdapter => ({
  pid: options.pid ?? 1,
  exited: options.exited ?? Promise.resolve({ code: 0, signal: null }),
  close: options.close ?? (async () => undefined),
})

describe('ensureAdapterExited', () => {
  it('close 正常时报告已退出且无错误', async () => {
    const result = await ensureAdapterExited(createAdapter({}))
    expect(result).toEqual({ exited: true, error: null })
  })

  it('close 拒绝时强制回收并确认退出', async () => {
    const kills: number[] = []
    const result = await ensureAdapterExited(
      createAdapter({ close: async () => { throw new Error('close failed') } }),
      { kill: (adapter) => kills.push(adapter.pid) },
    )

    expect(kills).toEqual([1])
    // 进程确认退出后仍报告错误，调用方据此让 Probe 失败。
    expect(result.exited).toBe(true)
    expect(result.error?.message).toBe('close failed')
  })

  it('close 拒绝且进程不退出时报告未退出，调用方应保留目录', async () => {
    const neverExits = new Promise<never>(() => undefined)
    const result = await ensureAdapterExited(
      createAdapter({
        close: async () => { throw new Error('close failed') },
        exited: neverExits,
      }),
      { kill: () => undefined, timeoutMs: 50 },
    )

    expect(result.exited).toBe(false)
    expect(result.error?.message).toBe('close failed')
  })

  it('close 成功但进程迟迟不退出时也不会无限等待', async () => {
    const neverExits = new Promise<never>(() => undefined)
    const started = Date.now()
    const result = await ensureAdapterExited(
      createAdapter({ exited: neverExits }),
      { timeoutMs: 50 },
    )

    expect(result.exited).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('close 永不 settle 时有界超时后强制回收', async () => {
    const kills: number[] = []
    const neverSettles = new Promise<void>(() => undefined)
    const started = Date.now()
    const result = await ensureAdapterExited(
      createAdapter({ close: () => neverSettles }),
      { timeoutMs: 50, kill: (adapter) => kills.push(adapter.pid) },
    )

    // 不能因为 close 挂起就永远等待；超时后必须强制回收并确认退出。
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(kills).toEqual([1])
    expect(result.exited).toBe(true)
    expect(result.error).not.toBeNull()
  })

  it('close 永不 settle 且进程不退出时返回 exited=false', async () => {
    const neverSettles = new Promise<void>(() => undefined)
    const neverExits = new Promise<never>(() => undefined)
    const result = await ensureAdapterExited(
      createAdapter({ close: () => neverSettles, exited: neverExits }),
      { timeoutMs: 50, kill: () => undefined },
    )

    expect(result.exited).toBe(false)
    expect(result.error).not.toBeNull()
  })

  it('close 与强制 kill 都失败时聚合报告两个错误', async () => {
    const result = await ensureAdapterExited(
      createAdapter({ close: async () => { throw new Error('close failed') } }),
      { kill: () => { throw new Error('kill failed') } },
    )

    expect(result.exited).toBe(true)
    expect(result.error?.message).toContain('close failed')
    expect(result.error?.message).toContain('kill failed')
  })
})
