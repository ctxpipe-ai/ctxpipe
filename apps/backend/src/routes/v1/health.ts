import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi"

const HealthCheckResponseSchema = z
  .object({
    status: z.literal("ok").openapi({ example: "ok" }),
    timestamp: z
      .string()
      .datetime()
      .openapi({ example: "2026-02-13T12:00:00.000Z" }),
  })
  .openapi("HealthCheckResponse")

export const healthRoute = createRoute({
  method: "get",
  path: "/",
  responses: {
    200: {
      content: {
        "application/json": {
          schema: HealthCheckResponseSchema,
        },
      },
      description: "Health check",
    },
  },
})

export const healthRoutes = new OpenAPIHono().openapi(healthRoute, (c) => {
  const data = {
    status: "ok" as const,
    timestamp: new Date().toISOString(),
  }
  return c.json(data, 200)
})
