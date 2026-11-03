/** 时间来源 Port，允许业务状态机在测试中注入确定性时间。 */
export interface ClockPort {
  /** 返回当前时间。 */
  now(): Date
}

/** 使用系统时钟的默认实现。 */
export const systemClock: ClockPort = {
  now: (): Date => new Date(),
}
