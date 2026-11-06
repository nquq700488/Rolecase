import { constants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

import type { WorkspaceRootPathPort } from '../application/ports/workspace-root-path-port.js'

/**
 * @name NodeWorkspaceRootPathAdapter
 * @description 使用 Node 文件系统 API 验证 Workspace 根目录并返回 canonical 路径
 */
export class NodeWorkspaceRootPathAdapter implements WorkspaceRootPathPort {
  /**
   * @name resolveExistingDirectory
   * @description 验证绝对路径是服务端可访问的现存目录并解析符号链接
   * @param {string} path 用户提供的 Workspace 根路径
   * @return {Promise<string>} canonical realpath
   */
  async resolveExistingDirectory(path: string): Promise<string> {
    if (!isAbsolute(path)) {
      throw new Error('Workspace root path must be absolute')
    }

    const canonicalPath = await realpath(path)
    if (!(await stat(canonicalPath)).isDirectory()) {
      throw new Error('Workspace root path must be a directory')
    }
    await access(canonicalPath, constants.R_OK | constants.W_OK | constants.X_OK)
    return canonicalPath
  }
}
