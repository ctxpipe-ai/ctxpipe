import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it("logs CLI failures through evlog and leaves stdout for the report", async () => {
  const result = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "src/scripts/ingestionCompare.ts"],
    {
      env: {
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL:
          "postgres://ctxpipe_app:ctxpipe@localhost:55433/ctxpipe_ctx638",
        AUTH_SECRET: "fixture-secret-with-at-least-32-characters",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
      },
    },
  ).catch((error: { stdout: string; stderr: string; code: number }) => error)
  expect(result.stdout).toBe("")
  expect(JSON.parse(result.stderr)).toMatchObject({
    level: "error",
    step: "ingestion.compare",
    message: "--org-id is required",
  })
})
