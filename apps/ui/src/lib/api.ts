import { hc } from "hono/client"
import type { registerV1Routes } from "../../../backend/src/routes/v1"

const backendBaseUrl =
  import.meta.env.VITE_BACKEND_URL?.replace(/\/$/, "") ?? "https://localhost:3000"

export const client = hc<ReturnType<typeof registerV1Routes>>(backendBaseUrl, {init: {credentials: "include"}})
