import type { FastifyInstance } from 'fastify'

import {
  mailboxMarkReadDtoSchema,
  mailboxMarkReadRequestSchema,
  mailboxMessageDetailDtoSchema,
  mailboxMessageParamsSchema,
  mailboxPageDtoSchema,
  mailboxPageQuerySchema,
  mailboxParamsSchema,
} from '@rolecast/contract'

import type { MailboxService } from '../application/mailbox/mailbox-service.js'
import { sendMappedError, sendValidationError } from './http-api-error.js'

/**
 * @name installMailboxRoutes
 * @description 注册按 Session 与目标 Slot 隔离的 Mailbox 只读列表、详情和显式已读路由
 * @param {FastifyInstance} app 已安装安全 hooks 的 Fastify 应用
 * @param {MailboxService} service Mailbox Application Service
 * @return {void}
 */
export function installMailboxRoutes(app: FastifyInstance, service: MailboxService): void {
  app.get('/api/sessions/:sessionId/mailbox', async (request, reply) => {
    const params = mailboxParamsSchema.safeParse(request.params)
    const query = mailboxPageQuerySchema.safeParse(request.query)
    if (!params.success || !query.success) {
      sendValidationError(reply, request, [
        ...(params.success ? [] : params.error.issues),
        ...(query.success ? [] : query.error.issues),
      ])
      return
    }
    try {
      const data = mailboxPageDtoSchema.parse(await service.list(params.data.sessionId, query.data))
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/sessions/:sessionId/mailbox/:messageId', async (request, reply) => {
    const params = mailboxMessageParamsSchema.safeParse(request.params)
    const query = mailboxPageQuerySchema.pick({ slot_id: true }).safeParse(request.query)
    if (!params.success || !query.success) {
      sendValidationError(reply, request, [
        ...(params.success ? [] : params.error.issues),
        ...(query.success ? [] : query.error.issues),
      ])
      return
    }
    try {
      const data = mailboxMessageDetailDtoSchema.parse(
        await service.get(params.data.sessionId, params.data.messageId, query.data.slot_id),
      )
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/sessions/:sessionId/mailbox/:messageId/read', async (request, reply) => {
    const params = mailboxMessageParamsSchema.safeParse(request.params)
    const body = mailboxMarkReadRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) {
      sendValidationError(reply, request, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ])
      return
    }
    try {
      const data = mailboxMarkReadDtoSchema.parse(
        await service.markRead(params.data.sessionId, params.data.messageId, body.data),
      )
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })
}
