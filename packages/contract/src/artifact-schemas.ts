import { z } from 'zod'

import { identifierSchema, isoDateTimeSchema, optionalIdentifierSchema } from './schemas.js'

/** Artifact 引用 DTO Schema。 */
export const artifactDtoSchema = z
  .object({
    id: identifierSchema,
    workspace_id: identifierSchema,
    session_id: identifierSchema,
    task_id: optionalIdentifierSchema,
    name: z.string().min(1),
    media_type: z.string().min(1),
    size_bytes: z.number().int().nonnegative(),
    content_ref: z.string().min(1),
    created_at: isoDateTimeSchema,
  })
  .strict()
export type ArtifactDto = z.infer<typeof artifactDtoSchema>
