import { existsSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { resolveAdapterCommand } from './main.js'

describe('Server ACP Adapter 命令解析', () => {
  it('默认解析为 Node 和 Server 自有 ACP 包入口', () => {
    const claude = resolveAdapterCommand('claude', undefined)
    const codex = resolveAdapterCommand('codex', undefined)

    expect(claude.command).toBe(process.execPath)
    expect(codex.command).toBe(process.execPath)
    expect(claude.args).toHaveLength(1)
    expect(codex.args).toHaveLength(1)
    expect(claude.args[0]).toContain('@agentclientprotocol/claude-agent-acp')
    expect(codex.args[0]).toContain('@agentclientprotocol/codex-acp')
    expect(existsSync(claude.args[0] ?? '')).toBe(true)
    expect(existsSync(codex.args[0] ?? '')).toBe(true)
  })

  it('保留显式外部命令覆盖', () => {
    expect(resolveAdapterCommand('claude', '/custom/claude-acp')).toEqual({
      command: '/custom/claude-acp',
      args: [],
    })
  })
})
