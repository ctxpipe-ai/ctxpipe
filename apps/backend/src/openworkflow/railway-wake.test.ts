import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest"
import { scheduleEnsureWorkerRunning } from "./railway-wake.js"

const requests: { headers: Headers; body: { query: string } }[] = []
const server = setupServer(
  http.post("https://backboard.railway.com/graphql/v2", async ({ request }) => {
    const body = (await request.json()) as { query: string }
    requests.push({ headers: request.headers, body })
    if (body.query.includes("ProjectServices")) {
      return HttpResponse.json({
        data: {
          project: {
            services: {
              edges: [{ node: { id: "svc_worker", name: "openworkflow" } }],
            },
          },
        },
      })
    }
    return HttpResponse.json({ data: { serviceInstanceDeployV2: true } })
  }),
)

beforeAll(() => server.listen({ onUnhandledRequest: "error" }))
afterEach(() => vi.unstubAllEnvs())
afterAll(() => server.close())

it("wakes the preview worker with the environment-scoped project token", async () => {
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", "pr-7")
  vi.stubEnv("RAILWAY_TOKEN", "scoped-project-token")
  vi.stubEnv("RAILWAY_PROJECT_ID", "proj_test")
  vi.stubEnv("RAILWAY_ENVIRONMENT_ID", "env_preview")

  scheduleEnsureWorkerRunning()

  await vi.waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]?.body.query).toContain("serviceInstanceDeployV2")
  for (const { headers } of requests) {
    expect(headers.get("project-access-token")).toBe("scoped-project-token")
    expect(headers.get("authorization")).toBeNull()
  }
})
