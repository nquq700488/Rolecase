import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { AcpAgentRuntime, type AgentRuntimeConnectionInput } from '@rolecast/server'

const fakeAgentScript = String.raw`
const readline = require('node:readline')
let pendingPrompt = null
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === 900 && message.result) {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'fake-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FAKE_OK' } } } })
    send({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'end_turn' } })
    pendingPrompt = null
    return
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } }, agentInfo: { name: 'fake-agent', version: '0.1.0' }, authMethods: [] } })
    return
  }
  if (message.method === 'session/new') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'fake-session', configOptions: [{ id: 'model', category: 'model', currentValue: 'fake', options: [{ value: 'fake' }] }] } })
    return
  }
  if (message.method === 'session/prompt') {
    pendingPrompt = message
    send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { sessionId: 'fake-session', options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }] } })
    return
  }
  if (message.method === 'session/resume') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.method === 'session/close') {
    send({ jsonrpc: '2.0', id: message.id, result: {} })
    return
  }
  if (message.method === 'session/cancel') {
    if (pendingPrompt !== null) {
      send({ jsonrpc: '2.0', id: pendingPrompt.id, result: { stopReason: 'cancelled' } })
      pendingPrompt = null
    }
  }
})
`

describe('Fake ACP Agent Contract', () => {
  it('覆盖 Runtime Port 的权限、流式事件、resume 和 close', async () => {
    const runtime = new AcpAgentRuntime()
    const workDir = await mkdtemp(join(tmpdir(), 'rolecast-fake-acp-'))
    const input: AgentRuntimeConnectionInput = {
      providerKind: 'claude',
      adapterCommand: process.execPath,
      adapterArgs: ['-e', fakeAgentScript],
      cwd: workDir,
      env: { ...process.env },
      adapterVersion: 'fake-0.1.0',
      environmentMode: 'inherited',
      runtimeDirectory: workDir,
    }

    const connection = await runtime.connect(input)
    try {
      const session = await runtime.createSession(connection, workDir)
      const events = []
      for await (const event of runtime.sendTurn({
        session,
        contextBundle: {
          system_instructions: '',
          task_input: 'fake',
          referenced_artifacts: [],
          session_summary: '',
          constraints: [],
          output_contract: '',
        },
      })) {
        events.push(event)
        if (event.kind === 'permission_requested') {
          const requestId = event.payload.request_id
          if (typeof requestId !== 'number' && typeof requestId !== 'string') {
            throw new Error('Fake permission event did not contain request_id')
          }
          await runtime.respondPermission({ session, requestId, optionId: 'allow_once' })
        }
      }

      expect(events.map((event) => event.kind)).toEqual([
        'permission_requested',
        'agent_message_chunk',
        'turn_completed',
      ])
      const resumed = await runtime.resumeSession(connection, session.sessionId, workDir)
      await runtime.closeSession(resumed)
      await runtime.cancelTurn(session)
    } finally {
      await runtime.closeConnection(connection.connectionId)
      await rm(workDir, { recursive: true, force: true })
    }
  })
})
