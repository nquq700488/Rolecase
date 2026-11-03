import { lstat, opendir } from 'node:fs/promises'
import type { Dirent, Stats } from 'node:fs'
import { join } from 'node:path'

/**
 * Claude transcript 元数据诊断（test-only）。
 *
 * 只做流式 readdir/lstat：不打开或读取文件内容，不跟随 symlink。
 * 输出仅含相对路径、是否普通文件、size 与 nlink；无绝对路径、无 canary。
 */

export const TRANSCRIPT_SCAN_MAX_DEPTH = 5
export const TRANSCRIPT_SCAN_MAX_ENTRIES_PER_DIRECTORY = 100
export const TRANSCRIPT_SCAN_MAX_ENTRIES = 500
export const TRANSCRIPT_SCAN_MAX_MATCHES = 5
export const TRANSCRIPT_SCAN_MAX_SYMLINKS = 5
export const TRANSCRIPT_EVIDENCE_MAX_LENGTH = 240

export interface TranscriptMetadata {
  readonly relativePath: string
  readonly size: number
  readonly nlink: number
}

/** 扫描失败类别；与“是否已截断/停止遍历”相互独立。 */
export type TranscriptScanFailure = 'opendir' | 'lstat' | 'scan' | 'symlink'

/** 可流式迭代并显式关闭的目录句柄（fs.Dir 的结构子集）。 */
export interface TranscriptDirectory extends AsyncIterable<Dirent> {
  close(): Promise<void>
}

/** 测试注入 seam：默认使用真实 fs。 */
export interface TranscriptScanIo {
  readonly opendir?: (path: string) => Promise<TranscriptDirectory>
  readonly lstat?: (path: string) => Promise<Stats>
}

/** 一次 transcript 扫描的共享状态与 I/O（显式 scan context）。 */
interface TranscriptScanContext {
  readonly targetName: string
  readonly openDirectory: (path: string) => Promise<TranscriptDirectory>
  readonly statEntry: (path: string) => Promise<Stats>
  readonly matches: TranscriptMetadata[]
  readonly symlinks: string[]
  readonly failures: Set<TranscriptScanFailure>
  truncated: boolean
  visited: number
}

/**
 * 收集匹配 sessionId 的 Claude transcript 元数据。
 *
 * 流式消费目录项（不一次性收集/排序），受每目录、全局条目、深度与匹配数上限约束；
 * 任一上限触发后立即停止后续迭代与子目录打开，即使此前已发生 scan-incomplete。
 * 只有完整扫描且无匹配时才报告 not-found。
 */
export async function describeClaudeTranscript(
  adapterRoot: string,
  sessionId: string,
  canary: string,
  io: TranscriptScanIo = {},
): Promise<string> {
  const context: TranscriptScanContext = {
    targetName: `${sessionId}.jsonl`,
    openDirectory: io.opendir ?? opendir,
    statEntry: io.lstat ?? lstat,
    matches: [],
    symlinks: [],
    failures: new Set<TranscriptScanFailure>(),
    truncated: false,
    visited: 0,
  }

  try {
    await scanDirectory(context, adapterRoot, '', 0)
  } catch {
    context.failures.add('scan')
  }
  return formatTranscriptEvidence(context.matches, context.symlinks, context.truncated, context.failures, canary)
}

/** 流式遍历单个目录；每个目录项的判定委托给 `scanEntry`。 */
async function scanDirectory(
  context: TranscriptScanContext,
  directoryPath: string,
  relativeDirectory: string,
  depth: number,
): Promise<void> {
  if (context.truncated) {
    return
  }
  if (depth > TRANSCRIPT_SCAN_MAX_DEPTH) {
    context.truncated = true
    return
  }
  let directory: TranscriptDirectory
  try {
    directory = await context.openDirectory(directoryPath)
  } catch {
    context.failures.add('opendir')
    return
  }
  let perDirectory = 0
  try {
    for await (const entry of directory) {
      if (context.truncated) {
        return
      }
      if (perDirectory >= TRANSCRIPT_SCAN_MAX_ENTRIES_PER_DIRECTORY) {
        context.truncated = true
        return
      }
      if (context.visited >= TRANSCRIPT_SCAN_MAX_ENTRIES) {
        context.truncated = true
        return
      }
      perDirectory += 1
      context.visited += 1
      await scanEntry(context, directoryPath, relativeDirectory, depth, entry)
      if (context.truncated) {
        return
      }
    }
  } finally {
    await closeDirectory(directory)
  }
}

/** 对单个目录项做 lstat 与分类；symlink 只记录相对路径且不跟随。 */
async function scanEntry(
  context: TranscriptScanContext,
  directoryPath: string,
  relativeDirectory: string,
  depth: number,
  entry: Dirent,
): Promise<void> {
  const name = entry.name
  const path = join(directoryPath, name)
  const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`
  let info: Stats
  try {
    info = await context.statEntry(path)
  } catch {
    context.failures.add('lstat')
    return
  }
  if (info.isSymbolicLink()) {
    // 任意 symlink 都意味着扫描不可能完整（未跟随目标）；只记录相对路径。
    context.failures.add('symlink')
    if (context.symlinks.length < TRANSCRIPT_SCAN_MAX_SYMLINKS) {
      context.symlinks.push(relativePath)
    }
    return
  }
  if (info.isDirectory()) {
    await scanDirectory(context, path, relativePath, depth + 1)
    return
  }
  if (name === context.targetName && info.isFile()) {
    context.matches.push({
      relativePath,
      size: Number(info.size),
      nlink: Number(info.nlink),
    })
    if (context.matches.length >= TRANSCRIPT_SCAN_MAX_MATCHES) {
      context.truncated = true
    }
  }
}

/** 把元数据格式化为有界诊断；只有完整扫描才允许报告 not-found。 */
function formatTranscriptEvidence(
  matches: readonly TranscriptMetadata[],
  symlinks: readonly string[],
  truncated: boolean,
  failures: ReadonlySet<TranscriptScanFailure>,
  canary: string,
): string {
  const parts = [
    ...matches.map((match) => `${match.relativePath} (file, size=${String(match.size)}, nlink=${String(match.nlink)})`),
    ...symlinks.map((symlink) => `${symlink} (symlink, not followed)`),
  ].sort()
  const details: string[] = []
  if (failures.size > 0) {
    details.push(`scan-incomplete (${[...failures].sort().join(', ')})`)
  }
  if (truncated) {
    details.push('scan-truncated')
  }
  if (details.length === 0) {
    if (parts.length === 0) {
      return sanitizeDiagnosticText('claude transcript metadata: not-found', canary)
        .slice(0, TRANSCRIPT_EVIDENCE_MAX_LENGTH)
    }
    return sanitizeDiagnosticText(`claude transcript metadata: ${parts.join(', ')}`, canary)
      .slice(0, TRANSCRIPT_EVIDENCE_MAX_LENGTH)
  }
  const detail = details.join(', ')
  const text = parts.length === 0
    ? `claude transcript metadata: ${detail}`
    : `claude transcript metadata (${detail}): ${parts.join(', ')}`
  return sanitizeDiagnosticText(text, canary).slice(0, TRANSCRIPT_EVIDENCE_MAX_LENGTH)
}

/** 将已脱敏的 transcript 证据附加到失败诊断。 */
export function attachTranscriptEvidence(failure: Error, evidence: string | null): Error {
  return evidence === null ? failure : new Error(`${failure.message}; ${evidence}`)
}

/** 流式 Dir 迭代结束会自动关闭；显式关闭兜底，并忽略已关闭错误。 */
async function closeDirectory(directory: TranscriptDirectory): Promise<void> {
  try {
    await directory.close()
  } catch (error: unknown) {
    if (!isDirectoryClosedError(error)) {
      throw error
    }
  }
}

function isDirectoryClosedError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ERR_DIR_CLOSED'
}

/**
 * 统一诊断脱敏：canary 与 Unix/Windows/UNC 绝对路径都不能进入诊断。
 *
 * 兼容 Node filesystem error 的引号形式（如 `scandir '/tmp/...'`）；
 * symlink 扫描使用的相对路径不受影响。
 */
export function sanitizeDiagnosticText(text: string, canary: string): string {
  return redactCanary(text, canary)
    // 引号包裹的绝对路径（含 Windows drive 与 UNC，Node fs error 常见形式）：
    // 允许空格，整段脱敏。
    .replace(/(^|[\s:(=])(['"])(?:[A-Za-z]:\\|\\\\|\/)[^'"]*\2/g, '$1$2[redacted-path]$2')
    // 未加引号的绝对路径。
    .replace(/(^|[\s:(='"])(?:[A-Za-z]:\\|\\\\|\/)[^\s'"]+/g, '$1[redacted-path]')
    .slice(0, 240)
}

export function redactCanary(text: string, canary: string): string {
  return canary.length === 0 ? text : text.split(canary).join('[redacted]')
}
