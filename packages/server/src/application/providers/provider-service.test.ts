import { describe, expect, it } from 'vitest'

import type {
  CapabilitySnapshot,
  RuntimeEvent,
} from '@rolecast/contract'

import type {
  AgentRuntimeConnection,
  AgentRuntimeConnectionInput,
  AgentRuntimePort,
  AgentRuntimeSession,
} from '../ports/agent-runtime-port.js'
import type {
  CodexConfigImportDraft,
  CodexConfigImportPort,
} from '../ports/codex-config-import-port.js'
import {
  CredentialDeniedError,
  type CredentialStorePort,
} from '../ports/credential-store-port.js'
import { systemClock } from '../ports/clock-port.js'
import { ProviderService } from './provider-service.js'
import { SessionService } from '../sessions/session-service.js'
import { SqliteDatabase } from '../../infrastructure/persistence/sqlite-database.js'
import { SqliteRepository } from '../../infrastructure/persistence/sqlite-repository.js'
import { CredentialEnvironmentMismatchError } from '../../infrastructure/acp/acp-agent-runtime.js'

class TestIds {
  private sequence = 0

  next(prefix: string): string {
    this.sequence += 1
    return `${prefix}-${this.sequence}`
  }
}

class TestRuntime implements AgentRuntimePort {
  readonly appliedOptions: Array<{ configId: string; value: string }> = []
  readonly connectionInputs: AgentRuntimeConnectionInput[] = []
  private readonly connection: AgentRuntimeConnection = {
    connectionId: 'connection-001',
    providerKind: 'claude',
    adapterVersion: 'test',
    capabilities: {
      provider_kind: 'claude',
      adapter_version: 'test',
      source: 'manual',
      observed_at: '2026-10-14T10:00:00.000Z',
      capabilities: {},
    },
  }

  async connect(input: AgentRuntimeConnectionInput): Promise<AgentRuntimeConnection> {
    this.connectionInputs.push(input)
    return this.connection
  }

  async createSession(connection: AgentRuntimeConnection): Promise<AgentRuntimeSession> {
    return {
      sessionId: 'acp-session-001',
      connection,
      configOptions: [{
        id: 'model',
        category: 'model',
        currentValue: 'default-model',
        options: [{ value: 'model-a', name: 'Model A' }],
      }],
    }
  }

  async setConfigOption(session: AgentRuntimeSession, configId: string, value: string): Promise<AgentRuntimeSession> {
    this.appliedOptions.push({ configId, value })
    return {
      ...session,
      configOptions: session.configOptions.map((option) => option.id === configId
        ? { ...option, currentValue: value }
        : option),
    }
  }

  async *sendTurn(): AsyncIterable<RuntimeEvent> {}
  async respondPermission(): Promise<void> {}
  async cancelTurn(): Promise<void> {}
  async resumeSession(): Promise<AgentRuntimeSession> {
    return this.createSession(this.connection)
  }
  async closeSession(): Promise<void> {}
  async closeConnection(): Promise<void> {}
}

const environment = {
  cwd: process.cwd(),
  environment: { OPENAI_API_KEY: 'not-test-secret', SAFE_SETTING: 'safe' },
  runtimeDirectory: (connectionId: string) => `/tmp/rolecast-${connectionId}`,
}
const definitions = {
  get: () => ({ adapterCommand: 'test-adapter', adapterArgs: [], adapterVersion: 'test' }),
}

const discoveredCapabilities: CapabilitySnapshot = {
  provider_kind: 'claude',
  adapter_version: 'test',
  source: 'acp_handshake',
  observed_at: '2026-10-14T10:00:00.000Z',
  capabilities: {
    config_options: [{
      id: 'model',
      category: 'model',
      currentValue: 'default-model',
      options: [{ value: 'model-a', name: 'Model A' }],
    }],
  },
}

class TestCredentialStore implements CredentialStorePort {
  readonly validated: string[] = []
  readonly read: string[] = []

  constructor(private readonly validationError?: Error) {}

  async save(): Promise<string> {
    return 'credential-created'
  }

  async get(reference: string): Promise<string | null> {
    this.read.push(reference)
    throw new Error('ProviderService 不应读取凭据原文')
  }

  async validate(reference: string): Promise<boolean> {
    this.validated.push(reference)
    if (this.validationError !== undefined) {
      throw this.validationError
    }
    return reference === 'credential-001'
  }

  async rotate(): Promise<void> {}
  async delete(): Promise<void> {}
}

/** 可指定 codex_config 内容的导入桩，用于验证「不能形成 Runtime 配置」的草稿。 */
class ConfigImportWith implements CodexConfigImportPort {
  constructor(
    private readonly config: CodexConfigImportDraft['config'],
    private readonly baseUrl: string | null = 'https://gateway.example.test/v1',
  ) {}

  async preview(
    workspaceId: string,
    providerId: string,
    targetConfigRevision: number,
  ): Promise<CodexConfigImportDraft> {
    return {
      previewId: 'preview-001',
      workspaceId,
      providerId,
      sourceName: 'config.toml',
      sourceDigest: 'a'.repeat(64),
      targetConfigRevision,
      ...(this.baseUrl === null ? {} : { baseUrl: this.baseUrl }),
      config: this.config,
      models: [{ modelId: 'gpt-test', displayName: 'gpt-test' }],
      warnings: [],
    }
  }

  async claim(
    previewId: string,
    workspaceId: string,
    providerId: string,
    targetConfigRevision: number,
  ): Promise<CodexConfigImportDraft> {
    return this.preview(workspaceId, providerId, targetConfigRevision).then((draft) => ({ ...draft, previewId }))
  }
}

class TestCodexConfigImport implements CodexConfigImportPort {
  async preview(
    workspaceId: string,
    providerId: string,
    targetConfigRevision: number,
  ): Promise<CodexConfigImportDraft> {
    return {
      previewId: 'preview-001',
      workspaceId,
      providerId,
      sourceName: 'config.toml',
      sourceDigest: 'a'.repeat(64),
      targetConfigRevision,
      baseUrl: 'https://gateway.example.test/v1',
      config: {
        model_provider: 'rolecast',
        model: 'gpt-test',
        wire_api: 'responses',
        reasoning_effort: 'medium',
      },
      models: [{ modelId: 'gpt-test', displayName: 'gpt-test' }],
      warnings: [],
    }
  }

  async claim(
    previewId: string,
    workspaceId: string,
    providerId: string,
    targetConfigRevision: number,
  ): Promise<CodexConfigImportDraft> {
    return this.preview(workspaceId, providerId, targetConfigRevision).then((draft) => ({ ...draft, previewId }))
  }
}

describe('Provider/Session 模型配置', () => {
  it('从 ACP config_options 建立模型目录并把选择应用到 Session', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const ids = new TestIds()
    const runtime = new TestRuntime()
    const discovery = { discover: async () => discoveredCapabilities }
    const providerService = new ProviderService(repository, discovery, ids, systemClock, definitions, environment)
    const sessionService = new SessionService(repository, runtime, ids, systemClock, definitions, environment)
    const workspace = await repository.createWorkspace({
      id: 'workspace-001',
      name: '测试工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection(workspace.id, {
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
    })

    await providerService.discoverModels(connection.id)
    await expect(repository.listModels(connection.id)).resolves.toEqual([
      expect.objectContaining({ model_id: 'model-a', display_name: 'Model A' }),
    ])

    await sessionService.create('workspace-001', {
      name: '模型会话',
      provider_connection_id: connection.id,
      model_id: 'model-a',
    })
    expect(runtime.appliedOptions).toEqual([{ configId: 'model', value: 'model-a' }])
    await repository.close()
  })

  it('Codex isolated local 经 apply 后仍为待配置，且不写 Session/Slot', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const ids = new TestIds()
    const runtime = new TestRuntime()
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      ids,
      systemClock,
      definitions,
      environment,
      new ConfigImportWith({ model_provider: 'rolecast', model: 'gpt-test' }, null),
      new TestCredentialStore(),
    )
    const sessionService = new SessionService(repository, runtime, ids, systemClock, definitions, environment)
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Codex local isolated 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'local',
      environment_mode: 'inherited',
    })
    const preview = await providerService.previewConfigImport(connection.id, '/tmp/config.toml')
    await providerService.applyConfigImport(connection.id, {
      preview_id: preview.previewId,
      confirmed: true,
      target_config_revision: preview.targetConfigRevision,
    })

    // Codex isolated local 没有受支持的认证路径：三入口统一待配置。
    await expect(providerService.testConnection(connection.id))
      .rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })
    await expect(sessionService.create('workspace-001', {
      name: '不应创建的会话',
      provider_connection_id: connection.id,
      model_id: 'model-a',
    })).rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })
    await expect(repository.listSessions('workspace-001')).resolves.toEqual([])
    expect(runtime.connectionInputs).toEqual([])
    await repository.close()
  })

  it('应用 Codex 导入后，Provider 和 Session 共用 isolated Runtime 配置', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const ids = new TestIds()
    const runtime = new TestRuntime()
    const importer = new ConfigImportWith(
      { model_provider: 'rolecast', model: 'gpt-test', wire_api: 'responses', reasoning_effort: 'medium' },
      null,
    )
    const credentials = new TestCredentialStore()
    const discovery = { discover: async () => discoveredCapabilities }
    const providerService = new ProviderService(
      repository,
      discovery,
      ids,
      systemClock,
      definitions,
      environment,
      importer,
      credentials,
    )
    const sessionService = new SessionService(repository, runtime, ids, systemClock, definitions, environment)
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Codex 配置工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })
    const preview = await providerService.previewConfigImport(connection.id, '/tmp/config.toml')
    const applied = await providerService.applyConfigImport(connection.id, {
      preview_id: preview.previewId,
      confirmed: true,
      target_config_revision: preview.targetConfigRevision,
      credential_ref: 'credential-001',
    })

    expect(applied).toMatchObject({
      provider_kind: 'codex',
      environment_mode: 'isolated',
      config_revision: 2,
      codex_config: {
        model_provider: 'rolecast',
        model: 'gpt-test',
        wire_api: 'responses',
        reasoning_effort: 'medium',
      },
    })
    expect(applied.connection_kind).toBe('api_key')

    await sessionService.create('workspace-001', {
      name: 'Codex 导入会话',
      provider_connection_id: connection.id,
      model_id: 'model-a',
    })
    expect(runtime.connectionInputs.at(-1)).toMatchObject({
      providerKind: 'codex',
      environmentMode: 'isolated',
      importedConfig: {
        confirmed: true,
        model: 'gpt-test',
        wireApi: 'responses',
        reasoningEffort: 'medium',
      },
      env: { SAFE_SETTING: 'safe' },
    })

    const apiConnection = await providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })
    const apiPreview = await providerService.previewConfigImport(apiConnection.id, '/tmp/config.toml')
    await providerService.applyConfigImport(apiConnection.id, {
      preview_id: apiPreview.previewId,
      confirmed: true,
      target_config_revision: apiPreview.targetConfigRevision,
      credential_ref: 'credential-001',
    })
    // 引用在 apply 与后续 Session 创建时各校验一次；Application 始终不读原文。
    expect(credentials.validated).toEqual(['credential-001', 'credential-001'])
    expect(credentials.read).toEqual([])
    await repository.close()
  })

  it('将 Keychain 拒绝映射为 credential_denied', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const ids = new TestIds()
    const credentials = new TestCredentialStore(new CredentialDeniedError())
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      ids,
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '拒绝错误工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })
    const preview = await providerService.previewConfigImport(connection.id, '/tmp/config.toml')

    await expect(providerService.applyConfigImport(connection.id, {
      preview_id: preview.previewId,
      confirmed: true,
      target_config_revision: preview.targetConfigRevision,
      credential_ref: 'credential-001',
    })).rejects.toMatchObject({ code: 'credential_denied', statusCode: 403 })
    await repository.close()
  })

  it('Claude isolated local 在 testConnection / discoverModels 统一待配置且不写模型', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    let discoverCalls = 0
    const discovery = {
      discover: async (): Promise<CapabilitySnapshot> => {
        discoverCalls += 1
        return discoveredCapabilities
      },
    }
    const providerService = new ProviderService(
      repository,
      discovery,
      new TestIds(),
      systemClock,
      definitions,
      environment,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '待配置工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
    })
    // 直接构造历史/异常数据：isolated local 不应运行。
    await repository.updateProviderConnection({ ...connection, environment_mode: 'isolated' }, 1)

    await expect(providerService.testConnection(connection.id))
      .rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })
    await expect(providerService.discoverModels(connection.id))
      .rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })
    expect(discoverCalls).toBe(0)
    await expect(repository.listModels(connection.id)).resolves.toEqual([])
    await repository.close()
  })

  it('Codex custom endpoint 不允许声明 ready，testConnection/discoverModels 返回未证错误', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    let discoverCalls = 0
    const providerService = new ProviderService(
      repository,
      {
        discover: async (): Promise<CapabilitySnapshot> => {
          discoverCalls += 1
          return discoveredCapabilities
        },
      },
      new TestIds(),
      systemClock,
      definitions,
      environment,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Codex custom 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
      environment_mode: 'inherited',
    })

    await expect(providerService.testConnection(connection.id))
      .rejects.toMatchObject({ code: 'codex_custom_endpoint_unverified', statusCode: 422 })
    await expect(providerService.discoverModels(connection.id))
      .rejects.toMatchObject({ code: 'codex_custom_endpoint_unverified', statusCode: 422 })
    expect(discoverCalls).toBe(0)
    await repository.close()
  })

  it('custom_endpoint 缺少 base_url 时创建被拒绝，且不写记录', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '缺 URL 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    await expect(providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'custom_endpoint',
      environment_mode: 'inherited',
    })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 422 })
    await expect(repository.listProviderConnections('workspace-001')).resolves.toEqual([])
    await repository.close()
  })

  it('非 custom_endpoint 连接不能设置 base_url', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '多余 URL 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    await expect(providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'local',
      base_url: 'https://gateway.example.test/v1',
      environment_mode: 'inherited',
    })).rejects.toMatchObject({ code: 'invalid_request', statusCode: 422 })
    await expect(repository.listProviderConnections('workspace-001')).resolves.toEqual([])
    await repository.close()
  })

  it('Claude custom endpoint 把 base_url 传给 Runtime 输入', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const runtime = new TestRuntime()
    const providerService = new ProviderService(
      repository,
      { discover: async (input) => { runtime.connectionInputs.push(input); return discoveredCapabilities } },
      new TestIds(),
      systemClock,
      definitions,
      environment,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Claude custom 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
      environment_mode: 'inherited',
    })

    await providerService.testConnection(connection.id)
    expect(runtime.connectionInputs.at(-1)).toMatchObject({
      providerKind: 'claude',
      connectionKind: 'custom_endpoint',
      baseUrl: 'https://gateway.example.test/v1',
    })
    await repository.close()
  })

  it('允许创建 Claude isolated api_key / custom_endpoint 连接并校验引用', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const credentials = new TestCredentialStore()
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Claude isolated 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    const apiKey = await providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })
    expect(apiKey).toMatchObject({
      provider_kind: 'claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })
    expect(apiKey.base_url).toBeUndefined()

    const custom = await providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'custom_endpoint',
      environment_mode: 'isolated',
      base_url: 'https://gateway.example.test/v1',
      credential_ref: 'credential-001',
    })
    expect(custom).toMatchObject({
      environment_mode: 'isolated',
      base_url: 'https://gateway.example.test/v1',
      credential_ref: 'credential-001',
    })

    // 只 validate 引用，绝不读取原文。
    expect(credentials.validated).toEqual(['credential-001', 'credential-001'])
    expect(credentials.read).toEqual([])
    await expect(repository.listProviderConnections('workspace-001')).resolves.toHaveLength(2)
    await repository.close()
  })

  it('Claude isolated local 可以创建为待配置，且不读凭据', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const credentials = new TestCredentialStore()
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Claude isolated local 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'isolated',
    })
    expect(connection).toMatchObject({ environment_mode: 'isolated', connection_kind: 'local' })
    expect(connection.credential_ref).toBeUndefined()
    expect(credentials.validated).toEqual([])
    expect(credentials.read).toEqual([])

    // 保存成功，但运行入口统一待配置。
    await expect(providerService.testConnection(connection.id))
      .rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })
    await repository.close()
  })

  it('Claude isolated api_key 缺少 credential_ref 时拒绝创建且不写记录', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      new TestCredentialStore(),
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '缺引用工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    await expect(providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
    })).rejects.toMatchObject({ code: 'credential_required', statusCode: 422 })
    await expect(repository.listProviderConnections('workspace-001')).resolves.toEqual([])
    await repository.close()
  })

  it('Claude isolated 引用校验失败时结构化拒绝且不写记录', async () => {
    for (const scenario of [
      { name: '不存在', store: new TestCredentialStore(), code: 'credential_not_found', status: 404, ref: 'missing-ref' },
      {
        name: '拒绝',
        store: new TestCredentialStore(new CredentialDeniedError()),
        code: 'credential_denied',
        status: 403,
        ref: 'credential-001',
      },
      {
        name: '不可用',
        store: new TestCredentialStore(new Error('store down')),
        code: 'credentials_unavailable',
        status: 503,
        ref: 'credential-001',
      },
    ] as const) {
      const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
      const providerService = new ProviderService(
        repository,
        { discover: async () => discoveredCapabilities },
        new TestIds(),
        systemClock,
        definitions,
        environment,
        new TestCodexConfigImport(),
        scenario.store,
      )
      await repository.createWorkspace({
        id: 'workspace-001',
        name: `${scenario.name}工作区`,
        created_at: '2026-10-14T10:00:00.000Z',
        updated_at: '2026-10-14T10:00:00.000Z',
      })

      await expect(providerService.createConnection('workspace-001', {
        provider_kind: 'claude',
        connection_kind: 'api_key',
        environment_mode: 'isolated',
        credential_ref: scenario.ref,
      })).rejects.toMatchObject({ code: scenario.code, statusCode: scenario.status })
      await expect(repository.listProviderConnections('workspace-001')).resolves.toEqual([])
      await repository.close()
    }
  })

  it('Codex isolated 仍拒绝 createConnection，必须由 apply 建立', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      new TestCredentialStore(),
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Codex isolated 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    await expect(providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })).rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })
    await expect(repository.listProviderConnections('workspace-001')).resolves.toEqual([])
    await repository.close()
  })

  it('历史 codex api_key + base_url 记录在三入口 fail-closed 且无副作用', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const runtime = new TestRuntime()
    let discoverCalls = 0
    const credentials = new TestCredentialStore()
    const providerService = new ProviderService(
      repository,
      {
        discover: async (): Promise<CapabilitySnapshot> => {
          discoverCalls += 1
          return discoveredCapabilities
        },
      },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    const sessionService = new SessionService(repository, runtime, new TestIds(), systemClock, definitions, environment)
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '历史 endpoint 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    // 直接落一条旧形状记录：connection_kind 仍是 api_key，但带 base_url 与引用。
    const legacy = await repository.createProviderConnection({
      id: 'provider-legacy',
      workspace_id: 'workspace-001',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      base_url: 'https://gateway.example.test/v1',
      credential_ref: 'credential-001',
      environment_mode: 'isolated',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
      config_revision: 1,
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    await expect(providerService.testConnection(legacy.id))
      .rejects.toMatchObject({ code: 'codex_custom_endpoint_unverified', statusCode: 422 })
    await expect(providerService.discoverModels(legacy.id))
      .rejects.toMatchObject({ code: 'codex_custom_endpoint_unverified', statusCode: 422 })
    await expect(sessionService.create('workspace-001', {
      name: '不应创建的会话',
      provider_connection_id: legacy.id,
      model_id: 'model-a',
    })).rejects.toMatchObject({ code: 'codex_custom_endpoint_unverified', statusCode: 422 })

    expect(discoverCalls).toBe(0)
    expect(runtime.connectionInputs).toEqual([])
    // Application 只 validate 的路径也不应被触发（判定在凭据之前）。
    expect(credentials.read).toEqual([])
    await expect(repository.listSessions('workspace-001')).resolves.toEqual([])
    await expect(repository.listModels(legacy.id)).resolves.toEqual([])
    await repository.close()
  })

  it('历史 codex_config 只有 model_provider 时三入口待配置且不读凭据', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const runtime = new TestRuntime()
    let discoverCalls = 0
    const credentials = new TestCredentialStore()
    const providerService = new ProviderService(
      repository,
      {
        discover: async (): Promise<CapabilitySnapshot> => {
          discoverCalls += 1
          return discoveredCapabilities
        },
      },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    const sessionService = new SessionService(repository, runtime, new TestIds(), systemClock, definitions, environment)
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '历史空配置工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const legacy = await repository.createProviderConnection({
      id: 'provider-legacy-empty',
      workspace_id: 'workspace-001',
      provider_kind: 'codex',
      connection_kind: 'api_key',
      credential_ref: 'credential-001',
      environment_mode: 'isolated',
      codex_config: { model_provider: 'rolecast' },
      config_revision: 1,
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    await expect(providerService.testConnection(legacy.id))
      .rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })
    await expect(providerService.discoverModels(legacy.id))
      .rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })
    await expect(sessionService.create('workspace-001', {
      name: '不应创建的会话',
      provider_connection_id: legacy.id,
      model_id: 'model-a',
    })).rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })

    expect(discoverCalls).toBe(0)
    expect(runtime.connectionInputs).toEqual([])
    expect(credentials.read).toEqual([])
    await expect(repository.listSessions('workspace-001')).resolves.toEqual([])
    await repository.close()
  })

  it('Codex apply 产生 base_url 时转为 custom_endpoint 并被组合判定拒绝运行', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    let discoverCalls = 0
    const runtime = new TestRuntime()
    const providerService = new ProviderService(
      repository,
      {
        discover: async (): Promise<CapabilitySnapshot> => {
          discoverCalls += 1
          return discoveredCapabilities
        },
      },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      new TestCredentialStore(),
    )
    const sessionService = new SessionService(repository, runtime, new TestIds(), systemClock, definitions, environment)
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Codex 导入 endpoint 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })
    const preview = await providerService.previewConfigImport(connection.id, '/tmp/config.toml')
    const applied = await providerService.applyConfigImport(connection.id, {
      preview_id: preview.previewId,
      confirmed: true,
      target_config_revision: preview.targetConfigRevision,
      credential_ref: 'credential-001',
    })

    // 有 base_url 就不再是普通 api_key：必须转成 custom_endpoint，否则会绕过认证未证边界。
    expect(applied).toMatchObject({
      connection_kind: 'custom_endpoint',
      base_url: 'https://gateway.example.test/v1',
      environment_mode: 'isolated',
    })

    await expect(providerService.testConnection(connection.id))
      .rejects.toMatchObject({ code: 'codex_custom_endpoint_unverified', statusCode: 422 })
    await expect(providerService.discoverModels(connection.id))
      .rejects.toMatchObject({ code: 'codex_custom_endpoint_unverified', statusCode: 422 })
    await expect(sessionService.create('workspace-001', {
      name: '不应创建的会话',
      provider_connection_id: connection.id,
      model_id: 'model-a',
    })).rejects.toMatchObject({ code: 'codex_custom_endpoint_unverified', statusCode: 422 })

    expect(discoverCalls).toBe(0)
    expect(runtime.connectionInputs).toEqual([])
    await expect(repository.listSessions('workspace-001')).resolves.toEqual([])
    await expect(repository.listModels(connection.id)).resolves.toEqual([])
    await repository.close()
  })

  it('Codex apply 无 base_url 时保持 api_key 并可运行', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const runtime = new TestRuntime()
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new ConfigImportWith({ model_provider: 'rolecast', model: 'gpt-test' }, null),
      new TestCredentialStore(),
    )
    const sessionService = new SessionService(repository, runtime, new TestIds(), systemClock, definitions, environment)
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Codex 无 endpoint 工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })
    const preview = await providerService.previewConfigImport(connection.id, '/tmp/config.toml')
    const applied = await providerService.applyConfigImport(connection.id, {
      preview_id: preview.previewId,
      confirmed: true,
      target_config_revision: preview.targetConfigRevision,
      credential_ref: 'credential-001',
    })

    expect(applied.connection_kind).toBe('api_key')
    expect(applied.base_url).toBeUndefined()
    await repository.close()
  })

  it('isolated local 携带 credential_ref 在创建时被拒绝且不 validate', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const credentials = new TestCredentialStore()
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'local 带引用工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    await expect(providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
    })).rejects.toMatchObject({ code: 'credential_environment_mismatch', statusCode: 422 })
    expect(credentials.validated).toEqual([])
    expect(credentials.read).toEqual([])
    await expect(repository.listProviderConnections('workspace-001')).resolves.toEqual([])
    await repository.close()
  })

  it('Codex apply 对 local 携带 credential_ref 拒绝且不校验引用', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const credentials = new TestCredentialStore()
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: 'Codex local 带引用工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'local',
      environment_mode: 'inherited',
    })
    const preview = await providerService.previewConfigImport(connection.id, '/tmp/config.toml')
    const before = await repository.getProviderConnection(connection.id)

    await expect(providerService.applyConfigImport(connection.id, {
      preview_id: preview.previewId,
      confirmed: true,
      target_config_revision: preview.targetConfigRevision,
      credential_ref: 'credential-001',
    })).rejects.toMatchObject({ code: 'credential_environment_mismatch', statusCode: 422 })
    expect(credentials.validated).toEqual([])
    expect(credentials.read).toEqual([])
    // 连接未被更新。
    await expect(repository.getProviderConnection(connection.id)).resolves.toEqual(before)
    await repository.close()
  })

  it('Codex 导入只含 model_provider 时拒绝，且不读取凭据', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const credentials = new TestCredentialStore()
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new ConfigImportWith({ model_provider: 'rolecast' }, null),
      credentials,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '空配置工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'api_key',
      environment_mode: 'inherited',
    })
    const preview = await providerService.previewConfigImport(connection.id, '/tmp/config.toml')
    const before = await repository.getProviderConnection(connection.id)

    await expect(providerService.applyConfigImport(connection.id, {
      preview_id: preview.previewId,
      confirmed: true,
      target_config_revision: preview.targetConfigRevision,
      credential_ref: 'credential-001',
    })).rejects.toMatchObject({ code: 'config_import_invalid', statusCode: 422 })
    // 有效配置校验先于 CredentialStore。
    expect(credentials.validated).toEqual([])
    expect(credentials.read).toEqual([])
    await expect(repository.getProviderConnection(connection.id)).resolves.toEqual(before)
    await repository.close()
  })

  it('更新非秘密连接字段：只 validate 引用、CAS 写入并清空旧模型目录', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const credentials = new TestCredentialStore()
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '更新工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
    })
    await repository.saveModelsIfCurrentRevision(connection.id, 1, [{
      id: 'model-001',
      workspace_id: 'workspace-001',
      provider_connection_id: connection.id,
      provider_kind: 'claude',
      model_id: 'old-model',
      display_name: 'Old',
      capabilities: {},
      observed_at: '2026-10-14T10:00:00.000Z',
    }])

    const updated = await providerService.updateConnection(connection.id, {
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      config_revision: 1,
    })

    expect(updated).toMatchObject({
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      config_revision: 2,
    })
    expect(credentials.validated).toEqual(['credential-001'])
    expect(credentials.read).toEqual([])
    await expect(repository.listModels(connection.id)).resolves.toEqual([])
    await repository.close()
  })

  it('历史 Claude 连接带 codex_config 时更新被拒绝且不写入', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      new TestCredentialStore(),
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '遗留配置工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    // 历史数据形状：Claude 连接残留 codex_config。
    const legacy = await repository.createProviderConnection({
      id: 'provider-legacy',
      workspace_id: 'workspace-001',
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
      codex_config: { model_provider: 'rolecast', model: 'gpt-test' },
      config_revision: 1,
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    // 未清除遗留配置时拒绝更新。
    await expect(providerService.updateConnection(legacy.id, {
      connection_kind: 'api_key',
      config_revision: 1,
    })).rejects.toMatchObject({ code: 'unsupported_option', statusCode: 422 })
    await expect(repository.getProviderConnection(legacy.id)).resolves.toMatchObject({
      config_revision: 1,
      provider_kind: 'claude',
    })

    // 显式 codex_config: null 是唯一允许的恢复路径。
    const repaired = await providerService.updateConnection(legacy.id, {
      connection_kind: 'api_key',
      codex_config: null,
      config_revision: 1,
    })
    expect(repaired).toMatchObject({ connection_kind: 'api_key', config_revision: 2 })
    expect(repaired.codex_config).toBeUndefined()
    await repository.close()
  })

  it('更新时组合非法、引用无效或 CAS 冲突都不写入', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const credentials = new TestCredentialStore()
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '更新失败工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
    })
    const before = await repository.getProviderConnection(connection.id)

    // local + credential_ref 结构非法。
    await expect(providerService.updateConnection(connection.id, {
      connection_kind: 'local',
      credential_ref: 'credential-001',
      config_revision: 1,
    })).rejects.toMatchObject({ code: 'credential_environment_mismatch', statusCode: 422 })
    // custom_endpoint 缺 base_url。
    await expect(providerService.updateConnection(connection.id, {
      connection_kind: 'custom_endpoint',
      config_revision: 1,
    })).rejects.toMatchObject({ code: 'provider_needs_configuration', statusCode: 422 })
    // 引用不存在。
    await expect(providerService.updateConnection(connection.id, {
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'missing-ref',
      config_revision: 1,
    })).rejects.toMatchObject({ code: 'credential_not_found', statusCode: 404 })
    // CAS 冲突。
    await expect(providerService.updateConnection(connection.id, {
      connection_kind: 'api_key',
      config_revision: 99,
    })).rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })

    expect(credentials.read).toEqual([])
    await expect(repository.getProviderConnection(connection.id)).resolves.toEqual(before)
    await repository.close()
  })

  it('发现挂起期间更新配置，旧发现不能复活旧模型目录', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const credentials = new TestCredentialStore()
    const releaseCallbacks: Array<() => void> = []
    const providerService = new ProviderService(
      repository,
      {
        discover: async () => {
          await new Promise<void>((resolve) => { releaseCallbacks.push(resolve) })
          return discoveredCapabilities
        },
      },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      credentials,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '并发发现工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
    })

    const pendingDiscover = providerService.discoverModels(connection.id)
    await new Promise<void>((resolve) => setImmediate(resolve))

    // 发现仍在等待 Adapter 时，配置被 CAS 更新。
    await providerService.updateConnection(connection.id, {
      connection_kind: 'api_key',
      environment_mode: 'isolated',
      credential_ref: 'credential-001',
      config_revision: 1,
    })
    for (const release of releaseCallbacks) {
      release()
    }

    // 旧发现必须失败，且不能写回旧目录。
    await expect(pendingDiscover).rejects.toMatchObject({ code: 'state_conflict', statusCode: 409 })
    await expect(repository.listModels(connection.id)).resolves.toEqual([])
    await repository.close()
  })

  it('创建 inherited 连接时拒绝 credential_ref', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const providerService = new ProviderService(
      repository,
      { discover: async () => discoveredCapabilities },
      new TestIds(),
      systemClock,
      definitions,
      environment,
      new TestCodexConfigImport(),
      new TestCredentialStore(),
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '环境模式工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })

    await expect(providerService.createConnection('workspace-001', {
      provider_kind: 'codex',
      connection_kind: 'api_key',
      credential_ref: 'credential-001',
      environment_mode: 'inherited',
    })).rejects.toMatchObject({ code: 'credential_environment_mismatch', statusCode: 422 })
    await repository.close()
  })

  it('能力发现把 credential_environment_mismatch 映射为结构化 422', async () => {
    const repository = new SqliteRepository(new SqliteDatabase(':memory:'))
    const mismatch = { discover: async (): Promise<CapabilitySnapshot> => { throw new CredentialEnvironmentMismatchError() } }
    const providerService = new ProviderService(
      repository,
      mismatch,
      new TestIds(),
      systemClock,
      definitions,
      environment,
    )
    await repository.createWorkspace({
      id: 'workspace-001',
      name: '不匹配工作区',
      created_at: '2026-10-14T10:00:00.000Z',
      updated_at: '2026-10-14T10:00:00.000Z',
    })
    const connection = await providerService.createConnection('workspace-001', {
      provider_kind: 'claude',
      connection_kind: 'local',
      environment_mode: 'inherited',
    })

    await expect(providerService.testConnection(connection.id))
      .rejects.toMatchObject({ code: 'credential_environment_mismatch', statusCode: 422 })
    await expect(providerService.discoverModels(connection.id))
      .rejects.toMatchObject({ code: 'credential_environment_mismatch', statusCode: 422 })
    await repository.close()
  })
})
