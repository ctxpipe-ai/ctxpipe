import { z } from "@hono/zod-openapi"

z.string().openapi({ example: "hello" })
