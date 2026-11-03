import { describe, expect, it, vi } from 'vitest'

import { decideCleanup, waitForStatusNotification } from './probe-window.js'

describe('decideCleanup', () => {
  it('只有确认退出且无错误时才允许删除目录', () => {
    expect(decideCleanup({ exited: true, error: null }))
      .toEqual({ keepDirectory: false, reason: null })
  })

  it('进程未退出时保留目录', () => {
    expect(decideCleanup({ exited: false, error: null }))
      .toEqual({ keepDirectory: true, reason: 'adapter_did_not_exit' })
  })

  it('退出但清理报错时同样保留目录（强制回收/超时也是诊断材料）', () => {
    expect(decideCleanup({ exited: true, error: new Error('forced kill') }))
      .toEqual({ keepDirectory: true, reason: 'cleanup_reported_error' })
  })
})

describe('waitForStatusNotification', () => {
  it('已有通知时立即返回', async () => {
    const sleep = vi.fn(async () => undefined)
    expect(await waitForStatusNotification(() => 1, { deadlineMs: 100, sleep }))
      .toEqual({ observed: true, timedOut: false })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('延迟到达的通知能在窗口内被观察到', async () => {
    let elapsed = 0
    let count = 0
    const result = await waitForStatusNotification(() => count, {
      deadlineMs: 200,
      pollMs: 20,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms
        if (elapsed >= 60) {
          count = 1
        }
      },
    })

    expect(result).toEqual({ observed: true, timedOut: false })
  })

  it('窗口耗尽只表示未观察到，不推断没有状态', async () => {
    let elapsed = 0
    const result = await waitForStatusNotification(() => 0, {
      deadlineMs: 100,
      pollMs: 30,
      now: () => elapsed,
      sleep: async (ms) => { elapsed += ms },
    })

    expect(result).toEqual({ observed: false, timedOut: true })
  })
})
