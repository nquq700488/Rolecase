import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ConfigImportInvalidError,
  ConfigImportStaleError,
  ConfigImportTargetConflictError,
} from '../../application/ports/codex-config-import-port.js'
import { CodexConfigImport } from './codex-config-import.js'

const configText = `model = "gpt-test"
model_provider = "rolecast"
model_reasoning_effort = "medium"

[model_providers.rolecast]
base_url = "https://gateway.example.test/v1"
wire_api = "responses"
api_key = "not-test-secret"
`

async function createConfigDirectory(): Promise<{ root: string; configPath: string }> {
  const root = await mkdtemp(join(process.cwd(), '.rolecast-codex-import-'))
  const configPath = join(root, 'config.toml')
  await writeFile(configPath, configText, 'utf8')
  return { root, configPath }
}

describe('CodexConfigImport', () => {
  it('只生成脱敏非秘密 preview，并绑定 Provider 与 revision', async () => {
    const { root, configPath } = await createConfigDirectory()
    try {
      const importer = new CodexConfigImport(root)
      const preview = await importer.preview('workspace-001', 'provider-001', 3, configPath)

      expect(preview).toMatchObject({
        workspaceId: 'workspace-001',
        providerId: 'provider-001',
        targetConfigRevision: 3,
        sourceName: 'config.toml',
        baseUrl: 'https://gateway.example.test/v1',
        config: {
          model_provider: 'rolecast',
          model: 'gpt-test',
          wire_api: 'responses',
          reasoning_effort: 'medium',
        },
        models: [{ modelId: 'gpt-test', displayName: 'gpt-test' }],
        warnings: ['已忽略配置中的凭据字段'],
      })
      expect(JSON.stringify(preview)).not.toContain('not-test-secret')

      await expect(importer.claim(preview.previewId, 'workspace-002', 'provider-001', 3))
        .rejects.toBeInstanceOf(ConfigImportTargetConflictError)
      await expect(importer.claim(preview.previewId, 'workspace-001', 'provider-001', 3)).resolves.toEqual(preview)
      await expect(importer.claim(preview.previewId, 'workspace-001', 'provider-001', 3))
        .rejects.toBeInstanceOf(ConfigImportTargetConflictError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('源文件变化后拒绝 claim', async () => {
    const { root, configPath } = await createConfigDirectory()
    try {
      const importer = new CodexConfigImport(root)
      const preview = await importer.preview('workspace-001', 'provider-001', 1, configPath)
      await writeFile(configPath, `${configText}\nmodel_reasoning_effort = "high"\n`, 'utf8')
      await expect(importer.claim(preview.previewId, 'workspace-001', 'provider-001', 1))
        .rejects.toBeInstanceOf(ConfigImportStaleError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('并发 claim 同一个 preview 只允许一个调用成功', async () => {
    const { root, configPath } = await createConfigDirectory()
    try {
      const importer = new CodexConfigImport(root)
      const preview = await importer.preview('workspace-001', 'provider-001', 1, configPath)
      const results = await Promise.allSettled([
        importer.claim(preview.previewId, 'workspace-001', 'provider-001', 1),
        importer.claim(preview.previewId, 'workspace-001', 'provider-001', 1),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('拒绝非法 URL、配置符号链接和父目录符号链接', async () => {
    const { root, configPath } = await createConfigDirectory()
    const linkedFile = join(root, 'linked.toml')
    const linkedDirectory = join(root, 'linked-directory')
    const outsideRoot = await mkdtemp(join(process.cwd(), '.rolecast-codex-outside-'))
    const outsidePath = join(outsideRoot, 'config.toml')
    try {
      await symlink(configPath, linkedFile)
      await mkdir(join(root, 'real-directory'))
      await writeFile(join(root, 'real-directory', 'config.toml'), configText, 'utf8')
      await symlink(join(root, 'real-directory'), linkedDirectory)
      await writeFile(outsidePath, configText, 'utf8')
      const importer = new CodexConfigImport(root)
      await expect(importer.preview('workspace-001', 'provider-001', 1, outsidePath))
        .rejects.toBeInstanceOf(ConfigImportInvalidError)
      await expect(importer.preview('workspace-001', 'provider-001', 1, linkedFile))
        .rejects.toBeInstanceOf(ConfigImportInvalidError)
      await expect(importer.preview('workspace-001', 'provider-001', 1, join(linkedDirectory, 'config.toml')))
        .rejects.toBeInstanceOf(ConfigImportInvalidError)

      await writeFile(configPath, configText.replace('https://gateway.example.test/v1', 'https://user:password@gateway.example.test/v1'), 'utf8')
      await expect(importer.preview('workspace-001', 'provider-001', 1, configPath))
        .rejects.toBeInstanceOf(ConfigImportInvalidError)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outsideRoot, { recursive: true, force: true })
    }
  })
})
