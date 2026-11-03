import { describe, expect, it } from 'vitest'

import type { CredentialStorePort } from '../../application/ports/credential-store-port.js'
import { FileCredentialStore } from './file-credential-store.js'
import { MacOsKeychainCredentialStore } from './macos-keychain-credential-store.js'
import { CredentialsUnavailableError, createCredentialStore } from './credential-store-factory.js'

const fakeStore: CredentialStorePort = {
  save: async () => 'credential-001',
  get: async () => 'test-secret',
  validate: async () => true,
  rotate: async () => undefined,
  delete: async () => undefined,
}

describe('CredentialStore factory', () => {
  it('development 使用 FileCredentialStore', () => {
    expect(createCredentialStore({ mode: 'development', developmentDirectory: '/tmp/rolecast-test-credentials' }))
      .toBeInstanceOf(FileCredentialStore)
  })

  it('显式注入实现优先于平台默认', () => {
    expect(createCredentialStore({ mode: 'production', developmentDirectory: '/tmp/unused', keychain: fakeStore }))
      .toBe(fakeStore)
  })

  it('macOS production 默认选择 Keychain，其他平台 fail-closed', () => {
    if (process.platform === 'darwin') {
      expect(createCredentialStore({ mode: 'production', developmentDirectory: '/tmp/unused' }))
        .toBeInstanceOf(MacOsKeychainCredentialStore)
      return
    }
    expect(() => createCredentialStore({ mode: 'production', developmentDirectory: '/tmp/unused' }))
      .toThrow(CredentialsUnavailableError)
  })
})
