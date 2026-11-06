/** 服务端现存目录的校验与 canonicalization 边界；实现不得读写目录内容。 */
export interface WorkspaceRootPathPort {
  /** 验证绝对路径指向可访问目录，并返回 realpath canonical 路径。 */
  resolveExistingDirectory(path: string): Promise<string>
}
