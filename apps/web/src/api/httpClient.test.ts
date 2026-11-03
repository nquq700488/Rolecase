// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'

import { getLocalToken } from './httpClient.js'

describe('Web Local Token 交付', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    window.history.replaceState(null, '', '/#token=fragment-token')
  })

  it('读取 fragment 后立即清除 URL 并保存到 sessionStorage', () => {
    expect(getLocalToken()).toBe('fragment-token')
    expect(window.location.hash).toBe('')
    expect(window.sessionStorage.getItem('rolecast.local_token')).toBe('fragment-token')
  })

  it('清除 fragment 时保留 Router 的 history state', () => {
    const routerState = { currentRoute: '/' }
    window.history.replaceState(routerState, '', '/#token=fragment-token')

    expect(getLocalToken()).toBe('fragment-token')
    expect(window.history.state).toEqual(routerState)
  })

  it('没有 fragment 时只读取 sessionStorage', () => {
    window.history.replaceState(null, '', '/')
    window.sessionStorage.setItem('rolecast.local_token', 'stored-token')
    expect(getLocalToken()).toBe('stored-token')
  })
})
