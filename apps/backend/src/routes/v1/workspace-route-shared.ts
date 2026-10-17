import { z } from "@hono/zod-openapi"

export const ErrorResponseSchema = z
  .object({ error: z.string() })
  .openapi("WorkspaceErrorResponse")

export const WorkspaceSlugParamsSchema = z
  .object({
    workspaceSlug: z.string().min(1),
  })
  .openapi("WorkspaceSlugParams")

export function workspaceSlugParams(c: {
  req: { param: () => Record<string, string> }
}) {
  return WorkspaceSlugParamsSchema.parse(c.req.param())
}
