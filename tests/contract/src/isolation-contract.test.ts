import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AcpTestHarness, type AcpProvider } from './harness.js'

const integrationEnabled = process.env.RUN_ACP_INTEGRATION === '1'
const providers: AcpProvider[] = process.env.ACP_PROVIDER === undefined
  ? ['claude', 'codex']
  : [process.env.ACP_PROVIDER as AcpProvider]
const integrationTest = integrationEnabled ? it : it.skip

const mtime = async (filePath: string): Promise<number | null> => {
  try {
    return (await stat(filePath)).mtimeMs
  } catch {
    return null
  }
}

describe('ACP isolated environment Contract', () => {
  for (const provider of providers) {
    integrationTest(`${provider} 不写入用户全局配置`, async () => {
      const globalPath = join(homedir(), provider === 'claude' ? '.claude' : '.codex')
      const before = await mtime(globalPath)
      const harness = await AcpTestHarness.start(provider, { isolated: true })
      try {
        await harness.initialize()
        if (provider === 'codex') {
          await expect(harness.newSession()).rejects.toMatchObject({
            message: expect.stringMatching(/Authentication required/i),
          })
          return
        }
        const session = await harness.newSession()
        const commandUpdate = await harness.waitForNotification((message) => {
          if (message.method !== 'session/update') {
            return false
          }
          const params = message.params as { update?: { sessionUpdate?: string }} | undefined
          return params?.update?.sessionUpdate === 'available_commands_update'
        })
        const update = commandUpdate.params as {
          update?: { availableCommands?: unknown[] }
        }
        const commands = update.update?.availableCommands ?? []
        const model = (session.configOptions as Array<{
          category?: string
          options?: unknown[]
        }>).find((option) => option.category === 'model')

        expect(model).toBeDefined()
        expect(commands.length).toBeGreaterThan(0)
      } finally {
        await harness.close()
      }
      const after = await mtime(globalPath)
      expect(after).toBe(before)
    }, 120_000)
  }
})
