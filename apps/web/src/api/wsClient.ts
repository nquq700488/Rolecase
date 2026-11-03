import { eventEnvelopeSchema, wsServerControlSchema, type EventEnvelope, type WsServerControl } from '@rolecast/contract'

import { getLocalToken } from './httpClient.js'

/** WebSocket 连接状态。 */
export type WsStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed' | 'error'

/** 单一 Rolecast WebSocket 客户端，业务组件不直接接触原生 WebSocket。 */
export class WsClient {
  private socket: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private reconnectAttempt = 0
  private runs: Array<{ run_id: string; last_sequence: number }> = []
  private workspaceId: string | null = null
  private status: WsStatus = 'idle'

  constructor(
    private readonly onEvent: (event: EventEnvelope) => void,
    private readonly onControl: (control: WsServerControl) => void,
    private readonly onStatus: (status: WsStatus) => void,
  ) {}

  /** 启动连接，并在认证后请求事件续传。 */
  start(workspaceId: string, runs: readonly { run_id: string; last_sequence: number }[]): void {
    this.workspaceId = workspaceId
    this.runs = runs.map((run) => ({ ...run }))
    this.stopped = false
    this.connect()
  }

  /** 更新待续传的 Run 游标。 */
  updateRuns(runs: readonly { run_id: string; last_sequence: number }[]): void {
    this.runs = runs.map((run) => ({ ...run }))
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.sendResume()
    }
  }

  /** 关闭连接并取消重连。 */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.socket?.close()
    this.socket = null
    this.setStatus('closed')
  }

  private connect(): void {
    if (this.stopped) {
      return
    }
    this.setStatus(this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting')
    const token = getLocalToken()
    if (token === null) {
      this.setStatus('error')
      return
    }
    const url = websocketUrl()
    const socket = new WebSocket(url)
    this.socket = socket
    socket.addEventListener('open', () => {
      this.reconnectAttempt = 0
      if (this.workspaceId === null) {
        socket.close(1008, 'workspace scope required')
        return
      }
      socket.send(JSON.stringify({ type: 'auth', token, workspace_id: this.workspaceId }))
    })
    socket.addEventListener('message', (message) => this.handleMessage(message.data))
    socket.addEventListener('close', () => {
      if (this.socket === socket) {
        this.socket = null
      }
      if (!this.stopped) {
        this.scheduleReconnect()
      }
    })
    socket.addEventListener('error', () => this.setStatus('error'))
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') {
      return
    }
    let data: unknown
    try {
      data = JSON.parse(raw) as unknown
    } catch {
      this.setStatus('error')
      return
    }
    const control = wsServerControlSchema.safeParse(data)
    if (control.success) {
      this.onControl(control.data)
      if (control.data.type === 'authenticated') {
        this.setStatus('connected')
        this.sendResume()
      }
      return
    }
    const event = eventEnvelopeSchema.safeParse(data)
    if (event.success) {
      const current = this.runs.find((run) => run.run_id === event.data.run_id)
      this.runs = this.runs.map((run) => run.run_id === event.data.run_id
        ? { ...run, last_sequence: Math.max(run.last_sequence, event.data.sequence) }
        : run)
      if (current === undefined) {
        this.runs = [...this.runs, { run_id: event.data.run_id, last_sequence: event.data.sequence }]
      }
      this.onEvent(event.data)
    }
  }

  private sendResume(): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'resume', runs: this.runs }))
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return
    }
    const delay = Math.min(4_000, 250 * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setStatus(status: WsStatus): void {
    this.status = status
    this.onStatus(status)
  }
}

const websocketUrl = (): string => {
  const configured = import.meta.env.VITE_API_BASE_URL as string | undefined
  if (configured !== undefined && configured.length > 0) {
    return configured.replace(/^http/, 'ws') + '/api/ws'
  }
  return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/ws`
}
