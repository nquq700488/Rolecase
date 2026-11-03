import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

/** Adapter 身份输入：只包含非秘密的启动身份。 */
export interface AdapterFingerprintInput {
  readonly providerKind: 'claude' | 'codex'
  readonly command: string
  readonly args: readonly string[]
}

/**
 * @name computeAdapterFingerprint
 * @description 由实际 spawn 的可执行身份、入口内容与参数生成私有指纹
 *
 * 只比较固定 `adapter_version` 无法识别「同路径二进制被替换」或 override 改变。
 * 指纹输入包含解析后的 executable 路径与内容 digest、每个可验证入口文件的
 * 路径与内容 digest，以及原始非秘密参数；任一身份无法可靠判定时返回 null
 * （fail-closed）。指纹只保存在私有数据库，不输出路径、参数原文或 Secret。
 * @param {AdapterFingerprintInput} input 非秘密启动身份
 * @return {Promise<string | null>} sha256 指纹；无法可靠判定时返回 null
 * @example
 * await computeAdapterFingerprint({ providerKind: 'claude', command: process.execPath, args: ['/adapter/index.js'] })
 */
export async function computeAdapterFingerprint(
  input: AdapterFingerprintInput,
): Promise<string | null> {
  // 实际 spawn 的可执行身份必须参与指纹：同路径替换 Node/Adapter 二进制
  // 时固定 adapter_version 无法识别；PATH 解析不确定时 fail-closed。
  const executable = await resolveExecutable(input.command)
  if (executable === null) {
    return null
  }
  const executableDigest = await digestFile(executable)
  if (executableDigest === null) {
    return null
  }
  const entrypoints = await resolveEntrypoints(executable, input.args)
  if (entrypoints === null) {
    return null
  }
  const hash = createHash('sha256')
  hash.update(input.providerKind).update('\u0000')
  hash.update(executable).update('\u0000').update(executableDigest)
  for (const entrypoint of entrypoints) {
    hash.update('\u0000').update(entrypoint.path).update('\u0000').update(entrypoint.digest)
  }
  hash.update('\u0000').update(input.args.join('\u0000'))
  return hash.digest('hex')
}

/** 解析实际可执行文件：显式路径必须存在，裸命令按 PATH 查找。 */
async function resolveExecutable(command: string): Promise<string | null> {
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    const resolved = resolve(command)
    return (await isFile(resolved)) ? resolved : null
  }
  // 裸命令必须能按当前 PATH 唯一解析出可读文件；否则不做可恢复承诺。
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.length === 0) {
      continue
    }
    const candidate = join(directory, command)
    if (await isFile(candidate)) {
      return resolve(candidate)
    }
  }
  return null
}

/**
 * 解析实际被加载的入口文件。
 *
 * 参数为空时入口就是可执行文件本身；参数非空时必须至少能验证一个文件参数，
 * 否则无法证明 Adapter 入口内容，返回 null。看起来像路径但不存在也 fail-closed，
 * 不把「缺失的入口」当作可恢复身份。
 */
async function resolveEntrypoints(
  executable: string,
  args: readonly string[],
): Promise<Array<{ path: string; digest: string }> | null> {
  if (args.length === 0) {
    const digest = await digestFile(executable)
    return digest === null ? null : [{ path: executable, digest }]
  }
  const entrypoints: Array<{ path: string; digest: string }> = []
  for (const arg of args) {
    if (arg.startsWith('-')) {
      continue
    }
    if (!looksLikePath(arg)) {
      continue
    }
    const resolved = resolve(arg)
    if (!(await isFile(resolved))) {
      return null
    }
    const digest = await digestFile(resolved)
    if (digest === null) {
      return null
    }
    entrypoints.push({ path: resolved, digest })
  }
  return entrypoints.length === 0 ? null : entrypoints
}

/** 只有可能指向文件的参数才需要内容验证；其余位置参数不臆测。 */
function looksLikePath(arg: string): boolean {
  return (
    isAbsolute(arg)
    || arg.startsWith('.')
    || arg.includes('/')
    || arg.includes('\\')
    || /\.(?:c|m)?js$/i.test(arg)
  )
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function digestFile(path: string): Promise<string | null> {
  try {
    const content = await readFile(path)
    return createHash('sha256').update(content).digest('hex')
  } catch {
    return null
  }
}
