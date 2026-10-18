import { Sandbox } from "@vercel/sandbox"
import { HttpResponse, http } from "msw"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { useMswServer } from "../../../test/msw.js"
import { openIngestEgressScope } from "../workspaces/ingest-egress-proxy.js"
import { vercelIngestSandboxProvider } from "../workspaces/ingest-sandbox-egress.js"
import { withStepFirewall } from "./ingest-shard-step.js"

/*
 * The hosted step's firewall turn: the real ingest firewall on a Vercel
 * sandbox (msw is the Vercel API). Vercel can apply a policy update and
 * still answer with an error; then the step's credentials must leave the
 * policy again.
 */

const AUTH_SECRET = "abcdefghijklmnopqrstuvwxyz123456"
const credentials = { token: "t", teamId: "team_test", projectId: "prj_test" }
const name = "sbx-ingest-turn"
const step = {
  modelProxyPath: "/acme/api/v1/workspace-chat/openai/v1",
  modelCapability: "step-capability",
  bridgePath: "/api/v1/workspace-ingest/tool-bridge",
  bridgeToken: "step-bridge-token",
}
/** The forward URL of each policy that Vercel applied, in order. */
const applied: string[] = []
let refuseNextUpdate = false

const session = {
  id: "sess_turn",
  memory: 2048,
  vcpus: 1,
  region: "iad1",
  runtime: "node22",
  timeout: 60_000,
  status: "running",
  requestedAt: 1,
  createdAt: 1,
  cwd: "/vercel/sandbox",
  updatedAt: 1,
}
const sandbox = {
  name,
  persistent: true,
  createdAt: 1,
  updatedAt: 1,
  currentSessionId: session.id,
  status: "running",
}

// biome-ignore lint/correctness/useHookAtTopLevel: vitest file-scope MSW setup, not a React hook
useMswServer(
  http.get(`https://vercel.com/api/v2/sandboxes/${name}`, () =>
    HttpResponse.json({ sandbox, session, routes: [] }),
  ),
  http.patch(
    `https://vercel.com/api/v2/sandboxes/${name}`,
    async ({ request }) => {
      const body = (await request.json()) as {
        networkPolicy?: {
          allow?: Record<string, Array<{ forwardURL?: string }>>
        }
      }
      applied.push(
        body.networkPolicy?.allow?.["github.com"]?.[0]?.forwardURL ?? "",
      )
      if (refuseNextUpdate) {
        refuseNextUpdate = false
        // Applied, and still an error.
        return HttpResponse.json(
          { error: { code: "bad_request", message: "try again" } },
          { status: 400 },
        )
      }
      return HttpResponse.json({ sandbox })
    },
  ),
  http.post(
    `https://vercel.com/api/v2/sandboxes/sessions/${session.id}/network-policy`,
    () => HttpResponse.json({ session }),
  ),
)

beforeAll(() => {
  // The shard runtime's module opens the OpenWorkflow client at import.
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for this test")
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET)
})
afterAll(() => {
  vi.unstubAllEnvs()
})

/** Whether the scope of a forward URL holds a step's credentials. */
function hasStep(forwardUrl: string): boolean {
  const sealed = forwardUrl.split("/").at(-1) ?? ""
  const scope = openIngestEgressScope(sealed, AUTH_SECRET)
  if (!scope) throw new Error(`Not a sealed scope: ${forwardUrl}`)
  return Boolean(scope.step)
}

describe("withStepFirewall", () => {
  it("removes the step's credentials when Vercel applies the turn's policy and still answers with an error", async () => {
    const { firewall } = vercelIngestSandboxProvider({
      orgId: "org_turn",
      runId: "run_turn",
      shard: 0,
      repositories: [],
      backendHost: "app.example.test",
      credentials,
      agentPassword: "password",
      tags: {},
      agentSnapshot: async () => "snap_test",
    })
    await firewall.attach(
      await Sandbox.get({ ...credentials, name, resume: false }),
      "ghs_turn",
    )
    expect(applied.map(hasStep)).toEqual([false])

    refuseNextUpdate = true
    let ran = false
    await expect(
      withStepFirewall(
        firewall,
        name,
        step,
        { orgId: "org_turn", runId: "run_turn" },
        async () => {
          ran = true
        },
      ),
    ).rejects.toThrow("Setting the sandbox firewall for this turn failed")
    expect(ran).toBe(false)
    // The turn's update carried the step; the next one removed it.
    expect(applied.map(hasStep)).toEqual([false, true, false])
  })
})
