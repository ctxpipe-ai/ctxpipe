import { randomBytes } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { OpenAPIHono } from "@hono/zod-openapi"
import { APIError, Sandbox, Snapshot } from "@vercel/sandbox"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { BackendPostgres } from "openworkflow/postgres"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { AppEnv } from "../../app/env.js"
import { parseEnv } from "../../config/env.js"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { connections } from "../../db/schema/connections.js"
import { repositories } from "../../db/schema/repositories.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"
import { sandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { registerSandboxEgressRoute } from "../../routes/sandbox-egress.js"
import { workspaceChatOpenaiRoutes } from "../../routes/v1/workspace-chat-openai.js"
import {
  contextStorage,
  withTestRequestLogger,
} from "../../test/hono-test-logger.js"
import {
  type GithubTokenLog,
  githubTokenHandlers,
  insertGithubConnection,
  stubGithubApp,
} from "../../test/ingest-github.js"
import {
  VERCEL_INGEST_AGENT_PATH,
  VERCEL_INGEST_TOOLS_ROOT,
} from "../workspaces/chat-runtime.js"
import { ingestEgressForwardUrl } from "../workspaces/ingest-egress-proxy.js"
import { ingestSandboxTags } from "../workspaces/ingest-sandbox-egress.js"
import {
  agentSnapshotTags,
  deleteVercelBuilder,
  deleteVercelSandbox,
  listTaggedSandboxes,
} from "../workspaces/vercel-sandbox-provider.js"
import { workspaceChatCompletionsPath } from "../workspaces/workspace-chat-model-proxy.js"
import { VERCEL_SANDBOX } from "../workspaces/workspace-chat-opencode-contract.js"
import { ingestAgentCommand } from "./ingest-opencode.js"
import { INGEST_AGENT_USER } from "./ingest-prepare.js"
import { type RootExec, vercelRootExec } from "./ingest-root.js"
import { ingestShardRuntimeFactory } from "./ingest-shard-sandbox.js"
import {
  INGEST_TOOL_BRIDGE_PATH,
  ingestToolBridgeRoutes,
} from "./ingest-tools.js"
import { INGESTION_V2_WORKFLOW_NAME } from "./ingestion-run.js"
import {
  INGEST_CONTEXT_ROOT,
  INGEST_HOME,
  INGEST_OPENCODE_ROOT,
  INGEST_SKILLS_ROOT,
  INGEST_SOURCE_ROOT,
  readIngestSkillBundle,
} from "./skill-bundle.js"

/*
 * Contract (hosted): one ingest shard on a real Vercel sandbox, through the
 * production shard runtime, with the hosted egress gate open for this test
 * only (`VERCEL_INGEST_EGRESS_PROVEN` stays false in the product).
 *
 * The backend must be public for the Vercel firewall, and a CI runner is not.
 * A second sandbox with a public port stands in for the backend's address:
 * it hands each request to this test process (a reverse tunnel), where the
 * real egress route (OIDC, team, project, sealed scope) and the real model
 * route run. msw stands in for the GitHub App and the model provider only;
 * Git goes to github.com with the lane's GitHub token as the minted token.
 *
 * Runs only in the "hosted sandbox (Vercel)" CI lane, which has the deploy
 * credentials; without them it fails rather than skips.
 */

const HELLO = "octocat/Hello-World"
const HELLO_URL = `https://github.com/${HELLO}.git`
const HELLO_SHA = "7fd1a60b01f91b314f59955a4e4d4e80d8edf11d"
const MODEL_PROVIDER_URL = "http://model-provider.test/v1"
const UPSTREAM_KEY = "sk-contract-upstream"
const TUNNEL_PORT = 8080
const environment = `ci-contract-ingest-${Date.now()}`
const orgId = generateObjectId("org")
const orgSlug = `ingest-${orgId.slice(-8)}`
const connectionId = generateObjectId("con")
const workspaceId = generateObjectId("ws")
/** The destination's codesearch repository, so the step has a tool bridge. */
const repositoryId = generateObjectId("repo")
const githubLog: GithubTokenLog = { minted: [], revoked: [] }
/** The authorization of each call that reached the stand-in model. */
const modelCalls: string[] = []
/** The status of one tool bridge call from the sandbox during the step. */
let bridgeDuringStep: Promise<number> | undefined
/** Each request that the tunnel served: forwarded target, route, status. */
const served: Array<{ forwarded: string; path: string; status: number }> = []

let credentials: { token: string; teamId: string; projectId: string }
let githubToken: string
let authSecret: string
let tunnelHost = ""
let runId = ""
let sandboxName = ""
let backend: BackendPostgres | undefined
const stopTunnel = new AbortController()
const created: string[] = []

function report(line: string) {
  process.stderr.write(`${line}\n`)
}

const server = setupServer(
  ...githubTokenHandlers(githubLog, () => githubToken),
  http.post(`${MODEL_PROVIDER_URL}/chat/completions`, async ({ request }) => {
    modelCalls.push(request.headers.get("authorization") ?? "")
    // The model is called while the step runs: the agent user calls the
    // tool bridge now, through the firewall and the egress proxy.
    bridgeDuringStep ??= agentStatus(bridgeCall())
    await bridgeDuringStep
    const body = (await request.json()) as { stream?: boolean }
    const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
    if (!body.stream)
      return HttpResponse.json({
        id: "chatcmpl_contract",
        object: "chat.completion",
        created: 1,
        model: "stand-in",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "done" },
            finish_reason: "stop",
          },
        ],
        usage,
      })
    const chunk = (fields: Record<string, unknown>) =>
      `data: ${JSON.stringify({ id: "chatcmpl_contract", object: "chat.completion.chunk", created: 1, model: "stand-in", ...fields })}\n\n`
    return new HttpResponse(
      [
        chunk({
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: "done" },
              finish_reason: null,
            },
          ],
        }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        chunk({ choices: [], usage }),
        "data: [DONE]\n\n",
      ].join(""),
      { headers: { "content-type": "text/event-stream" } },
    )
  }),
)

/** The backend routes that a hosted ingest sandbox reaches. */
function backendApp(): OpenAPIHono<AppEnv> {
  const env = parseEnv(process.env as Record<string, string | undefined>)
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set("env", env)
    await next()
  })
  registerSandboxEgressRoute(app)
  app.route("/", ingestToolBridgeRoutes)
  const model = new OpenAPIHono<AppEnv>().basePath(
    "/:orgSlug/api/v1/workspace-chat/openai",
  )
  model.route("/", workspaceChatOpenaiRoutes)
  app.route("/", model)
  return app
}

/**
 * A server on a sandbox's public port: each request that is not for the
 * tunnel itself waits until the test process answers it.
 */
const TUNNEL_SERVER = `
const http = require("node:http")
const { randomUUID } = require("node:crypto")
const key = process.env.TUNNEL_KEY
const queue = []
const waiting = []
const open = new Map()
function give(job) {
  const next = waiting.shift()
  if (!next) return queue.push(job)
  clearTimeout(next.timer)
  next.res.writeHead(200, { "content-type": "application/json" })
  next.res.end(JSON.stringify(job))
}
http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    const body = Buffer.concat(chunks)
    if (req.url.startsWith("/__tunnel/")) {
      if (req.headers["x-tunnel-key"] !== key) { res.writeHead(404); return res.end() }
      if (req.url === "/__tunnel/ready") return res.end("ready")
      if (req.url === "/__tunnel/next") {
        const job = queue.shift()
        if (job) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(job)) }
        const wait = { res, timer: setTimeout(() => { const i = waiting.indexOf(wait); if (i >= 0) waiting.splice(i, 1); res.writeHead(204); res.end() }, 20000) }
        waiting.push(wait)
        return
      }
      const reply = /^\\/__tunnel\\/reply\\/(.+)$/.exec(req.url)
      if (reply) {
        const target = open.get(reply[1])
        open.delete(reply[1])
        if (target) { const r = JSON.parse(body.toString()); target.writeHead(r.status, r.headers); target.end(Buffer.from(r.body, "base64")) }
        res.writeHead(204)
        return res.end()
      }
      res.writeHead(404)
      return res.end()
    }
    const id = randomUUID()
    open.set(id, res)
    setTimeout(() => { if (open.delete(id)) { res.writeHead(504); res.end() } }, 120000)
    give({ id, method: req.method, url: req.url, headers: req.headers, body: body.toString("base64") })
  })
}).listen(${TUNNEL_PORT}, "0.0.0.0")
`

const HOP_HEADERS = [
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "content-encoding",
  "keep-alive",
]

type TunnelJob = {
  id: string
  method: string
  url: string
  headers: Record<string, string | string[]>
  body: string
}

/** Answer one tunneled request with the backend routes. */
async function serveJob(
  base: string,
  key: string,
  app: OpenAPIHono<AppEnv>,
  job: TunnelJob,
) {
  const headers = new Headers()
  for (const [name, value] of Object.entries(job.headers))
    if (!HOP_HEADERS.includes(name))
      for (const one of Array.isArray(value) ? value : [value])
        headers.append(name, one)
  let status = 500
  let responseHeaders: Record<string, string> = {}
  let body = Buffer.alloc(0)
  try {
    const response = await app.fetch(
      new Request(`https://${tunnelHost}${job.url}`, {
        method: job.method,
        headers,
        ...(job.method === "GET" || job.method === "HEAD"
          ? {}
          : { body: Buffer.from(job.body, "base64") }),
      }),
    )
    status = response.status
    body = Buffer.from(await response.arrayBuffer())
    responseHeaders = Object.fromEntries(
      [...response.headers].filter(([name]) => !HOP_HEADERS.includes(name)),
    )
  } catch (error) {
    report(`[tunnel] ${job.method} ${job.url.slice(0, 60)}: ${String(error)}`)
  }
  const forwardedHost = headers.get("vercel-forwarded-host")
  // The proxy logs its own refusal reason; this names only the request.
  if (status === 403 && forwardedHost)
    report(
      `[tunnel] 403 ${job.method} ${forwardedHost}${headers.get("vercel-forwarded-path") ?? ""}`,
    )
  served.push({
    forwarded: forwardedHost
      ? `${forwardedHost}${headers.get("vercel-forwarded-path") ?? ""}`
      : "",
    path: job.url.split("?")[0] ?? "",
    status,
  })
  await fetch(`${base}/__tunnel/reply/${job.id}`, {
    method: "POST",
    headers: { "x-tunnel-key": key, "content-type": "application/json" },
    body: JSON.stringify({
      status,
      headers: responseHeaders,
      body: body.toString("base64"),
    }),
  }).catch((error: unknown) => report(`[tunnel] reply: ${String(error)}`))
}

/** Start the tunnel sandbox and the loop that serves it; returns its host. */
async function startTunnel(): Promise<string> {
  const key = randomBytes(24).toString("hex")
  const sandbox = await Sandbox.create({
    ...credentials,
    runtime: VERCEL_SANDBOX.runtime,
    resources: VERCEL_SANDBOX.resources,
    timeout: 45 * 60_000,
    ports: [TUNNEL_PORT],
    tags: { environment, purpose: "ci-contract-tunnel" },
  })
  created.push(sandbox.name)
  await sandbox.runCommand({
    cmd: "node",
    args: ["-e", TUNNEL_SERVER],
    env: { TUNNEL_KEY: key },
    detached: true,
  })
  const base = sandbox.domain(TUNNEL_PORT)
  const started = Date.now()
  for (;;) {
    const ready = await fetch(`${base}/__tunnel/ready`, {
      headers: { "x-tunnel-key": key },
      signal: AbortSignal.timeout(5_000),
    }).then(
      (response) => response.text(),
      () => "",
    )
    if (ready === "ready") break
    if (Date.now() - started > 60_000)
      throw new Error("The tunnel sandbox did not start within 60 s")
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  report(`[vercel] tunnel ready ${Date.now() - started}ms`)
  const host = new URL(base).host
  void (async () => {
    // The app reads AUTH_BASE_URL, so it is made at the first request,
    // after the test has set it to the tunnel host.
    let app: OpenAPIHono<AppEnv> | undefined
    while (!stopTunnel.signal.aborted) {
      const next = await fetch(`${base}/__tunnel/next`, {
        headers: { "x-tunnel-key": key },
        signal: AbortSignal.any([
          AbortSignal.timeout(30_000),
          stopTunnel.signal,
        ]),
      }).catch(() => undefined)
      if (!next) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        continue
      }
      if (next.status !== 200) {
        await next.body?.cancel()
        continue
      }
      app ??= backendApp()
      void serveJob(base, key, app, (await next.json()) as TunnelJob)
    }
  })()
  return host
}

beforeAll(async () => {
  const token = process.env.VERCEL_TOKEN?.trim()
  const team = process.env.VERCEL_TEAM?.trim()
  const project = process.env.VERCEL_PROJECT?.trim()
  const github = process.env.GITHUB_TOKEN?.trim()
  const databaseUrl = process.env.DATABASE_URL
  const secret = process.env.AUTH_SECRET?.trim()
  if (!token || !team || !project || !github || !databaseUrl || !secret)
    throw new Error(
      "VERCEL_TOKEN, VERCEL_TEAM, VERCEL_PROJECT, GITHUB_TOKEN, DATABASE_URL and AUTH_SECRET are required for the hosted sandbox lane",
    )
  githubToken = github
  authSecret = secret
  const response = await fetch(
    `https://api.vercel.com/v9/projects/${project}?${team.startsWith("team_") ? "teamId" : "slug"}=${team}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!response.ok)
    throw new Error(`The Vercel project lookup failed: ${response.status}`)
  const scoped = (await response.json()) as { id: string; accountId: string }
  credentials = { token, teamId: scoped.accountId, projectId: scoped.id }
  server.listen({ onUnhandledRequest: "bypass" })

  initDb(databaseUrl)
  stubGithubApp()
  tunnelHost = await startTunnel()
  vi.stubEnv("SANDBOX_PROVIDER", "vercel")
  vi.stubEnv("AUTH_BASE_URL", `https://${tunnelHost}`)
  vi.stubEnv("SANDBOX_CALLBACK_HOST", "")
  vi.stubEnv("VERCEL_TEAM_ID", team)
  vi.stubEnv("VERCEL_PROJECT_ID", project)
  vi.stubEnv("RAILWAY_ENVIRONMENT_NAME", environment)
  vi.stubEnv("RAILWAY_PROJECT_ID", "")
  vi.stubEnv("MODEL_PROVIDER", "openai-like")
  vi.stubEnv("MODEL_PROVIDER_URL", MODEL_PROVIDER_URL)
  vi.stubEnv("MODEL_PROVIDER_API_KEY", UPSTREAM_KEY)
  vi.stubEnv("MODEL_FAST_NAME", "test/model-fast")
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgSlug,
    name: "Hosted ingest contract",
    createdAt: new Date(),
  })
  await insertGithubConnection({
    orgId,
    id: connectionId,
    installationId: 777,
    accountSlug: "octocat",
  })
  await withOrgDbContext(orgId, (db) =>
    db.insert(repositories).values({
      id: repositoryId,
      orgId,
      name: HELLO,
      gitUrl: HELLO_URL,
    }),
  )
  // The shard's sandbox row belongs to a Workspace of the org.
  await withOrgDbContext(orgId, (db) =>
    db.insert(workspaces).values({
      id: workspaceId,
      orgId,
      slug: `ws-${workspaceId.slice(-8)}`,
      displayName: "Hosted ingest contract",
      workspaceRepositoryUrl: HELLO_URL,
      desiredGeneration: 1,
      desiredSha: HELLO_SHA,
      desiredDefaultBranch: "master",
    }),
  )
  backend = await BackendPostgres.connect(databaseUrl, {
    runMigrations: false,
    namespaceId: openWorkflowNamespaceId(),
  })
  const run = await backend.createWorkflowRun({
    workflowName: INGESTION_V2_WORKFLOW_NAME,
    version: null,
    idempotencyKey: null,
    config: {},
    context: null,
    input: { orgId, shadow: true },
    parentStepAttemptNamespaceId: null,
    parentStepAttemptId: null,
    // Never due: no worker claims it.
    availableAt: new Date(Date.now() + 365 * 24 * 60 * 60_000),
    deadlineAt: null,
  })
  runId = run.id
}, 300_000)

afterAll(async () => {
  stopTunnel.abort()
  for (const sandbox of await listTaggedSandboxes(
    credentials,
    ingestSandboxTags(environment),
  ).catch(() => []))
    created.push(sandbox.name)
  for (const name of created)
    await deleteVercelSandbox({ credentials, name }).catch((error: unknown) =>
      report(`[vercel] cleanup ${name}: ${String(error)}`),
    )
  for (const builder of await listTaggedSandboxes(
    credentials,
    agentSnapshotTags(environment),
  ).catch(() => []))
    await deleteVercelBuilder({ credentials, builderName: builder.name }).catch(
      (error: unknown) =>
        report(`[vercel] cleanup ${builder.name}: ${String(error)}`),
    )
  server.close()
  vi.unstubAllEnvs()
  const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
  for (const row of await store.list("ingest:")) await store.take(row.key)
  await withOrgDbContext(orgId, async (db) => {
    await db.delete(sandboxLocks).where(eq(sandboxLocks.orgId, orgId))
    await db.delete(workspaces).where(eq(workspaces.orgId, orgId))
    await db.delete(repositories).where(eq(repositories.orgId, orgId))
    await db.delete(connections).where(eq(connections.orgId, orgId))
  })
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await backend?.stop()
  await closeDb()
}, 300_000)

function shardSpec(bundle: Awaited<ReturnType<typeof readIngestSkillBundle>>) {
  return {
    orgId,
    runId,
    shard: 0,
    bundle,
    source: {
      kind: "github" as const,
      url: HELLO_URL,
      githubConnectionId: connectionId,
      sha: HELLO_SHA,
      repositoryId: null,
    },
    destinations: [
      {
        workspaceId,
        url: HELLO_URL,
        githubConnectionId: connectionId,
        generation: 1,
        pinnedRevision: HELLO_SHA,
        repositoryId,
        sourcePath: `sources/github/${HELLO}.md`,
      },
    ],
  }
}

/** Root in the shard's sandbox, through the SDK's `sudo` option. */
async function shardRoot(): Promise<RootExec> {
  return vercelRootExec(
    await Sandbox.get({ ...credentials, name: sandboxName, resume: false }),
  )
}

/** Run `command` as the ingest agent user with the hosted agent PATH. */
async function asAgent(command: string) {
  return (await shardRoot())(
    ingestAgentCommand({
      env: { PATH: VERCEL_INGEST_AGENT_PATH, HOME: INGEST_HOME },
      command,
    }),
  )
}

/** One MCP call to the step's tool bridge, as the agent sends it. */
function bridgeCall(): string {
  return `-X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' https://${tunnelHost}${INGEST_TOOL_BRIDGE_PATH}`
}

/** The HTTP status that `curl` got as the agent; 0 when no answer came. */
async function agentStatus(curlArgs: string): Promise<number> {
  const result = await asAgent(
    `curl -s -o /dev/null -m 15 -w '%{http_code}' ${curlArgs}`,
  )
  return Number(result.stdout.trim() || "0")
}

// The hosted gate is open for this test only.
const runtime = ingestShardRuntimeFactory({ hostedEgressProven: true })

describe("hosted ingest shard", { timeout: 1_200_000 }, () => {
  it("runs one shard end to end: prepare, discover-roots, and a model step whose usage comes back, all egress through the backend proxy", async () => {
    const shard = runtime(shardSpec(await readIngestSkillBundle()))
    let started = Date.now()
    await shard.ensure()
    report(`[vercel] ingest shard ensure ${Date.now() - started}ms`)
    const sandboxes = await listTaggedSandboxes(
      credentials,
      ingestSandboxTags(environment),
    )
    expect(sandboxes).toHaveLength(1)
    sandboxName = sandboxes[0]?.name ?? ""
    // The shard's GitHub token was recorded before use, under the shard.
    const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
    const recorded = await store.list(`ingest:${runId}:0:`)
    expect(recorded.length).toBeGreaterThan(0)
    expect(recorded.some((row) => row.token === githubToken)).toBe(true)
    // Prepare cloned through the firewall and the egress route.
    expect(
      served.some(
        (entry) =>
          entry.forwarded.startsWith(`github.com/${HELLO}.git/info/refs`) &&
          entry.status === 200,
      ),
      JSON.stringify(served.slice(0, 5)),
    ).toBe(true)

    expect(await shard.discoverRoots()).toBeTypeOf("object")

    started = Date.now()
    const result = await shard.runStep({
      name: `skill:contract~1:apis:${workspaceId}`,
      skill: "apis",
      run: "model",
      tier: "fast",
      root: null,
      workspaceId,
      baseCommit: HELLO_SHA,
      rootMap: { roots: [] },
      signal: AbortSignal.timeout(600_000),
    })
    report(`[vercel] ingest model step ${Date.now() - started}ms`)
    expect(result.tar.byteLength).toBeGreaterThan(0)
    // The usage reaches the run, so the cost cap counts hosted steps too.
    expect(result.usage?.inputTokens).toBeGreaterThan(0)
    expect(result.usage?.outputTokens).toBeGreaterThan(0)
    // The model route took the step's capability and called the model with
    // the upstream key; the sandbox never had either.
    expect(modelCalls.length).toBeGreaterThan(0)
    expect(
      modelCalls.every((value) => value === `Bearer ${UPSTREAM_KEY}`),
    ).toBe(true)
    expect(
      served.some(
        (entry) =>
          entry.path.startsWith("/api/v1/sandbox-egress/") &&
          entry.forwarded.includes(
            `${workspaceChatCompletionsPath(orgSlug)}/chat/completions`,
          ) &&
          entry.status === 200,
      ),
    ).toBe(true)
    // CTX-628 T12: the step's tool bridge answered during the step, and
    // the firewall refuses it after the step.
    expect(await bridgeDuringStep).toBe(200)
    expect(await agentStatus(bridgeCall())).toBe(403)
  })

  it("prepares as root through the SDK sudo option; the agent user has no sudo, cannot write the prepared tree, and has ripgrep and ast-grep", async () => {
    const root = await shardRoot()
    expect((await root("id -u")).stdout.trim()).toBe("0")
    // T05 S1: the agent cannot use sudo, with or without a target user.
    expect((await asAgent("sudo -n true")).exitCode).not.toBe(0)
    expect((await asAgent("sudo -n -u root true")).exitCode).not.toBe(0)
    // T05 S2: the skills, the config and the checkouts are read only.
    for (const path of [
      `${INGEST_SKILLS_ROOT}/x`,
      `${INGEST_OPENCODE_ROOT}/x`,
      `${INGEST_SOURCE_ROOT}/source/x`,
      `${INGEST_CONTEXT_ROOT}/${workspaceId}/x`,
      // The folders on the agent's PATH, before the system's own.
      `${VERCEL_INGEST_TOOLS_ROOT}/x`,
      `${VERCEL_INGEST_TOOLS_ROOT}/bin/x`,
      `/vercel/runtimes/${VERCEL_SANDBOX.runtime}/bin/x`,
      "/opt/git/bin/x",
    ])
      expect((await asAgent(`touch ${path}`)).exitCode, path).not.toBe(0)
    // T05 S3: the pinned tools.
    const rg = await asAgent("rg --version")
    expect(rg.exitCode, rg.stderr).toBe(0)
    expect(rg.stdout).toContain("ripgrep")
    const astGrep = await asAgent("ast-grep --version")
    expect(astGrep.exitCode, astGrep.stderr).toBe(0)
    expect(astGrep.stdout).toContain("0.45.0")
    // An abort ends the agent's process group in the sandbox (step limit).
    const controller = new AbortController()
    const running = root(
      ingestAgentCommand({
        env: { PATH: VERCEL_INGEST_AGENT_PATH, HOME: INGEST_HOME },
        command: "sleep 600",
      }),
      { signal: controller.signal },
    )
    const outcome = running.then(
      () => "finished",
      (error: Error) => error.message,
    )
    // Wait for proof that the agent process started.
    const agentProcesses = async () =>
      Number(
        (
          await root(
            `uid=$(id -u ${INGEST_AGENT_USER}); n=0; for d in /proc/[0-9]*; do u=$(sed -n 's/^Uid:[[:space:]]*\\([0-9]*\\).*/\\1/p' "$d/status" 2>/dev/null); [ "$u" = "$uid" ] && n=$((n+1)); done; echo $n`,
          )
        ).stdout.trim(),
      )
    while ((await agentProcesses()) < 1) {}
    controller.abort(new Error("contract abort"))
    expect(await outcome).toBe("contract abort")
    expect(await agentProcesses()).toBe(0)
  })

  it("allows only the T03b list: Git fetch of the shard's repositories; refuses push, other repositories, other paths, raw IPs, SSH, other names, DNS, private ranges, and another sandbox's scope", async () => {
    const refs = (repository: string, service = "git-upload-pack") =>
      `'https://github.com/${repository}.git/info/refs?service=${service}'`
    // A1: Git fetch of the shard's repository works, through the proxy.
    expect(await agentStatus(refs(HELLO))).toBe(200)
    const fetched = await asAgent(
      `git ls-remote ${HELLO_URL} HEAD 2>&1; echo "exit=$?"`,
    )
    expect(fetched.stdout).toContain(HELLO_SHA)
    // E1: no push, also with a credential in the URL.
    expect(await agentStatus(refs(HELLO, "git-receive-pack"))).toBe(403)
    expect(
      await agentStatus(
        `-X POST -H 'content-type: application/x-git-receive-pack-request' https://github.com/${HELLO}.git/git-receive-pack`,
      ),
    ).toBe(403)
    const push = await asAgent(
      `cd /tmp && rm -rf p && git init -q p && cd p && git -c user.name=x -c user.email=x@example.com commit -q --allow-empty -m x && GIT_TERMINAL_PROMPT=0 git push https://x:not-a-token@github.com/${HELLO}.git HEAD:refs/heads/ctxpipe-contract 2>&1; echo "exit=$?"`,
    )
    expect(push.stdout).not.toContain("exit=0")
    // E2: another repository.
    expect(await agentStatus(refs("octocat/Spoon-Knife"))).toBe(403)
    // E8: encoded dot segments.
    const dots = await agentStatus(
      `--path-as-is 'https://github.com/${HELLO}.git/%2e%2e/%2e%2e/octocat/Spoon-Knife.git/info/refs?service=git-upload-pack'`,
    )
    expect(dots === 0 || dots >= 400, `dot segments: ${dots}`).toBe(true)
    expect(dots).not.toBe(200)
    // E9 and A2 after the step: no other backend path or method, and the
    // model proxy is closed once the step has ended.
    expect(await agentStatus(`https://${tunnelHost}/api/v1/health`)).toBe(403)
    expect(
      await agentStatus(
        `-X POST https://${tunnelHost}${workspaceChatCompletionsPath(orgSlug)}/chat/completions`,
      ),
    ).toBe(403)
    // E4, E5, E7: raw IPs, another name on GitHub's address, private ranges.
    const githubIp = (await asAgent("getent hosts github.com")).stdout
      .trim()
      .split(/\s+/)[0]
    for (const target of [
      "https://1.1.1.1/",
      "'http://[2606:4700:4700::1111]/'",
      ...(githubIp
        ? [`--resolve example.com:443:${githubIp} https://example.com/`]
        : []),
      "https://example.com/",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/",
      // IPv6: the AWS metadata address, and a unique local address.
      "'http://[fd00:ec2::254]/'",
      "'http://[fd12:3456:789a::1]/'",
    ]) {
      const status = await agentStatus(target)
      expect(status >= 200 && status < 400, `${target}: ${status}`).toBe(false)
    }
    // E3: no SSH to GitHub (no server banner comes back).
    const ssh = await asAgent(
      `node -e "const s=require('net').connect(22,'github.com');let d='';s.on('data',c=>{d+=c});s.on('error',e=>{console.log('error '+e.code);process.exit(0)});setTimeout(()=>{console.log(d.startsWith('SSH-')?'banner':'none');process.exit(0)},8000)"`,
    )
    expect(ssh.stdout).not.toContain("banner")
    // E6: no direct DNS query leaves.
    const dns = await asAgent(
      `node -e "const r=new (require('dns').promises.Resolver)({timeout:3000,tries:1});r.setServers(['8.8.8.8']);r.resolve4('example.com').then(a=>console.log('answer '+a.length),e=>console.log('none '+e.code))"`,
    )
    expect(dns.stdout).toContain("none")
    // No credential is in the sandbox: not in a file, a config, or a
    // process environment. The search runs here, in the test process.
    const tree = await (await shardRoot())(
      // The tool installs and caches of the snapshot build are left out.
      "cat /proc/[0-9]*/environ 2>/dev/null | base64 -w0; echo; tar -czf - --ignore-failed-read --exclude=/home/vercel-sandbox/.local --exclude=/home/vercel-sandbox/.npm --exclude=/root/.npm --exclude=/root/.cache /ctxpipe /etc /tmp /home /root 2>/dev/null | base64 -w0",
    )
    const [environ = "", archive = ""] = tree.stdout.split("\n")
    expect(Buffer.from(environ, "base64").includes(githubToken)).toBe(false)
    expect(
      gunzipSync(Buffer.from(archive, "base64")).includes(githubToken),
    ).toBe(false)
    // A3: a scope sealed for another sandbox gets 403, also from this one.
    const sandbox = await Sandbox.get({
      ...credentials,
      name: sandboxName,
      resume: false,
    })
    const forwardURL = ingestEgressForwardUrl(
      {
        sandbox: "another-sandbox",
        exp: Date.now() + 10 * 60_000,
        backendHost: tunnelHost,
        git: [{ token: githubToken, repositories: [HELLO] }],
      },
      authSecret,
    )
    await sandbox.update({
      networkPolicy: {
        allow: {
          "github.com": [{ forwardURL }],
          [tunnelHost]: [{ forwardURL }],
        },
      },
    })
    expect(await agentStatus(refs(HELLO))).toBe(403)
  })

  it("destroy deletes the sandbox and its snapshots, and revokes each GitHub token of the shard", async () => {
    await runtime.destroy({ orgId, runId, shard: 0, workspaceId })
    // A stopped persistent sandbox keeps a snapshot with the source: only
    // a deleted one counts. Vercel can report the delete a little later.
    const deadline = Date.now() + 120_000
    let state = ""
    while (Date.now() < deadline) {
      state = await Sandbox.get({
        ...credentials,
        name: sandboxName,
        resume: false,
      }).then(
        (sandbox) => sandbox.status,
        (error: unknown) =>
          error instanceof APIError && error.response.status === 404
            ? "deleted"
            : String(error),
      )
      if (state === "deleted") break
    }
    expect(state).toBe("deleted")
    const snapshots = await (
      await Snapshot.list({ ...credentials, name: sandboxName })
    ).toArray()
    expect(
      snapshots.filter((snapshot) => snapshot.status !== "deleted"),
    ).toEqual([])
    const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
    expect(await store.list(`ingest:${runId}:0:`)).toEqual([])
    expect(githubLog.revoked).toContain(githubToken)
  })
})
