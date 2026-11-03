import { randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { resolveAdapterCommand, type CredentialStorePort } from '@rolecast/server'

const CLAUDE_ADAPTER_PACKAGE_VERSION = '0.90.0'
const CLAUDE_SDK_PACKAGE_VERSION = '0.3.296'
const PROXY_EVIDENCE_READ_CHUNK_BYTES = 64 * 1024
const ADAPTER_PROXY_SOURCE_MARKERS = [
  'const userProvidedOptions = sessionMeta?.claudeCode?.options;',
  'const tools = userProvidedOptions?.tools ??',
  '...userProvidedOptions,',
  'const q = query({',
] as const
const ADAPTER_PROXY_ENV_FLOW_MARKERS = [
  '...process.env,',
  '...userProvidedOptions?.env,',
] as const
const SDK_PROXY_SOURCE_MARKERS = [
  'env:c={...process.env}',
  'env:o,windowsHide:!0',
  'if(p)K.push(je("--max-turns",p));',
  'if(f!==void 0)K.push(je("--max-budget-usd",f));',
  'K.push(je("--tools",de.join(",")))',
] as const
const CLAUDE_CLI_PROXY_BINARY_MARKERS = [
  'env.https_proxy || env.HTTPS_PROXY',
  'getProxyFetchOptions:p',
  'p({forAnthropicAPI:!0,url:String(E)})',
  'process?.env?.HTTPS_PROXY',
  'new a(n,{cert:r.cert,key:r.key})',
] as const

/**
 * Claude 单轮 live smoke 的 test-only 安全脚手架。
 *
 * 锁定 CLI 二进制含有 Anthropic API 的 HTTPS_PROXY 配置路径；Batch 0 其余
 * broker/sandbox 验证与 Batch 1/2 门禁未完成前，正向 live gate 仍必须阻断。
 */

export const LIVE_GATE_ENV = 'RUN_CLAUDE_SESSION_RESUME_LIVE_SMOKE'
export const CREDENTIAL_REF_ENV = 'ROLECAST_CLAUDE_CREDENTIAL_REF'
export const LIVE_PROMPT = 'Reply with the single word ACK and nothing else.'
export const SYNTHETIC_PROMPT = LIVE_PROMPT

export type LiveGateBlockReason =
  | 'gate_disabled'
  | 'https_proxy_unproven'
  | 'batch0_incomplete'
  | 'offline_resume_unproven'
  | 'local_safety_unproven'
  | 'credential_ref_missing'

export interface LiveGateEnvironment {
  readonly liveEnabled: boolean
  /** 锁定 Adapter/SDK 源码是否证明 Anthropic API 请求走显式 HTTPS_PROXY。 */
  readonly httpsProxyProven: boolean
  /** Batch 0 broker、sandbox 与 ACP/SDK 选项证据是否全部通过。 */
  readonly batch0Complete?: boolean
  /** Batch 1 deny-all offline resume gate 是否通过。 */
  readonly offlineResumePassed?: boolean
  /** Batch 2 锁、Keychain 失败门禁与 cleanup 是否全部通过。 */
  readonly localSafetyPassed?: boolean
  readonly credentialRef?: string | undefined
}

export interface LiveGateDecision {
  readonly allowed: boolean
  readonly reason: LiveGateBlockReason | 'allowed'
}

/**
 * Live gate 前置判定；只做纯判定，不读取 Keychain、不 spawn、不监听。
 */
export function evaluateLiveGate(environment: LiveGateEnvironment): LiveGateDecision {
  if (!environment.liveEnabled) {
    return { allowed: false, reason: 'gate_disabled' }
  }
  if (!environment.httpsProxyProven) {
    return { allowed: false, reason: 'https_proxy_unproven' }
  }
  if (environment.batch0Complete !== true) {
    return { allowed: false, reason: 'batch0_incomplete' }
  }
  if (environment.offlineResumePassed !== true) {
    return { allowed: false, reason: 'offline_resume_unproven' }
  }
  if (environment.localSafetyPassed !== true) {
    return { allowed: false, reason: 'local_safety_unproven' }
  }
  if (environment.credentialRef === undefined || environment.credentialRef.length === 0) {
    return { allowed: false, reason: 'credential_ref_missing' }
  }
  return { allowed: true, reason: 'allowed' }
}

export interface LiveGateActions {
  readonly readCredential: () => Promise<void>
  readonly bindBroker: () => Promise<void>
  readonly spawnAdapter: () => Promise<void>
}

/**
 * 按门禁顺序执行副作用：只有 gate 允许后才 bind broker → 读 Keychain → spawn。
 * 被阻断时不调用任何 action。
 */
export async function runLiveGatePreflight(
  environment: LiveGateEnvironment,
  actions: LiveGateActions,
): Promise<LiveGateDecision> {
  const decision = evaluateLiveGate(environment)
  if (!decision.allowed) {
    return decision
  }
  await actions.bindBroker()
  await actions.readCredential()
  await actions.spawnAdapter()
  return decision
}

/** 锁定源码是否出现显式 HTTPS_PROXY / ProxyAgent 证据。 */
export function containsProxyEvidence(text: string): boolean {
  return /HTTPS_PROXY|https_proxy|ProxyAgent/.test(text)
}

/**
 * @name pinnedClaudeProxyEvidence
 * @description 核对锁定 Adapter → SDK → CLI 二进制的 HTTPS_PROXY 请求路径证据
 * @return {Promise<boolean>} 证据缺失、版本不符或读取失败时返回 false
 */
export async function pinnedClaudeProxyEvidence(): Promise<boolean> {
  if (
    process.platform !== 'darwin'
    || !['arm64', 'x64'].includes(process.arch)
    || process.env.CLAUDE_CODE_EXECUTABLE !== undefined
  ) {
    return false
  }
  try {
    const adapter = resolveAdapterCommand('claude', undefined)
    const adapterEntry = adapter.args[0]
    if (adapterEntry === undefined) {
      return false
    }

    const adapterDirectory = dirname(adapterEntry)
    const adapterRoot = resolve(adapterDirectory, '..')
    const adapterSource = await readFile(join(adapterDirectory, 'acp-agent.js'), 'utf8')
    if (
      !(await manifestHasVersion(join(adapterRoot, 'package.json'), CLAUDE_ADAPTER_PACKAGE_VERSION))
      || !containsAllSourceMarkers(adapterSource, ADAPTER_PROXY_SOURCE_MARKERS)
      || !hasAdapterProxyEnvironmentFlow(adapterSource)
    ) {
      return false
    }

    const adapterRequire = createRequire(adapterEntry)
    const sdkEntry = adapterRequire.resolve('@anthropic-ai/claude-agent-sdk')
    const sdkSource = await readFile(sdkEntry, 'utf8')
    if (
      !(await manifestHasVersion(join(dirname(sdkEntry), 'package.json'), CLAUDE_SDK_PACKAGE_VERSION))
      || !containsAllSourceMarkers(sdkSource, SDK_PROXY_SOURCE_MARKERS)
    ) {
      return false
    }

    const sdkRequire = createRequire(sdkEntry)
    const cliEntry = sdkRequire.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
    )
    if (!(await manifestHasVersion(join(dirname(cliEntry), 'package.json'), CLAUDE_SDK_PACKAGE_VERSION))) {
      return false
    }
    return await fileContainsAllMarkers(cliEntry, CLAUDE_CLI_PROXY_BINARY_MARKERS)
  } catch {
    return false
  }
}

function containsAllSourceMarkers(source: string, markers: readonly string[]): boolean {
  return markers.every((marker) => source.includes(marker))
}

/**
 * @name hasAdapterProxyEnvironmentFlow
 * @description 确认锁定 Adapter 将 process.env 和 ACP env 传入 SDK query
 * @param {string} source Adapter 源码
 * @return {boolean} 环境转发路径完整时为 true
 */
export function hasAdapterProxyEnvironmentFlow(source: string): boolean {
  const environmentStart = source.indexOf('const env = {')
  if (environmentStart < 0) {
    return false
  }
  const queryStart = source.indexOf('const q = query({', environmentStart)
  if (queryStart < 0) {
    return false
  }
  const environmentFlow = source.slice(environmentStart, queryStart)
  return containsAllSourceMarkers(environmentFlow, ADAPTER_PROXY_ENV_FLOW_MARKERS)
    && /(?:^|\n)\s*env,\s*(?:\n|$)/.test(environmentFlow)
}

async function manifestHasVersion(path: string, expectedVersion: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      return false
    }
    return Reflect.get(manifest, 'version') === expectedVersion
  } catch {
    return false
  }
}

async function fileContainsAllMarkers(path: string, markers: readonly string[]): Promise<boolean> {
  if (markers.length === 0 || markers.some((marker) => marker.length === 0)) {
    return false
  }

  const markerBuffers = markers.map((marker) => Buffer.from(marker))
  const maxMarkerLength = Math.max(...markerBuffers.map((marker) => marker.length))
  const foundMarkers = new Set<number>()
  let carry = Buffer.alloc(0)

  try {
    for await (const chunk of createReadStream(path, { highWaterMark: PROXY_EVIDENCE_READ_CHUNK_BYTES })) {
      const contents = carry.length === 0 ? chunk : Buffer.concat([carry, chunk])
      for (const [index, marker] of markerBuffers.entries()) {
        if (!foundMarkers.has(index) && contents.includes(marker)) {
          foundMarkers.add(index)
        }
      }
      if (foundMarkers.size === markerBuffers.length) {
        return true
      }
      carry = contents.subarray(Math.max(0, contents.length - maxMarkerLength + 1))
    }
  } catch {
    return false
  }
  return false
}

/** 读取给定源码路径并判断是否存在代理证据；读取失败视为无证据。 */
export async function hasProxyEvidence(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    try {
      if (containsProxyEvidence(await readFile(path, 'utf8'))) {
        return true
      }
    } catch {
      continue
    }
  }
  return false
}

/**
 * raw ACP `session/new` 参数：tools 必须为空，且预算/轮次受限。
 */
export function buildSessionNewParams(cwd: string): Record<string, unknown> {
  return {
    cwd,
    mcpServers: [],
    _meta: {
      claudeCode: {
        options: {
          tools: [],
          maxTurns: 1,
          maxBudgetUsd: 1,
        },
      },
    },
  }
}

/** raw ACP 唯一一条 prompt 参数。 */
export function buildPromptParams(sessionId: string): Record<string, unknown> {
  return {
    sessionId,
    prompt: [{ type: 'text', text: LIVE_PROMPT }],
  }
}

/** 反向请求处理：任何 tool/permission/terminal/filesystem 请求都拒绝。 */
export function rejectReverseRequest(method: string): { error: { code: number; message: string } } {
  return { error: { code: -32601, message: `disabled during resume gate: ${method}` } }
}

export interface SyntheticTranscriptRecord {
  readonly type: 'user' | 'assistant'
  readonly uuid: string
  readonly sessionId: string
  readonly parentUuid?: string
  readonly message: Record<string, unknown>
  readonly origin?: Record<string, unknown>
}

/**
 * 构造两条 synthetic 主线程 JSONL 记录（user + assistant）。
 *
 * 仅用于离线 resume 可行性 gate；不冒充 Adapter A 的真实 turn。
 */
export function buildSyntheticTranscript(sessionId: string): { records: SyntheticTranscriptRecord[]; jsonl: string } {
  const userUuid = randomUUID()
  const assistantUuid = randomUUID()
  const records: SyntheticTranscriptRecord[] = [
    {
      type: 'user',
      uuid: userUuid,
      sessionId,
      message: { role: 'user', content: [{ type: 'text', text: SYNTHETIC_PROMPT }] },
      origin: { kind: 'human' },
    },
    {
      type: 'assistant',
      uuid: assistantUuid,
      sessionId,
      parentUuid: userUuid,
      message: {
        role: 'assistant',
        model: 'synthetic-offline-gate',
        content: [{ type: 'text', text: 'ACK' }],
        stop_reason: 'end_turn',
      },
    },
  ]
  return { records, jsonl: `${records.map((record) => JSON.stringify(record)).join('\n')}\n` }
}

/**
 * @name validateSyntheticTranscriptShape
 * @description 只校验 synthetic JSONL 的字段形状，不代表锁定 SDK reader 可解析
 * @param {string} jsonl Synthetic JSONL 文本
 * @param {string} sessionId 预期 session id
 * @return {void} 形状错误时抛出异常
 */
export function validateSyntheticTranscriptShape(jsonl: string, sessionId: string): void {
  const lines = jsonl.split('\n').filter((line) => line.length > 0)
  if (lines.length !== 2) {
    throw new Error('synthetic transcript must contain exactly two records')
  }
  const records = lines.map((line) => JSON.parse(line) as Partial<SyntheticTranscriptRecord>)
  const [user, assistant] = records
  if (user?.type !== 'user' || assistant?.type !== 'assistant') {
    throw new Error('synthetic transcript must be user then assistant')
  }
  if (user.sessionId !== sessionId || assistant.sessionId !== sessionId) {
    throw new Error('synthetic transcript session id mismatch')
  }
  if (typeof user.uuid !== 'string' || typeof assistant.uuid !== 'string') {
    throw new Error('synthetic transcript records require uuid')
  }
  if (assistant.parentUuid !== user.uuid) {
    throw new Error('synthetic assistant must reference the user uuid')
  }
  if (user.origin === undefined) {
    throw new Error('synthetic user record requires origin')
  }
  if (assistant.message?.stop_reason !== 'end_turn' || typeof assistant.message.model !== 'string') {
    throw new Error('synthetic assistant record requires model and end_turn')
  }
}

/** 凭据缺失/不可用的稳定分类；绝不包含原值。 */
export type CredentialGateFailure = 'missing' | 'denied' | 'unavailable'

export async function readCredentialForLiveGate(
  reference: string | undefined,
  store: CredentialStorePort,
): Promise<{ ok: true; secret: string } | { ok: false; failure: CredentialGateFailure }> {
  if (reference === undefined || reference.length === 0) {
    return { ok: false, failure: 'missing' }
  }
  try {
    const secret = await store.get(reference)
    if (secret === null || secret.length === 0) {
      return { ok: false, failure: 'missing' }
    }
    return { ok: true, secret }
  } catch (error: unknown) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined
    if (code === 'credential_denied' || code === 'credential_not_found') {
      return { ok: false, failure: code === 'credential_denied' ? 'denied' : 'missing' }
    }
    return { ok: false, failure: 'unavailable' }
  }
}

/** 跨进程 live gate 锁；父目录必须是当前用户 0700 的真实目录。 */
export async function acquireLiveGateLock(
  lockPath: string,
  createLock: (path: string) => Promise<{ close(): Promise<void> }> = defaultCreateLock,
): Promise<() => Promise<void>> {
  const parent = dirname(resolve(lockPath))
  const parentInfo = await lstat(parent)
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error('live gate lock parent must be a real directory')
  }
  if ((parentInfo.mode & 0o077) !== 0) {
    throw new Error('live gate lock parent must not be group/world accessible')
  }
  if (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid()) {
    throw new Error('live gate lock parent must be owned by the current user')
  }
  let handle: { close(): Promise<void> }
  try {
    handle = await createLock(lockPath)
  } catch {
    throw new Error('live gate lock already held')
  }
  return async () => {
    await handle.close()
    try {
      await unlink(lockPath)
    } catch {
      // 锁无法删除时保留并 fail-closed，后续实例会继续被阻断。
      throw new Error('live gate lock could not be removed; lock retained')
    }
  }
}

async function defaultCreateLock(path: string): Promise<{ close(): Promise<void> }> {
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
    0o600,
  )
  await handle.writeFile(`${String(process.pid)}\n`, 'utf8')
  return handle
}

/** 私有 tmp 锁目录；不存在时创建为 0700。 */
export async function ensureLockDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
}

export function liveGateLockPath(tmpDirectory: string, runId: string): string {
  return resolve(tmpDirectory, `rolecast-claude-live-${runId}.lock`)
}
