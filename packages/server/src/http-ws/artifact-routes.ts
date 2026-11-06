import type { FastifyInstance } from 'fastify'

import {
  artifactContentDtoSchema,
  artifactDtoSchema,
  artifactPageDtoSchema,
  artifactPageQuerySchema,
  artifactParamsSchema,
  artifactSessionParamsSchema,
  createArtifactRequestSchema,
} from '@rolecast/contract'

import type { ArtifactService } from '../application/artifacts/artifact-service.js'
import { sendMappedError, sendValidationError } from './http-api-error.js'

/**
 * @name installArtifactRoutes
 * @description 注册受 Session 隔离的 inline Artifact HTTP 路由
 * @param {FastifyInstance} app 已安装安全 hooks 的 Fastify 应用
 * @param {ArtifactService} service Artifact Application Service
 * @return {void}
 */
export function installArtifactRoutes(app: FastifyInstance, service: ArtifactService): void {
  app.get('/api/sessions/:sessionId/artifacts', async (request, reply) => {
    const params = artifactSessionParamsSchema.safeParse(request.params)
    const query = artifactPageQuerySchema.safeParse(request.query)
    if (!params.success || !query.success) {
      sendValidationError(reply, request, [
        ...(params.success ? [] : params.error.issues),
        ...(query.success ? [] : query.error.issues),
      ])
      return
    }
    try {
      const data = artifactPageDtoSchema.parse(
        await service.list(params.data.sessionId, query.data),
      )
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.post('/api/sessions/:sessionId/artifacts', async (request, reply) => {
    const params = artifactSessionParamsSchema.safeParse(request.params)
    const body = createArtifactRequestSchema.safeParse(request.body)
    if (!params.success || !body.success) {
      sendValidationError(reply, request, [
        ...(params.success ? [] : params.error.issues),
        ...(body.success ? [] : body.error.issues),
      ])
      return
    }
    try {
      const data = artifactDtoSchema.parse(await service.create(params.data.sessionId, body.data))
      reply.code(201).send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/sessions/:sessionId/artifacts/:artifactId', async (request, reply) => {
    const params = artifactParamsSchema.safeParse(request.params)
    if (!params.success) {
      sendValidationError(reply, request, params.error.issues)
      return
    }
    try {
      const data = artifactDtoSchema.parse(
        await service.getMetadata(params.data.sessionId, params.data.artifactId),
      )
      reply.send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })

  app.get('/api/sessions/:sessionId/artifacts/:artifactId/content', async (request, reply) => {
    const params = artifactParamsSchema.safeParse(request.params)
    if (!params.success) {
      sendValidationError(reply, request, params.error.issues)
      return
    }
    try {
      const data = artifactContentDtoSchema.parse(
        await service.getContent(params.data.sessionId, params.data.artifactId),
      )
      reply.header('cache-control', 'no-store').send({ ok: true, data })
    } catch (error: unknown) {
      sendMappedError(reply, request, error)
    }
  })
}
