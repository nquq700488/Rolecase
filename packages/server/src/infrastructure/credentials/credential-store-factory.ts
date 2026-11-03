import type { CredentialStorePort } from '../../application/ports/credential-store-port.js'
import { FileCredentialStore } from './file-credential-store.js'
import { MacOsKeychainCredentialStore } from './macos-keychain-credential-store.js'

/** 生产模式没有系统 Keychain 时的明确错误。 */
export class CredentialsUnavailableError extends Error {
  readonly code = 'credentials_unavailable'

  constructor() {
    super('生产模式需要系统 Keychain；开发文件凭据存储不可作为回退')
    this.name = 'CredentialsUnavailableError'
  }
}

/**
 * @name createCredentialStore
 * @description 根据启动模式选择凭据实现，禁止生产模式静默降级到文件
 * @param {object} input 启动模式和开发文件路径
 * @return {CredentialStorePort} 凭据存储实现
 */
export function createCredentialStore(input: {
  mode: 'development' | 'production'
  /** 开发文件 Store 的目录；每个凭据一个 0600 条目文件。 */
  developmentDirectory: string
  keychain?: CredentialStorePort
}): CredentialStorePort {
  if (input.mode === 'production') {
    if (input.keychain !== undefined) {
      return input.keychain
    }
    if (process.platform === 'darwin') {
      return new MacOsKeychainCredentialStore()
    }
    throw new CredentialsUnavailableError()
  }
  return new FileCredentialStore(input.developmentDirectory)
}
