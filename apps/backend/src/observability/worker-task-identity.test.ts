import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { type Server, createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, expect, it } from "vitest"

const backendRoot = resolve(import.meta.dirname, "../..")
const taskId = "5f0e7c2a9b1d4e3f8a6b2c1d0e9f8a7b"

/** The part of an OTLP JSON metric export that this test reads. */
type ResourceMetrics = {
  resource: {
    attributes: { key: string; value: { stringValue?: string } }[]
  }
}

let server: Server | undefined
let configDir: string | undefined

afterEach(async () => {
  server?.close()
  if (configDir) await rm(configDir, { recursive: true, force: true })
})

/**
 * One local server for the ECS task metadata endpoint and the OTLP
 * collector. Returns its base URL and the body of each metric export.
 */
async function metadataAndCollector() {
  const metricExports: Buffer[] = []
  server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      if (request.url === "/v4/container/task") {
        response.setHeader("content-type", "application/json")
        response.end(
          JSON.stringify({
            TaskARN: `arn:aws:ecs:us-west-2:000000000000:task/hosted/${taskId}`,
          }),
        )
        return
      }
      if (request.url === "/v1/metrics")
        metricExports.push(Buffer.concat(chunks))
      response.end()
    })
  })
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { base: `http://127.0.0.1:${address.port}`, metricExports }
}

it("names the ECS task in the worker's metrics when the config load blocks the event loop", async () => {
  const { base, metricExports } = await metadataAndCollector()
  // The OpenWorkflow CLI loads the worker config through jiti, which compiles
  // the import graph of the worker synchronously after `register.ts` starts.
  // In production that takes 20 to 30 seconds; the busy wait stands for it.
  configDir = await mkdtemp(join(tmpdir(), "worker-task-identity-"))
  const observability = join(backendRoot, "src/observability")
  await writeFile(
    join(configDir, "openworkflow.config.ts"),
    `import ${JSON.stringify(join(observability, "register.ts"))}
import { shutdownOtel } from ${JSON.stringify(join(observability, "otel.ts"))}
const end = Date.now() + 3_000
while (Date.now() < end) {}
await shutdownOtel()
export default {}
`,
  )
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { loadConfig } from "@openworkflow/cli/internal"
await loadConfig(${JSON.stringify(configDir)})`,
    ],
    {
      cwd: backendRoot,
      stdio: ["ignore", "ignore", "inherit"],
      env: {
        ...process.env,
        // `register.ts` parses the env; the database is never used.
        DATABASE_URL: "postgres://worker@127.0.0.1:1/worker",
        AUTH_SECRET: "a".repeat(32),
        OTEL_SERVICE_NAME: "openworkflow",
        DEPLOYMENT_ENVIRONMENT: "",
        ECS_CONTAINER_METADATA_URI_V4: `${base}/v4/container`,
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${base}/v1/traces`,
        OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${base}/v1/metrics`,
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "",
      },
    },
  )
  const [code] = await once(child, "exit")

  expect(code).toBe(0)
  const resources = metricExports.flatMap(
    (body) =>
      (
        JSON.parse(body.toString("utf8")) as {
          resourceMetrics: ResourceMetrics[]
        }
      ).resourceMetrics,
  )
  expect(JSON.stringify(resources)).toContain("process.memory.usage")
  expect(
    resources.map(
      (r) =>
        r.resource.attributes.find((a) => a.key === "service.instance.id")
          ?.value.stringValue,
    ),
  ).toEqual([taskId])
}, 60_000)
