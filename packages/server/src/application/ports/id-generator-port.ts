/** 生成不可预测但不携带业务秘密的实体 ID。 */
export interface IdGeneratorPort {
  /** 返回新的实体标识。 */
  next(prefix: string): string
}

/** 生成请求级时间的抽象。 */
export interface RuntimeEnvironmentPort {
  /** 当前工作目录。 */
  cwd: string
  /** 传给 inherited Adapter 的环境快照。 */
  environment: Readonly<Record<string, string | undefined>>
  /** 为连接分配运行时目录。 */
  runtimeDirectory(connectionId: string): string
}

/** ProviderDefinition 到 Adapter 启动参数的稳定映射。 */
export interface ProviderDefinitionPort {
  /** 读取 Provider 的非秘密启动定义。 */
  get(providerKind: 'claude' | 'codex'): {
    adapterCommand: string
    adapterArgs: readonly string[]
    adapterVersion: string
    credentialEnvironmentKey?: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY'
  }

  /**
   * 生成实际 spawn 身份的私有指纹（含二进制内容与参数摘要）。
   *
   * 返回 null 表示无法可靠判定，attachment 不可恢复。实现位于 Infrastructure，
   * 指纹不进入 DTO、事件或日志。
   */
  fingerprint?(providerKind: 'claude' | 'codex'): Promise<string | null>
}
