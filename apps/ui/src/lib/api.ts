import { hc } from "hono/client"
import type { registerV1Routes } from "../../../backend/src/routes/v1"

export const client = hc<ReturnType<typeof registerV1Routes>>("/", {
  init: { credentials: "include" },
})
