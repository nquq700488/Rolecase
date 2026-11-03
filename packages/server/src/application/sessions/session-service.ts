import type {
  AddAgentSlotRequest,
  AgentSlotDto,
  CreateSessionRequest,
  ProviderConnectionDto,
  RoleBindingDto,
  RoleDto,
  RunDto,
  SessionDto,
} from '@rolecast/contract'

import type {
  AgentRuntimeConnection,
  AgentRuntimePort,
  AgentRuntimeSession,
} from '../ports/agent-runtime-port.js'
import { ApplicationError, isCodedError } from '../errors.js'
import type { ClockPort } from '../ports/clock-port.js'
import type {
  IdGeneratorPort,
  ProviderDefinitionPort,
  RuntimeEnvironmentPort,
} from '../ports/id-generator-port.js'
import type {
  RepositoryPort,
  RuntimeAttachmentRecord,
} from '../ports/repository-port.js'
import type { RoleService } from '../roles/role-service.js'
import { assertRunnableCombination } from '../providers/provider-combination.js'
import { createProviderRuntimeInput } from '../providers/provider-runtime-input.js'
import { addRoleBoundAgentSlot, snapshotRole } from './agent-slot-lifecycle.js'

interface SessionCreationConfiguration {
  readonly connection: ProviderConnectionDto
  readonly modelId: string
  readonly binding: RoleBindingDto | null
  readonly role: RoleDto | null
}

/** Application 层按 AgentSlot 访问活动 Runtime Session 的边界。 */
export interface RuntimeSessionRegistryPort {
  /** 按 AgentSlot ID 读取活动 ACP Session。 */
  getRuntimeSession(slotId: string): AgentRuntimeSession | null
  /** 按 Slot attachment 重新挂接（Run resume 使用）；无 attachment 返回 null。 */
  reattach?(slotId: string): Promise<AgentRuntimeSession | null>
  /**
   * retry 建立全新 ACP Session，并返回待持久化的新 attachment。
   *
   * 调用方必须先持久化 attachment、再替换活动 Runtime；任一步失败都要回收
   * 新 Session/连接，不能留下无法恢复的孤儿。
   */
  openRuntimeSession?(input: {
    sessionId: string
    slotId: string
    providerConnectionId: string
    modelId: string
  }): Promise<{
    connection: AgentRuntimeConnection
    session: AgentRuntimeSession
    attachment: RuntimeAttachmentRecord
  }>
  /** retry 成功后用新 Session 替换活动 Runtime，并安全关闭旧 Session/连接。 */
  replaceRuntimeSession?(
    sessionId: string,
    opened: { connection: AgentRuntimeConnection; session: AgentRuntimeSession },
  ): Promise<void>
}

/** Session 创建和单 AgentSlot 用例服务。 */
export class SessionService implements RuntimeSessionRegistryPort {
  private readonly runtimeSessions = new Map<string, AgentRuntimeSession>()
  private readonly runtimeConnections = new Map<string, AgentRuntimeConnection>()
  private readonly runtimeCleanupOperations = new Map<string, Promise<void>>()

  constructor(
    private readonly repository: RepositoryPort,
    private readonly runtime: AgentRuntimePort,
    private readonly ids: IdGeneratorPort,
    private readonly clock: ClockPort,
    private readonly definitions: ProviderDefinitionPort,
    private readonly environment: RuntimeEnvironmentPort,
    private readonly roleService?: Pick<RoleService, 'resolveBindingForWorkspace'>,
  ) {}

  /** 创建 Session、连接 Runtime，并播种一个 AgentSlot。 */
  async create(
    workspaceId: string,
    input: CreateSessionRequest,
  ): Promise<{ session: SessionDto; agentSlot: AgentSlotDto }> {
    const configuration = await this.resolveSessionCreationConfiguration(workspaceId, input)
    // 组合判定先于 Runtime：不满足时不 spawn，也不写 Session/Slot。
    assertRunnableCombination(configuration.connection)
    const runtimeInput = createProviderRuntimeInput(
      configuration.connection,
      this.definitions,
      this.environment,
    )
    let runtimeConnection: AgentRuntimeConnection | null = null
    let runtimeSession: AgentRuntimeSession | null = null

    try {
      runtimeConnection = await this.runtime.connect(runtimeInput)
      runtimeSession = await this.runtime.createSession(runtimeConnection, this.environment.cwd)
      runtimeSession = await this.applyModelSelection(runtimeSession, configuration.modelId)
      const now = this.clock.now().toISOString()
      const session: SessionDto = {
        id: this.ids.next('session'),
        workspace_id: workspaceId,
        name: input.name,
        status: 'active',
        created_at: now,
        updated_at: now,
      }
      const agentSlot: AgentSlotDto = {
        id: this.ids.next('slot'),
        session_id: session.id,
        ...(configuration.binding === null ? {} : { role_binding_id: configuration.binding.id }),
        model_id: configuration.modelId,
        status: 'idle',
        created_at: now,
      }
      const fingerprint = await this.definitions.fingerprint?.(configuration.connection.provider_kind) ?? null
      const attachment: RuntimeAttachmentRecord = {
        slot_id: agentSlot.id,
        session_id: session.id,
        provider_connection_id: configuration.connection.id,
        provider_kind: configuration.connection.provider_kind,
        config_revision: configuration.connection.config_revision,
        adapter_version: runtimeInput.adapterVersion,
        adapter_fingerprint: fingerprint,
        cwd: runtimeInput.cwd,
        runtime_directory: runtimeInput.runtimeDirectory,
        acp_session_id: runtimeSession.sessionId,
        updated_at: now,
      }
      const roleSnapshot = configuration.binding === null || configuration.role === null
        ? undefined
        : snapshotRole({ session, binding: configuration.binding, role: configuration.role }, agentSlot.id, now)
      await this.repository.saveSessionWithAttachment(session, agentSlot, attachment, roleSnapshot)
      this.runtimeSessions.set(agentSlot.id, runtimeSession)
      this.runtimeConnections.set(agentSlot.id, runtimeConnection)
      return { session, agentSlot }
    } catch (error: unknown) {
      if (runtimeSession !== null) {
        try {
          await this.runtime.closeSession(runtimeSession)
        } catch {
          // 保留创建错误，并继续关闭 Runtime connection。
        }
      }
      if (runtimeConnection !== null) {
        try {
          await this.closeConnection(runtimeConnection.connectionId)
        } catch {
          // 保留创建错误；Runtime teardown 失败不能覆盖原始原因。
        }
      }
      throw mapSessionCreationError(error)
    }
  }

  private async resolveSessionCreationConfiguration(
    workspaceId: string,
    input: CreateSessionRequest,
  ): Promise<SessionCreationConfiguration> {
    if ('role_binding_id' in input) {
      if (this.roleService === undefined) {
        throw new ApplicationError('Role 配置服务不可用', 'internal_error', 500)
      }
      const { binding, role } = await this.roleService.resolveBindingForWorkspace(
        workspaceId,
        input.role_binding_id,
      )
      return {
        connection: await this.requireWorkspaceProviderConnection(workspaceId, binding.provider_connection_id),
        modelId: binding.model_id,
        binding,
        role,
      }
    }
    return {
      connection: await this.requireWorkspaceProviderConnection(workspaceId, input.provider_connection_id),
      modelId: input.model_id,
      binding: null,
      role: null,
    }
  }

  private async requireWorkspaceProviderConnection(
    workspaceId: string,
    providerConnectionId: string,
  ): Promise<ProviderConnectionDto> {
    const connection = await this.repository.getProviderConnection(providerConnectionId)
    if (connection === null || connection.workspace_id !== workspaceId) {
      throw new ApplicationError('ProviderConnection 不属于当前 Workspace', 'not_found', 404, {
        resource: 'provider',
      })
    }
    return connection
  }

  /** 根据同 Workspace 的 RoleBinding 创建独立 AgentSlot 与 ACP Session。 */
  addAgentSlot(sessionId: string, input: AddAgentSlotRequest): Promise<AgentSlotDto> {
    return addRoleBoundAgentSlot({
      repository: this.repository,
      runtime: this.runtime,
      ids: this.ids,
      clock: this.clock,
      definitions: this.definitions,
      environment: this.environment,
      ...(this.roleService === undefined ? {} : { roleService: this.roleService }),
      applyModelSelection: (session, modelId) => this.applyModelSelection(session, modelId),
      registerRuntime: (slotId, session, connection) => {
        this.runtimeSessions.set(slotId, session)
        this.runtimeConnections.set(slotId, connection)
      },
      closeConnection: (connectionId) => this.closeConnection(connectionId),
    }, sessionId, input)
  }

  /** 删除非默认且空闲的 Slot；重复删除会继续尝试其 Runtime cleanup。 */
  async deleteAgentSlot(sessionId: string, slotId: string): Promise<void> {
    const session = await this.repository.getSession(sessionId)
    if (session === null) {
      throw new ApplicationError('Session 不存在', 'not_found', 404, { resource: 'session' })
    }
    const result = await this.repository.softDeleteAgentSlot(
      sessionId,
      slotId,
      this.clock.now().toISOString(),
    )
    if (result === 'not_found') {
      throw new ApplicationError('Agent Slot 不存在', 'not_found', 404, { resource: 'agent_slot' })
    }
    if (result === 'default_slot') {
      throw new ApplicationError('默认 Agent Slot 不能删除', 'state_conflict', 409)
    }
    if (result === 'slot_busy') {
      throw new ApplicationError('Agent Slot 仍有未完成的 Run', 'slot_busy', 409)
    }
    await this.cleanupDeletedSlotRuntime(slotId)
  }

  /**
   * retry 成功后替换活动 Runtime。
   *
   * 先切换引用，再依次关闭旧 Session 与旧连接；关闭失败不掩盖新 Runtime
   * 已接管的事实，但两条资源都会被尝试回收。
   */
  async replaceRuntimeSession(
    slotId: string,
    opened: { connection: AgentRuntimeConnection; session: AgentRuntimeSession },
  ): Promise<void> {
    const previousSession = this.runtimeSessions.get(slotId)
    const previousConnection = this.runtimeConnections.get(slotId)
    this.runtimeSessions.set(slotId, opened.session)
    this.runtimeConnections.set(slotId, opened.connection)
    if (previousSession === undefined || previousConnection === undefined) {
      return
    }
    if (previousSession.sessionId === opened.session.sessionId) {
      return
    }
    try {
      await this.runtime.closeSession(previousSession)
    } catch {
      // 继续回收旧连接。
    }
    await this.closeConnection(previousConnection.connectionId).catch(() => undefined)
  }

  /** retry 使用：连接当前 Provider、建立全新 ACP Session，并给出新 attachment。 */
  async openRuntimeSession(input: {
    sessionId: string
    slotId: string
    providerConnectionId: string
    modelId: string
  }): Promise<{
    connection: AgentRuntimeConnection
    session: AgentRuntimeSession
    attachment: RuntimeAttachmentRecord
  }> {
    const connection = await this.repository.getProviderConnection(input.providerConnectionId)
    if (connection === null) {
      throw new ApplicationError('ProviderConnection 不存在', 'not_found', 404, { resource: 'provider' })
    }
    assertRunnableCombination(connection)
    const runtimeInput = createProviderRuntimeInput(connection, this.definitions, this.environment)
    const runtimeConnection = await this.runtime.connect(runtimeInput)
    try {
      const created = await this.runtime.createSession(runtimeConnection, this.environment.cwd)
      const session = await this.applyModelSelection(created, input.modelId)
      const fingerprint = await this.definitions.fingerprint?.(connection.provider_kind) ?? null
      return {
        connection: runtimeConnection,
        session,
        attachment: {
          slot_id: input.slotId,
          session_id: input.sessionId,
          provider_connection_id: connection.id,
          provider_kind: connection.provider_kind,
          config_revision: connection.config_revision,
          adapter_version: runtimeInput.adapterVersion,
          adapter_fingerprint: fingerprint,
          cwd: runtimeInput.cwd,
          runtime_directory: runtimeInput.runtimeDirectory,
          acp_session_id: session.sessionId,
          updated_at: this.clock.now().toISOString(),
        },
      }
    } catch (error: unknown) {
      await this.closeConnection(runtimeConnection.connectionId).catch(() => undefined)
      throw error
    }
  }

  /** 启动恢复结果，只包含计数与稳定原因，不含路径或 Adapter 原文。 */
  async recover(): Promise<{ recovered: number; interrupted: number }> {
    let recovered = 0
    let interrupted = 0
    const attachments = await this.repository.listRuntimeAttachments()
    // Slot 属于哪个 Rolecast Session；防止把别的 Session 的 attachment 当成可恢复现场。
    const recoverableSlots = new Map<string, string>()
    const availableSessions = new Set<string>()
    for (const attachment of attachments) {
      recoverableSlots.set(attachment.slot_id, attachment.session_id)
      const resumed = await this.tryReattach(attachment)
      if (resumed === null) {
        interrupted += 1
        await this.convergeInterrupted(attachment, 'runtime_attachment_unavailable')
      } else {
        recovered += 1
        availableSessions.add(attachment.session_id)
        await this.convergePaused(attachment.session_id, attachment.slot_id)
      }
    }
    // Session 只有在所有 Slot Runtime 都不可用时才整体暂停。
    for (const sessionId of new Set(attachments.map((attachment) => attachment.session_id))) {
      if (availableSessions.has(sessionId)) {
        continue
      }
      const session = await this.repository.getSession(sessionId)
      if (session !== null && session.status === 'active') {
        await this.repository.saveSession({ ...session, status: 'paused', updated_at: this.clock.now().toISOString() })
      }
    }
    // 已软删除 Slot 不进入活动 Runtime；遗留 attachment 只用于 teardown-only 清理。
    interrupted += await this.cleanupDeletedSlotAttachments()
    // 历史库可能没有 attachment：这些 Run 无法重挂接，只能显式收敛。
    await this.convergeOrphanRuns(recoverableSlots)
    await this.rebuildSlotClaims()
    await this.reconcileCommandReceipts()
    return { recovered, interrupted }
  }

  /** 删除后的 attachment 只用于重挂接后关闭，不注册为可用 Agent Runtime。 */
  private async cleanupDeletedSlotAttachments(): Promise<number> {
    let failures = 0
    const attachments = await this.repository.listDeletedSlotRuntimeAttachments()
    for (const attachment of attachments) {
      if (!this.runtimeConnections.has(attachment.slot_id)) {
        const resumed = await this.tryReattach(attachment, true)
        if (resumed === null) {
          failures += 1
          continue
        }
      }
      try {
        await this.cleanupDeletedSlotRuntime(attachment.slot_id)
      } catch {
        // Keep the durable attachment so a later startup can retry cleanup.
      }
      if (await this.repository.getRuntimeAttachment(attachment.slot_id) !== null) {
        failures += 1
      }
    }
    return failures
  }

  /**
   * 收敛没有 attachment 的非终态 Run。
   *
   * 不猜 ACP Session，也不自动重跑；Run 显式进入 `interrupted`，Task 进入
   * `paused`，让用户决定 resume/retry（不存在 attachment 时命令会返回 409）。
   */
  private async convergeOrphanRuns(recoverableSlots: ReadonlyMap<string, string>): Promise<void> {
    const snapshots = new Map<string, Awaited<ReturnType<RepositoryPort['getSessionSnapshot']>>>()
    for (const run of await this.repository.listNonTerminalRuns()) {
      let snapshot = snapshots.get(run.session_id)
      if (snapshot === undefined) {
        snapshot = await this.repository.getSessionSnapshot(run.session_id)
        snapshots.set(run.session_id, snapshot)
      }
      const task = snapshot?.tasks.find((candidate) => candidate.run_id === run.id)
      if (task === undefined) {
        await this.finalizeRunById(run.id, 'interrupted', 'task_missing')
        continue
      }
      if (recoverableSlots.get(task.slot_id) === run.session_id) {
        continue
      }
      await this.finalizeRunById(run.id, 'interrupted', 'runtime_attachment_unavailable')
    }
  }

  /**
   * 启动时收敛未完成回执。
   *
   * 未越过 dispatch 的 `reserved/running+not_started` 归为可安全重试的
   * `failed/not_dispatched`；越过 dispatch 的 `running+started` 归为 `ambiguous`，
   * 同 key 不再自动派发。
   */
  private async reconcileCommandReceipts(): Promise<void> {
    const now = this.clock.now().toISOString()
    for (const receipt of await this.repository.listIncompleteCommandReceipts()) {
      if (receipt.dispatch_state === 'started') {
        await this.repository.updateCommandReceipt(
          { ...receipt, status: 'ambiguous', error_code: 'command_outcome_ambiguous', updated_at: now },
          receipt.status,
          receipt.dispatch_state,
        )
      } else {
        await this.repository.updateCommandReceipt(
          { ...receipt, status: 'failed', dispatch_state: 'not_started', error_code: 'command_not_dispatched', updated_at: now },
          receipt.status,
          receipt.dispatch_state,
        )
      }
    }
  }

  /** 按 attachment 尝试重挂接；失败返回 null，绝不自动新建上下文。 */
  private async tryReattach(
    attachment: RuntimeAttachmentRecord,
    keepConnectionOnCloseFailure = false,
  ): Promise<AgentRuntimeSession | null> {
    const connection = await this.repository.getProviderConnection(attachment.provider_connection_id)
    if (connection === null) {
      return null
    }
    if (
      connection.provider_kind !== attachment.provider_kind
      || connection.config_revision !== attachment.config_revision
    ) {
      return null
    }
    let runtimeInput
    try {
      assertRunnableCombination(connection)
      runtimeInput = createProviderRuntimeInput(connection, this.definitions, this.environment)
    } catch {
      return null
    }
    // 配置/身份必须与创建时完全一致：cwd 与运行时目录、Adapter 版本、可执行指纹。
    if (
      runtimeInput.cwd !== attachment.cwd
      || runtimeInput.runtimeDirectory !== attachment.runtime_directory
      || runtimeInput.adapterVersion !== attachment.adapter_version
    ) {
      return null
    }
    const currentFingerprint = await this.definitions.fingerprint?.(connection.provider_kind) ?? null
    if (
      attachment.adapter_fingerprint === null
      || currentFingerprint === null
      || currentFingerprint !== attachment.adapter_fingerprint
    ) {
      return null
    }

    let runtimeConnection: AgentRuntimeConnection | null = null
    try {
      runtimeConnection = await this.runtime.connect(runtimeInput)
      const runtimeSession = await this.runtime.resumeSession(
        runtimeConnection,
        attachment.acp_session_id,
        attachment.cwd,
      )
      this.runtimeSessions.set(attachment.slot_id, runtimeSession)
      this.runtimeConnections.set(attachment.slot_id, runtimeConnection)
      return runtimeSession
    } catch {
      if (runtimeConnection !== null) {
        if (keepConnectionOnCloseFailure && this.runtime.closeConnection === undefined) {
          // Keep the handle reachable by closeAll while the cleanup attachment remains.
          this.runtimeConnections.set(attachment.slot_id, runtimeConnection)
        } else {
          try {
            await this.closeConnection(runtimeConnection.connectionId)
          } catch {
            if (keepConnectionOnCloseFailure) {
              // Keep the handle reachable by closeAll while the cleanup attachment remains.
              this.runtimeConnections.set(attachment.slot_id, runtimeConnection)
            }
          }
        }
      }
      return null
    }
  }

  /** 按 Slot ID 重挂接指定 Runtime；供 Run resume 命令复用。 */
  async reattach(slotId: string): Promise<AgentRuntimeSession | null> {
    const existing = this.runtimeSessions.get(slotId)
    if (existing !== undefined) {
      return existing
    }
    const attachment = await this.repository.getRuntimeAttachment(slotId)
    return attachment === null ? null : this.tryReattach(attachment)
  }

  /** 成功恢复：非终态 Run/Task 在同一 CAS 事务中收敛为 paused，不自动 sendTurn。 */
  private async convergePaused(sessionId: string, slotId: string): Promise<void> {
    const snapshot = await this.repository.getSessionSnapshot(sessionId)
    if (snapshot === null) {
      return
    }
    const now = this.clock.now().toISOString()
    for (const run of snapshot.runs) {
      if (isTerminalRun(run.status)) {
        continue
      }
      const task = snapshot.tasks.find((candidate) => candidate.run_id === run.id)
      if (task === undefined || task.slot_id !== slotId) {
        continue
      }
      const revision = await this.repository.getRunStateRevision(run.id)
      if (revision === null) {
        continue
      }
      await this.repository.finalizeRun({
        run: { ...run, status: 'paused', updated_at: now },
        expectedStateRevision: revision,
        taskId: task.id,
        taskStatus: 'paused',
        slotId: task.slot_id,
        releaseClaim: false,
      })
    }
  }

  /** 仅收敛 attachment 所属 Slot 的 Run；同 Session 其他 Slot 可继续运行。 */
  private async convergeInterrupted(
    attachment: RuntimeAttachmentRecord,
    errorCode: string,
  ): Promise<void> {
    const snapshot = await this.repository.getSessionSnapshot(attachment.session_id)
    if (snapshot === null) {
      return
    }
    for (const run of snapshot.runs) {
      if (isTerminalRun(run.status)) {
        continue
      }
      const task = snapshot.tasks.find((candidate) => candidate.run_id === run.id)
      if (task === undefined || task.slot_id !== attachment.slot_id) {
        continue
      }
      await this.finalizeRunById(run.id, 'interrupted', errorCode)
    }
  }

  /**
   * 启动时按真实 Run/Task 状态重建 Slot claim。
   *
   * 单个非终态 Run 拥有 claim；同一 Slot 多个非终态 Run 无法判断谁拥有 ACP
   * Session，建立 recovery_conflict hold 让后续命令 fail-closed；没有非终态
   * Run 的残留 claim 清除。
   */
  private async rebuildSlotClaims(): Promise<void> {
    const now = this.clock.now().toISOString()
    const runsBySlot = new Map<string, string[]>()
    const snapshots = new Map<string, Awaited<ReturnType<RepositoryPort['getSessionSnapshot']>>>()
    for (const run of await this.repository.listNonTerminalRuns()) {
      let snapshot = snapshots.get(run.session_id)
      if (snapshot === undefined) {
        snapshot = await this.repository.getSessionSnapshot(run.session_id)
        snapshots.set(run.session_id, snapshot)
      }
      const task = snapshot?.tasks.find((candidate) => candidate.run_id === run.id)
      if (task === undefined || await this.repository.getAgentSlot(task.slot_id) === null) {
        continue
      }
      const runs = runsBySlot.get(task.slot_id) ?? []
      runs.push(run.id)
      runsBySlot.set(task.slot_id, runs)
    }
    const slots = new Set([
      ...runsBySlot.keys(),
      ...(await this.repository.listSlotActivityClaims()).map((claim) => claim.slot_id),
    ])
    for (const slotId of slots) {
      const runs = runsBySlot.get(slotId) ?? []
      await this.repository.resetSlotActivity(slotId)
      if (runs.length === 1) {
        await this.repository.claimSlotActivity(slotId, runs[0] as string, now)
      } else if (runs.length > 1) {
        await this.repository.setSlotRecoveryConflict(slotId, now)
      }
    }
  }

  /** 以当前 revision 把 Run/Task 收敛到指定状态；任务缺失时只收敛 Run。 */
  private async finalizeRunById(runId: string, status: RunDto['status'], errorCode: string): Promise<void> {
    const run = await this.repository.getRun(runId)
    if (run === null || isTerminalRun(run.status)) {
      return
    }
    const revision = await this.repository.getRunStateRevision(runId)
    if (revision === null) {
      return
    }
    const now = this.clock.now().toISOString()
    const snapshot = await this.repository.getSessionSnapshot(run.session_id)
    const task = snapshot?.tasks.find((candidate) => candidate.run_id === run.id)
    if (task === undefined) {
      await this.repository.updateRunIfRevision(
        { ...run, status, error_code: errorCode, ended_at: now, updated_at: now },
        revision,
      )
      return
    }
    await this.repository.finalizeRun({
      run: { ...run, status, error_code: errorCode, ended_at: now, updated_at: now },
      expectedStateRevision: revision,
      taskId: task.id,
      taskStatus: 'paused',
      slotId: task.slot_id,
      releaseClaim: false,
    })
  }

  /** 获取 Session。 */
  async require(id: string): Promise<SessionDto> {
    const session = await this.repository.getSession(id)
    if (session === null) {
      throw new ApplicationError('Session 不存在', 'not_found', 404, { resource: 'session' })
    }
    return session
  }

  /** 列出 Workspace 的 Session。 */
  list(workspaceId: string): Promise<SessionDto[]> {
    return this.repository.listSessions(workspaceId)
  }

  /** 返回 Session 综合快照。 */
  async snapshot(id: string) {
    const snapshot = await this.repository.getSessionSnapshot(id)
    if (snapshot === null) {
      throw new ApplicationError('Session 不存在', 'not_found', 404, { resource: 'session' })
    }
    return snapshot
  }

  /** 按 Slot ID 返回活动 Runtime；运行时不存在时由调用方转换错误。 */
  getRuntimeSession(slotId: string): AgentRuntimeSession | null {
    return this.runtimeSessions.get(slotId) ?? null
  }

  /** 关闭活动 ACP Session 和连接。 */
  async closeAll(): Promise<void> {
    const sessions = [...this.runtimeSessions.entries()]
    const connections = [...this.runtimeConnections.entries()]
    this.runtimeSessions.clear()
    this.runtimeConnections.clear()
    for (const [, runtimeSession] of sessions) {
      try {
        await this.runtime.closeSession(runtimeSession)
      } catch {
        // 关闭阶段继续清理其他 Runtime，底层进程回收由 Runtime 负责。
      }
    }
    for (const [slotId, connection] of connections) {
      if (this.runtime.closeConnection === undefined) {
        continue
      }
      try {
        await this.runtime.closeConnection(connection.connectionId)
      } catch {
        // 已删除 Slot 的 attachment 保留到下次启动重试清理。
        continue
      }
      if (await this.repository.getAgentSlot(slotId) === null) {
        try {
          await this.repository.deleteRuntimeAttachment(slotId)
        } catch {
          // Keep the cleanup record for the next startup and continue closing other Slots.
        }
      }
    }
  }

  private async applyModelSelection(
    session: AgentRuntimeSession,
    modelId: string,
  ): Promise<AgentRuntimeSession> {
    const modelOption = session.configOptions.find((option) => option.category === 'model')
    if (modelOption === undefined) {
      throw new ApplicationError('Provider 未暴露可选模型配置', 'provider_capability_not_supported', 422)
    }
    const selected = modelOption.options.find((option) => option.value === modelId)
    if (selected === undefined) {
      throw new ApplicationError('模型不在 Provider 当前能力目录中', 'model_unavailable', 422, {
        model_id: modelId,
      })
    }
    if (modelOption.currentValue === modelId) {
      return session
    }
    if (this.runtime.setConfigOption === undefined) {
      throw new ApplicationError('Runtime 不支持动态模型配置', 'provider_capability_not_supported', 422)
    }
    return this.runtime.setConfigOption(session, modelOption.id, modelId)
  }

  private async cleanupDeletedSlotRuntime(slotId: string): Promise<void> {
    const ongoing = this.runtimeCleanupOperations.get(slotId)
    if (ongoing !== undefined) {
      await ongoing
      return
    }
    const cleanup = this.closeDeletedSlotRuntime(slotId)
    this.runtimeCleanupOperations.set(slotId, cleanup)
    try {
      await cleanup
    } finally {
      if (this.runtimeCleanupOperations.get(slotId) === cleanup) {
        this.runtimeCleanupOperations.delete(slotId)
      }
    }
  }

  private async closeDeletedSlotRuntime(slotId: string): Promise<void> {
    const session = this.runtimeSessions.get(slotId)
    const connection = this.runtimeConnections.get(slotId)
    this.runtimeSessions.delete(slotId)
    if (session !== undefined) {
      try {
        await this.runtime.closeSession(session)
      } catch {
        // Connection close is still required when the ACP Session is already gone.
      }
    }
    if (connection === undefined || this.runtime.closeConnection === undefined) {
      return
    }
    try {
      await this.runtime.closeConnection(connection.connectionId)
    } catch {
      // Keep the connection and attachment cleanup record for closeAll/startup retry.
      return
    }
    this.runtimeConnections.delete(slotId)
    await this.repository.deleteRuntimeAttachment(slotId)
  }

  private async closeConnection(connectionId: string): Promise<void> {
    if (this.runtime.closeConnection !== undefined) {
      await this.runtime.closeConnection(connectionId)
    }
  }
}

function mapSessionCreationError(error: unknown): ApplicationError {
  if (isCodedError(error, 'credential_environment_mismatch')) {
    return new ApplicationError('凭据引用与连接环境模式不匹配', 'credential_environment_mismatch', 422)
  }
  if (isCodedError(error, 'provider_needs_configuration')) {
    return new ApplicationError('Provider 仍需要完成凭据配置', 'provider_needs_configuration', 422)
  }
  if (isCodedError(error, 'credential_denied')) {
    return new ApplicationError('凭据访问被拒绝', 'credential_denied', 403)
  }
  if (isCodedError(error, 'credentials_unavailable')) {
    return new ApplicationError('凭据存储不可用', 'credentials_unavailable', 503)
  }
  return new ApplicationError('Agent Session 创建失败', 'session_create_failed', 502)
}

/** Run 终态：不可被迟到事件覆盖。 */
const isTerminalRun = (status: string): boolean =>
  status === 'completed' || status === 'failed' || status === 'cancelled'
