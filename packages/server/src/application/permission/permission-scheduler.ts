import type { PermissionRequestDto } from '@rolecast/contract'

import type { AgentRuntimePort, AgentRuntimeSession } from '../ports/agent-runtime-port.js'
import type { ClockPort } from '../ports/clock-port.js'
import {
  PermissionStateCoordinator,
  type PermissionRuntimePort,
} from './permission-state-coordinator.js'
import type { RepositoryPort } from '../ports/repository-port.js'

interface ActivePermission {
  readonly coordinator: PermissionStateCoordinator
  readonly runtimeSession: AgentRuntimeSession
}

/**
 * @name PermissionScheduler
 * @description 驱动运行中 PermissionRequest 的软提醒和硬超时，不依赖浏览器在线状态
 */
export class PermissionScheduler {
  private readonly active = new Map<string, ActivePermission>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  constructor(
    private readonly repository: RepositoryPort,
    private readonly runtime: AgentRuntimePort,
    private readonly clock: ClockPort,
    private readonly intervalMs = 1_000,
  ) {}

  /** 注册请求并立即持久化 pending 状态。 */
  async register(request: PermissionRequestDto, runtimeSession: AgentRuntimeSession): Promise<void> {
    const active = this.createActive(runtimeSession)
    await active.coordinator.register(request)
    this.active.set(request.id, active)
  }

  /** 回答请求，成功后移出调度集合。 */
  async answer(requestId: string, optionId: string): Promise<void> {
    const active = this.active.get(requestId)
    if (active === undefined) {
      throw new Error(`Permission request is not attached to an active Runtime: ${requestId}`)
    }
    await active.coordinator.answer(requestId, optionId)
    this.active.delete(requestId)
  }

  /**
   * 取消仍挂在活动 Runtime 上的权限请求。
   *
   * 返回 false 表示请求没有活动的 Runtime 协调器；调用方必须据此判断请求是否
   * 仍在 pending，不能把「没有可取消的协调器」当成取消成功。
   */
  async cancel(requestId: string): Promise<boolean> {
    const active = this.active.get(requestId)
    if (active === undefined) {
      return false
    }
    await active.coordinator.cancel(requestId)
    this.active.delete(requestId)
    return true
  }

  /** 启动服务端定时扫描。 */
  start(): void {
    if (this.timer !== null) {
      return
    }
    this.timer = setInterval(() => {
      void this.tickNow().catch(() => undefined)
    }, this.intervalMs)
  }

  /** 停止扫描并释放定时器。 */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** 执行一次基于服务端时钟的扫描，供启动流程和测试调用。 */
  async tickNow(at: Date = this.clock.now()): Promise<void> {
    if (this.ticking) {
      return
    }
    this.ticking = true
    try {
      for (const [requestId, active] of this.active) {
        try {
          await active.coordinator.tick(requestId, at)
          const current = await this.repository.getPermissionRequest(requestId)
          if (current === null || current.status !== 'pending') {
            this.active.delete(requestId)
          }
        } catch {
          // Runtime 暂时不可用时保留 pending，下一轮继续尝试并由状态协调器保证幂等。
        }
      }
    } finally {
      this.ticking = false
    }
  }

  private createActive(runtimeSession: AgentRuntimeSession): ActivePermission {
    const permissionRuntime: PermissionRuntimePort = {
      respondPermission: async (input) => {
        await this.runtime.respondPermission({
          session: runtimeSession,
          requestId: input.requestId,
          ...(input.optionId === undefined ? {} : { optionId: input.optionId }),
          ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
        })
      },
    }
    return {
      runtimeSession,
      coordinator: new PermissionStateCoordinator(this.repository, permissionRuntime, this.clock),
    }
  }
}
