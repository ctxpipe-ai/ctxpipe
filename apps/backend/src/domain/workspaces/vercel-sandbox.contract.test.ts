import { gunzipSync } from "node:zlib"
import {
  bootstrapWorkspace,
  defineWorkspace,
  gitSource,
} from "@tanstack/ai-sandbox"
import { VercelHandle } from "@tanstack/ai-sandbox-vercel"
import {
  APIError,
  type NetworkPolicy,
  Sandbox,
  Snapshot,
} from "@vercel/sandbox"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { closeDb, initDb, withOrgDbContext } from "../../db/client.js"
import { workspaceSandboxGitTokens } from "../../db/schema/workspaces.js"
import {
  type SandboxGitTokenStore,
  sandboxGitTokenStore,
} from "../../models/sandbox-git-tokens.js"
import { WORKSPACE_CHAT_VERCEL_SETUP } from "./chat-runtime.js"
import {
  GITHUB_RATE_LIMIT_COMMAND,
  isOutsideFault,
  parseGithubCoreLimit,
} from "./github-rate-limit-reply.js"
import { stopEarlierTurnProcesses } from "./sandbox-process-guards.js"
import {
  agentSnapshotTags,
  attachVercelSandbox,
  conversationFirewall,
  deleteVercelBuilder,
  deleteVercelSandbox,
  GIT_TOKEN_ROTATE_MS,
  listTaggedSandboxes,
  startVercelWorkspaceBase,
  stopVercelSandbox,
  vercelAgentSnapshot,
  vercelConversationProvider,
  workspaceBaseTags,
} from "./vercel-sandbox-provider.js"
import {
  VERCEL_SANDBOX,
  WORKSPACE_CHAT_FIREWALL_PLACEHOLDER,
  writeWorkspaceChatOpenCodeConfig,
} from "./workspace-chat-opencode-contract.js"

/**
 * Real Vercel Sandbox behavior the hosted provider relies on (ticket 02).
 * Runs only in the "hosted sandbox (Vercel)" CI lane, which has the deploy
 * credentials; without them it fails rather than skips.
 */

/**
 * Run a git command in the sandbox. On a failure, print the state of the CA
 * bundle (CTX-727: an intermittent "error adding trust anchors"), then
 * rethrow. The output holds file metadata and certificate lines only.
 */
async function gitWithCaDiagnostics(
  handle: {
    process: {
      exec: (
        command: string,
      ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
    }
  },
  command: string,
) {
  const result = await handle.process.exec(command)
  if (result.exitCode === 0) return result
  const bundle = "/etc/ssl/certs/ca-certificates.crt"
  const state = await handle.process.exec(
    `ls -l /etc/ssl/certs/ | head -n 40; stat ${bundle}; wc -l ${bundle}; tail -n 3 ${bundle}; date +%s.%N`,
  )
  console.error(
    `[vercel] git failed (exit ${result.exitCode}): ${result.stderr.trim()}\n[vercel] CA bundle state:\n${state.stdout}${state.stderr}`,
  )
  return result
}

const OPENCODE_VERSION = "1.18.34"
const tags = { purpose: "ci-contract" }
const created: string[] = []
const snapshots: string[] = []
let credentials: { token: string; teamId: string; projectId: string }
/** This run's environment, so its agent and base builders are its own. */
const environment = `ci-contract-${Date.now()}`
let agent: Promise<string> | undefined
/** The agent snapshot (OpenCode only) conversations start from without a base. */
function agentSnapshot(): Promise<string> {
  agent ??= vercelAgentSnapshot({ credentials, environment })
  return agent
}

/** Timings and measurements go to the CI log; ticket 02 records them. */
function report(line: string) {
  process.stderr.write(`${line}\n`)
}

async function vercelApi<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.vercel.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok)
    throw new Error(
      `Vercel ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
    )
  return (await response.json()) as T
}

async function create(
  params: Omit<Parameters<typeof Sandbox.create>[0] & object, "token">,
) {
  const started = Date.now()
  const sandbox = await Sandbox.create({
    ...credentials,
    tags,
    timeout: 10 * 60_000,
    // The size production uses, so this lane proves it.
    resources: VERCEL_SANDBOX.resources,
    ...params,
  } as Parameters<typeof Sandbox.create>[0])
  created.push(sandbox.name)
  report(`[vercel] create ${sandbox.name} ${Date.now() - started}ms`)
  return sandbox
}

function handle(sandbox: Sandbox, ports: number[] = []) {
  return new VercelHandle({ sandbox, workdir: "/vercel/sandbox", ports })
}

beforeAll(async () => {
  const token = process.env.VERCEL_TOKEN?.trim()
  const team = process.env.VERCEL_TEAM?.trim()
  const project = process.env.VERCEL_PROJECT?.trim()
  if (!token || !team || !project)
    throw new Error(
      "VERCEL_TOKEN, VERCEL_TEAM and VERCEL_PROJECT are required for the hosted sandbox lane",
    )
  // Team-scoped tokens may not read the team itself; the project carries its
  // owning team id, and the slug query selects the team.
  const scoped = await vercelApi<{ id: string; accountId: string }>(
    `/v9/projects/${project}?${team.startsWith("team_") ? "teamId" : "slug"}=${team}`,
    token,
  )
  const teamId = scoped.accountId
  const projectId = scoped.id
  credentials = { token, teamId, projectId }
})

afterAll(async () => {
  // A test can delete its own sandbox or snapshot first; already gone counts
  // as deleted, so only a real cleanup fault is reported.
  for (const name of created)
    await deleteVercelSandbox({ credentials, name }).catch((error: unknown) =>
      report(`[vercel] cleanup ${name}: ${String(error)}`),
    )
  for (const snapshotId of snapshots) {
    try {
      const snapshot = await Snapshot.get({ ...credentials, snapshotId })
      if (snapshot.status !== "deleted") await snapshot.delete()
    } catch (error) {
      if (!(error instanceof APIError && error.response.status === 404))
        report(`[vercel] cleanup ${snapshotId}: ${String(error)}`)
    }
  }
  // This run's agent and base builders, with their snapshots.
  for (const builderTags of [
    agentSnapshotTags(environment),
    workspaceBaseTags(environment),
  ])
    for (const builder of await listTaggedSandboxes(credentials, builderTags))
      await deleteVercelBuilder({
        credentials,
        builderName: builder.name,
      }).catch((error: unknown) =>
        report(`[vercel] cleanup ${builder.name}: ${String(error)}`),
      )
})

describe("Vercel Sandbox", { timeout: 600_000 }, () => {
  it("resumes a stopped persistent sandbox with its files", async () => {
    const sandbox = await create({
      runtime: VERCEL_SANDBOX.runtime,
      persistent: true,
      snapshotExpiration: 24 * 60 * 60_000,
      keepLastSnapshots: { count: 1 },
    })
    await handle(sandbox).fs.write("/workspace/state.txt", "kept")
    // Where the agent's tools and home can live: writable and kept on stop.
    const places = [
      "$HOME/.ctxpipe-probe",
      "/tmp/ctxpipe-probe",
      "/vercel/ctxpipe-probe",
    ]
    const write = await handle(sandbox).process.exec(
      `id; echo "HOME=$HOME"; echo "PATH=$PATH"; command -v node npm git; for p in ${places.join(" ")}; do mkdir -p "$(dirname "$p")" 2>/dev/null; echo kept > "$p" 2>/dev/null && echo "wrote $p" || echo "cannot write $p"; done`,
    )
    report(`[vercel] places before stop: ${write.stdout.replace(/\n/g, " | ")}`)
    let started = Date.now()
    await sandbox.stop()
    report(`[vercel] stop ${Date.now() - started}ms`)
    // A read-only attach never resumes a stopped sandbox.
    expect(
      await attachVercelSandbox(
        { credentials, name: sandbox.name },
        { onlyRunning: true },
      ),
    ).toBeNull()
    expect(
      (await Sandbox.get({ ...credentials, name: sandbox.name, resume: false }))
        .status,
    ).not.toBe("running")
    started = Date.now()
    const resumed = await Sandbox.get({ ...credentials, name: sandbox.name })
    expect(await handle(resumed).fs.read("/workspace/state.txt")).toBe("kept")
    const kept = await handle(resumed).process.exec(
      `for p in ${places.join(" ")}; do [ "$(cat "$p" 2>/dev/null)" = kept ] && echo "kept $p" || echo "lost $p"; done`,
    )
    report(`[vercel] places after resume: ${kept.stdout.replace(/\n/g, " | ")}`)
    report(`[vercel] resume and read ${Date.now() - started}ms`)
  })

  it("deletes a stopped sandbox together with its saved state", async () => {
    const sandbox = await create({
      runtime: VERCEL_SANDBOX.runtime,
      persistent: true,
      snapshotExpiration: 24 * 60 * 60_000,
      keepLastSnapshots: { count: 1 },
    })
    await handle(sandbox).fs.write("/workspace/state.txt", "saved")
    await sandbox.stop()
    const live = async () =>
      (
        await (
          await Snapshot.list({ ...credentials, name: sandbox.name })
        ).toArray()
      ).filter((snapshot) => snapshot.status !== "deleted")
    report(`[vercel] saved snapshots after stop: ${(await live()).length}`)
    await deleteVercelSandbox({ credentials, name: sandbox.name })
    expect(await live()).toEqual([])
    // Already deleted counts as deleted.
    await deleteVercelSandbox({ credentials, name: sandbox.name })
  })

  it("starts a new sandbox from a snapshot of a prepared base", async () => {
    const base = await create({ runtime: VERCEL_SANDBOX.runtime })
    await handle(base).fs.write("/workspace/base.txt", "prepared")
    let started = Date.now()
    const snapshot = await base.snapshot().catch((error: unknown) => {
      const body = (error as { json?: unknown }).json
      throw new Error(
        `snapshot failed: ${JSON.stringify(body ?? String(error))}`,
      )
    })
    snapshots.push(snapshot.snapshotId)
    report(`[vercel] snapshot ${Date.now() - started}ms`)
    started = Date.now()
    const child = await create({
      source: { type: "snapshot", snapshotId: snapshot.snapshotId },
    })
    expect(await handle(child).fs.read("/workspace/base.txt")).toBe("prepared")
    report(`[vercel] start from snapshot ${Date.now() - started}ms`)
  })

  it("adds and rotates a credential header outside the sandbox", async () => {
    // The hosted GitHub read token is added by the firewall, so it never
    // enters the sandbox; each session's rule is replaced as tokens rotate.
    const policy = (value: string): NetworkPolicy => ({
      allow: {
        "postman-echo.com": [
          { transform: [{ headers: { "x-ctxpipe-probe": value } }] },
        ],
      },
    })
    const sandbox = await create({
      runtime: VERCEL_SANDBOX.runtime,
      networkPolicy: policy("token-1"),
    })
    const echo = async () => {
      const result = await handle(sandbox).process.exec(
        `node -e "fetch('https://postman-echo.com/headers').then(r=>r.text()).then(t=>console.log(t),e=>console.log('failed',e.cause?.code??e.message))"`,
      )
      return result.stdout
    }
    const curl = async () =>
      (
        await handle(sandbox).process.exec(
          "command -v curl >/dev/null && curl -sS https://postman-echo.com/headers || echo no-curl",
        )
      ).stdout
    expect(await echo()).toContain("token-1")
    const viaCurl = await curl()
    report(`[vercel] header via curl: ${viaCurl.slice(0, 300)}`)
    const environment = await handle(sandbox).process.exec(
      "env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'",
    )
    expect(environment.stdout).not.toContain("token-1")
    const started = Date.now()
    await sandbox.update({ networkPolicy: policy("token-2") })
    report(`[vercel] network policy update ${Date.now() - started}ms`)
    const rotated = Date.now()
    let body = ""
    while (Date.now() - rotated < 30_000) {
      body = await echo()
      if (body.includes("token-2")) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    report(`[vercel] rotated header visible after ${Date.now() - rotated}ms`)
    expect(body).toContain("token-2")
    expect(body).not.toContain("token-1")
  })

  it("allows only allowlisted hosts", async () => {
    const networkPolicy: NetworkPolicy = { allow: ["github.com"] }
    const sandbox = await create({
      runtime: VERCEL_SANDBOX.runtime,
      networkPolicy,
    })
    const probe = (url: string) =>
      handle(sandbox).process.exec(
        `node -e "fetch('${url}',{redirect:'manual'}).then(r=>console.log(r.status),e=>console.log('blocked',e.cause?.code??e.message))"`,
      )
    const allowed = await probe("https://github.com/")
    const denied = await probe("https://example.com/")
    report(
      `[vercel] egress github=${allowed.stdout.trim()} example=${denied.stdout.trim()}`,
    )
    expect(allowed.stdout).not.toContain("blocked")
    expect(denied.stdout).toContain("blocked")
  })

  it("serves the agent port only with the OpenCode password", async () => {
    const sandbox = await create({
      runtime: VERCEL_SANDBOX.runtime,
      ports: [4096],
    })
    const agent = handle(sandbox, [4096])
    let started = Date.now()
    const install = await agent.process.exec(
      `npm install -g --prefix "$HOME/.local" opencode-ai@${OPENCODE_VERSION}`,
    )
    expect(install.exitCode, install.stderr).toBe(0)
    report(`[vercel] install opencode ${Date.now() - started}ms`)
    await agent.env.set({ OPENCODE_SERVER_PASSWORD: "contract-secret" })
    const server = await agent.process.spawn(
      '"$HOME/.local/bin/opencode" serve --port 4096 --hostname 0.0.0.0',
    )
    let output = ""
    void (async () => {
      for await (const chunk of server.stdout) output += chunk
    })()
    void (async () => {
      for await (const chunk of server.stderr) output += chunk
    })()
    const { url } = await agent.ports.connect(4096)
    const basic = `Basic ${Buffer.from("opencode:contract-secret").toString("base64")}`
    started = Date.now()
    let authorized = 0
    while (Date.now() - started < 90_000) {
      authorized = await fetch(`${url}/session`, {
        headers: { Authorization: basic },
        signal: AbortSignal.timeout(5_000),
      }).then(
        (response) => response.status,
        () => 0,
      )
      if (authorized === 200) break
      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }
    report(
      `[vercel] opencode ready=${authorized} ${Date.now() - started}ms; server output: ${output.slice(-1_000)}`,
    )
    expect(authorized).toBe(200)
    expect((await fetch(`${url}/session`)).status).toBe(401)
  })

  it("kills a command together with its child processes", async () => {
    const sandbox = await create({ runtime: VERCEL_SANDBOX.runtime })
    const command = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "mkdir -p /tmp/k; : >> /tmp/k/f; tail -f /tmp/k/f"],
      detached: true,
    })
    const tails = async () =>
      (
        await handle(sandbox).process.exec(
          "cat /proc/[0-9]*/comm 2>/dev/null | grep -c '^tail$' || true",
        )
      ).stdout.trim()
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const before = await tails()
    await command.kill("SIGKILL")
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const after = await tails()
    report(`[vercel] kill: tail processes before=${before} after=${after}`)
    expect(before).toBe("1")
    expect(after).toBe("0")
  })
})

describe("hosted conversation provider", { timeout: 600_000 }, () => {
  it("PROBE (temporary): CA bundle rewrites after create and after a policy update", async () => {
    const githubToken = process.env.GITHUB_TOKEN?.trim() ?? ""
    const store = new Map<string, { token: string; mintedAt: Date }>()
    const access = {
      firewall: conversationFirewall("ctxpipe-contract.invalid"),
      tokens: {
        get: async (id: string) => store.get(id) ?? null,
        put: async (id: string, token: string) => {
          store.set(id, { token, mintedAt: new Date() })
        },
        take: async (id: string) => store.get(id)?.token ?? null,
      },
      mintGitToken: async () => githubToken,
      revokeGitToken: async () => undefined,
    }
    const provider = vercelConversationProvider({
      credentials,
      agentPassword: "contract-agent-password",
      access,
      tags,
      base: async () => ({ failed: async () => undefined }),
      agentSnapshot,
    })
    const beforeCreate = Date.now()
    const handle = await provider.create({
      workspace: { source: { type: "none" } },
    } as Parameters<typeof provider.create>[0])
    created.push(handle.id)
    const createdAt = Date.now()
    const watch = (label: string, seconds: number) =>
      handle.process
        .exec(
          `echo "${label} start ms=$(date +%s%3N)"; last=""; for i in $(seq 1 ${seconds * 5}); do b=/etc/ssl/certs/ca-certificates.crt; cur="mtime=$(stat -L -c '%y' $b 2>&1) birth=$(stat -c '%w' $b 2>&1) procs=$(pgrep -x update-ca-trust | wc -l)/$(pgrep -x trust | wc -l) count=$(grep -c BEGIN $b 2>&1) last=$(awk '/BEGIN CERT/{c=""} {c=c $0 "\\n"} END{printf "%b", c}' $b 2>/dev/null | openssl x509 -noout -subject 2>&1 | head -c 100)"; if [ "$cur" != "$last" ]; then echo "ms=$(date +%s%3N) $cur"; last="$cur"; fi; sleep 0.2; done`,
        )
        .then((r) => `${r.stdout}${r.stderr}`)
    const during = watch("watch", 40)
    await new Promise((resolve) => setTimeout(resolve, 8_000))
    const sandbox = await Sandbox.get({ ...credentials, name: handle.id })
    await access.firewall.attach(sandbox, githubToken)
    const steps: string[] = []
    const mark = (label: string) => steps.push(`${label} ms=${Date.now()}`)
    mark("rotate-start")
    await access.firewall.rotateGitToken(sandbox, `${githubToken}-probe`)
    mark("rotate-end")
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    mark("openTurn-start")
    await access.firewall.openTurn(sandbox.name, {
      modelProxyPath: "/probe/api/v1/workspace-chat/openai/v1",
      modelCapability: "probe-capability",
      bridgePath: "/api/v1/workspace-chat/tool-bridge/probe",
      bridgeToken: "probe-bridge",
    })
    mark("openTurn-end")
    await new Promise((resolve) => setTimeout(resolve, 6_000))
    mark("closeTurn-start")
    await access.firewall.closeTurn(sandbox.name)
    mark("closeTurn-end")
    console.error(
      `[probe] beforeCreateMs=${beforeCreate} createReturnedMs=${createdAt}\n${steps.join("\n")}\n${await during}`,
    )
    await closeDb().catch(() => undefined)
  })

  it("authenticates GitHub only through the firewall and rotates the token", async () => {
    // The Actions token stands in for a minted Workspace read token; revoking
    // it would end the job, so revocations are recorded instead.
    const githubToken = process.env.GITHUB_TOKEN?.trim()
    if (!githubToken)
      throw new Error("GITHUB_TOKEN is required for the hosted sandbox lane")
    const databaseUrl = process.env.DATABASE_URL?.trim()
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for the hosted sandbox lane")
    initDb(databaseUrl)
    const orgId = `org_vercel_contract_${Date.now()}`
    const tokens = sandboxGitTokenStore(orgId, parseEnv(process.env))
    let mints = 0
    const revoked: string[] = []
    const access = {
      firewall: conversationFirewall("ctxpipe-contract.invalid"),
      tokens,
      mintGitToken: async () => {
        mints += 1
        return githubToken
      },
      revokeGitToken: async (token: string) => {
        revoked.push(token)
      },
    }
    const provider = vercelConversationProvider({
      credentials,
      agentPassword: "contract-agent-password",
      access,
      tags,
      base: async () => ({ failed: async () => undefined }),
      agentSnapshot,
    })
    const handle = await provider.create({
      workspace: { source: { type: "none" } },
    } as Parameters<typeof provider.create>[0])
    created.push(handle.id)
    const coreLimit = async (sandboxHandle: typeof handle) => {
      // An outside fault gets three tries; a firewall fault fails at once.
      for (let attempt = 1; ; attempt += 1) {
        try {
          return parseGithubCoreLimit(
            await sandboxHandle.process.exec(GITHUB_RATE_LIMIT_COMMAND),
          )
        } catch (error) {
          if (attempt >= 3 || !isOutsideFault(error)) throw error
          await new Promise((resolve) => setTimeout(resolve, 5_000))
        }
      }
    }
    // Unauthenticated callers get 60 requests an hour.
    expect(await coreLimit(handle)).toBeGreaterThan(60)
    const environment = await handle.process.exec(
      "env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'",
    )
    expect(environment.stdout.includes(githubToken)).toBe(false)
    const clone = await gitWithCaDiagnostics(
      handle,
      "GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/ctxpipe-ai/ctxpipe.git HEAD",
    )
    expect(clone.exitCode, clone.stderr).toBe(0)
    const connected = await handle.ports.connect(4096)
    expect(connected.headers?.Authorization).toMatch(/^Basic /)
    expect(mints).toBe(1)

    // A token younger than 10 minutes is left alone on resume.
    let started = Date.now()
    await provider.resume({ id: handle.id })
    report(`[vercel] resume with a fresh token ${Date.now() - started}ms`)
    expect(mints).toBe(1)

    // An older one is replaced in the background; resume does not wait.
    await withOrgDbContext(orgId, (db) =>
      db
        .update(workspaceSandboxGitTokens)
        .set({ mintedAt: new Date(Date.now() - GIT_TOKEN_ROTATE_MS - 1_000) })
        .where(eq(workspaceSandboxGitTokens.sandboxId, handle.id)),
    )
    started = Date.now()
    await provider.resume({ id: handle.id })
    report(`[vercel] resume with an aged token ${Date.now() - started}ms`)
    await expect.poll(() => mints, { timeout: 30_000 }).toBe(2)
    await expect.poll(() => revoked.length, { timeout: 60_000 }).toBe(1)

    // A stop revokes the token; the next resume replaces it before use.
    await stopVercelSandbox({
      credentials,
      name: handle.id,
      tokens,
      revoke: access.revokeGitToken,
    })
    expect(revoked).toHaveLength(2)
    expect(await tokens.get(handle.id)).toBeNull()
    started = Date.now()
    const resumed = await provider.resume({ id: handle.id })
    report(`[vercel] resume after stop ${Date.now() - started}ms`)
    expect(mints).toBe(3)
    if (!resumed) throw new Error("Stopped sandbox did not resume")
    expect(await coreLimit(resumed)).toBeGreaterThan(60)
    await provider.destroy({ id: handle.id })
    expect(revoked).toHaveLength(3)
    expect(await tokens.get(handle.id)).toBeNull()
    await closeDb()
  })
})

/**
 * Start a server that answers each request with its method, path and
 * headers, on a sandbox's public port. Returns the public host.
 */
async function startEchoHost(): Promise<string> {
  const port = 8080
  const sandbox = await create({
    runtime: VERCEL_SANDBOX.runtime,
    ports: [port],
  })
  await sandbox.runCommand({
    cmd: "node",
    args: [
      "-e",
      `require("node:http").createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ echo: true, method: req.method, url: req.url, headers: req.headers })) }).listen(${port}, "0.0.0.0")`,
    ],
    detached: true,
  })
  const { url } = await handle(sandbox, [port]).ports.connect(port)
  const started = Date.now()
  let last = ""
  while (Date.now() - started < 60_000) {
    last = await fetch(`${url}/ready`, {
      signal: AbortSignal.timeout(5_000),
    }).then(
      (response) => response.text(),
      (error: unknown) => String(error),
    )
    if (last.includes('"echo":true')) {
      report(`[vercel] echo host ready ${Date.now() - started}ms`)
      return new URL(url).host
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(
    `The echo host did not start within 60 s: ${last.slice(0, 300)}`,
  )
}

describe("hosted turn credentials", { timeout: 600_000 }, () => {
  it("adds a turn's credentials outside the sandbox on exact paths and the pinned host, and removes them at turn end; the internet stays open", async () => {
    // An echo service on a second sandbox's public port stands in for the
    // backend: it shows the headers that the firewall set. A public echo
    // service (httpbin.org) answered 503 pages and failed this lane.
    const echoHost = await startEchoHost()
    const githubToken = process.env.GITHUB_TOKEN?.trim()
    if (!githubToken)
      throw new Error("GITHUB_TOKEN is required for the hosted sandbox lane")
    const held = new Map<string, { token: string; mintedAt: Date }>()
    const tokens: SandboxGitTokenStore = {
      get: async (id) => held.get(id) ?? null,
      put: async (id, token) => {
        held.set(id, { token, mintedAt: new Date() })
      },
      take: async (id) => {
        const token = held.get(id)?.token ?? null
        held.delete(id)
        return token
      },
    }
    const firewall = conversationFirewall(echoHost)
    const provider = vercelConversationProvider({
      credentials,
      agentPassword: "contract-agent-password",
      access: {
        firewall,
        tokens,
        mintGitToken: async () => githubToken,
        revokeGitToken: async () => undefined,
      },
      tags,
      base: async () => ({ failed: async () => undefined }),
      agentSnapshot,
    })
    const handle = await provider.create({
      workspace: { source: { type: "none" } },
    } as Parameters<typeof provider.create>[0])
    created.push(handle.id)
    const suffix = Date.now().toString(36)
    const turn = {
      modelProxyPath: `/anything/${suffix}/api/v1/workspace-chat/openai/v1`,
      modelCapability: `contract-model-${suffix}`,
      bridgePath: `/anything/bridge-${suffix}`,
      bridgeToken: `contract-bridge-${suffix}`,
    }
    const model = `${turn.modelProxyPath}/chat/completions`
    // The sandbox sends the placeholder, as OpenCode does. `--path-as-is`
    // sends dot segments unchanged.
    const echo = async (path: string, extra = "") =>
      (
        await handle.process.exec(
          `curl -sS --path-as-is ${extra} -H 'Authorization: Bearer ${WORKSPACE_CHAT_FIREWALL_PLACEHOLDER}' 'https://${echoHost}${path}'`,
        )
      ).stdout
    const until = async (check: () => Promise<boolean>) => {
      const started = Date.now()
      while (Date.now() - started < 30_000) {
        if (await check()) return Date.now() - started
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      throw new Error("The firewall rule did not change within 30 s")
    }
    // An earlier turn left a process in its own session; the next turn
    // starts without it, and the sandbox still answers.
    await handle.process.exec(
      "setsid nohup sleep 1001 >/dev/null 2>&1 & sleep 0.2",
    )
    let started = Date.now()
    await stopEarlierTurnProcesses(handle)
    report(`[vercel] earlier turn processes stopped ${Date.now() - started}ms`)
    const left = await handle.process.exec("pgrep -x sleep | wc -l")
    expect(left.exitCode).toBe(0)
    expect(left.stdout.trim()).toBe("0")
    started = Date.now()
    await firewall.openTurn(handle.id, turn)
    report(`[vercel] turn credentials set ${Date.now() - started}ms`)
    report(
      `[vercel] turn credentials visible after ${await until(async () => (await echo(model)).includes(turn.modelCapability))}ms`,
    )
    const bridge = await echo(turn.bridgePath)
    expect(bridge).toContain(turn.bridgeToken)
    expect(bridge).not.toContain(turn.modelCapability)
    // Dot segments and other paths get no credential.
    for (const path of [
      `${turn.modelProxyPath}/../../../../x`,
      `${turn.modelProxyPath}/%2e%2e/%2e%2e/x`,
      `${turn.bridgePath}/../x`,
    ]) {
      const body = await echo(path)
      expect(body, path).not.toContain(turn.modelCapability)
      expect(body, path).not.toContain(turn.bridgeToken)
    }
    // The firewall refuses a Host header that differs from the TLS server
    // name, so a credential never goes to another host.
    const otherHost = await echo(model, "-H 'Host: example.com'")
    expect(otherHost).toContain("request authority does not match SNI")
    expect(otherHost).not.toContain(turn.modelCapability)

    // No credential is inside: not in the environment of any process, the
    // Git config, or the files a turn writes (the OpenCode config included).
    // The OpenCode password is not in this list: the OpenCode server must
    // hold it. Each turn gets a new one (docker-agent-port-native contract).
    const secrets = [githubToken, turn.modelCapability, turn.bridgeToken]
    const inside = await handle.process.exec(
      "env; cat /proc/[0-9]*/environ /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' '\\n'; git config --global --list 2>/dev/null; git config --system --list 2>/dev/null",
    )
    expect(inside.stdout.length).toBeGreaterThan(0)
    for (const secret of secrets)
      expect(inside.stdout.includes(secret)).toBe(false)
    const tree = await handle.process.exec(
      'tar -czf - --ignore-failed-read /vercel/sandbox "$HOME" /etc /tmp 2>/dev/null | base64 -w0',
    )
    const archive = gunzipSync(Buffer.from(tree.stdout, "base64"))
    for (const secret of secrets) expect(archive.includes(secret)).toBe(false)

    started = Date.now()
    await firewall.closeTurn(handle.id)
    report(`[vercel] turn credentials removed ${Date.now() - started}ms`)
    report(
      `[vercel] turn credentials gone after ${await until(async () => {
        const body = await echo(model)
        return (
          !body.includes(turn.modelCapability) &&
          body.includes(WORKSPACE_CHAT_FIREWALL_PLACEHOLDER)
        )
      })}ms`,
    )
    const after = `${await echo(model)}${await echo(turn.bridgePath)}`
    expect(after).not.toContain(turn.modelCapability)
    expect(after).not.toContain(turn.bridgeToken)
    expect(after).toContain(WORKSPACE_CHAT_FIREWALL_PLACEHOLDER)

    // The internet stays open: a public site with no rule is reachable.
    const site = await handle.process.exec(
      "curl -sS -o /dev/null -w '%{http_code}' https://example.com/",
    )
    expect(site.stdout.trim()).toBe("200")
    await provider.destroy({ id: handle.id })
  })
})

describe("agent snapshot and Workspace base", { timeout: 900_000 }, () => {
  const githubToken = () => {
    const token = process.env.GITHUB_TOKEN?.trim()
    if (!token)
      throw new Error("GITHUB_TOKEN is required for the hosted sandbox lane")
    return token
  }
  const memoryTokens = (): SandboxGitTokenStore => {
    const held = new Map<string, { token: string; mintedAt: Date }>()
    return {
      get: async (id) => held.get(id) ?? null,
      put: async (id, token) => {
        held.set(id, { token, mintedAt: new Date() })
      },
      take: async (id) => {
        const token = held.get(id)?.token ?? null
        held.delete(id)
        return token
      },
    }
  }
  /** A conversation provider starting from `baseRef`, else the agent snapshot. */
  const conversationFrom = (baseRef?: string) => {
    const tokens = memoryTokens()
    return vercelConversationProvider({
      credentials,
      agentPassword: "contract-agent-password",
      access: {
        firewall: conversationFirewall("ctxpipe-contract.invalid"),
        tokens,
        mintGitToken: async () => githubToken(),
        revokeGitToken: async () => undefined,
      },
      tags,
      base: async () => ({
        ...(baseRef ? { ref: baseRef } : {}),
        failed: async () => undefined,
      }),
      agentSnapshot,
    })
  }
  const start = async (provider: ReturnType<typeof conversationFrom>) => {
    const handle = await provider.create({
      workspace: { source: { type: "none" } },
    } as Parameters<typeof provider.create>[0])
    created.push(handle.id)
    return handle
  }
  /**
   * OpenCode and Node with the PATH a conversation session sets, which
   * replaces the image's PATH: the agent and its commands find both.
   */
  const opencode = (handle: {
    process: {
      exec: (
        c: string,
        o: { env: Record<string, string> },
      ) => Promise<{ stdout: string; exitCode: number }>
    }
  }) =>
    handle.process.exec(
      "opencode --version && node --version && npm --version",
      {
        env: {
          PATH:
            writeWorkspaceChatOpenCodeConfig({
              conversationId: "conv_contract",
              modelBase: "openai/gpt-5.6-terra",
              isolation: "vercel",
            }).homeEnv.PATH ?? "",
        },
      },
    )
  const npmReachable = async (handle: {
    process: { exec: (c: string) => Promise<{ stdout: string }> }
  }) =>
    !(
      await handle.process.exec(
        `node -e "fetch('https://registry.npmjs.org/').then(r=>console.log(r.status),e=>console.log('blocked',e.cause?.code??e.message))"`,
      )
    ).stdout.includes("blocked")

  it("a conversation without a base starts from the agent snapshot: OpenCode present, internet open", async () => {
    let started = Date.now()
    const snapshotId = await agentSnapshot()
    report(
      `[vercel] agent snapshot (install + snapshot) ${Date.now() - started}ms`,
    )
    // Found again (cached in the process), not rebuilt.
    started = Date.now()
    expect(await vercelAgentSnapshot({ credentials, environment })).toBe(
      snapshotId,
    )
    report(`[vercel] agent snapshot lookup ${Date.now() - started}ms`)
    started = Date.now()
    const conversation = await start(conversationFrom())
    report(
      `[vercel] conversation sandbox from agent snapshot ${Date.now() - started}ms`,
    )
    const version = await opencode(conversation)
    expect(version.exitCode).toBe(0)
    expect(version.stdout).toContain(OPENCODE_VERSION)
    expect(await npmReachable(conversation)).toBe(true)
  })

  it("builds a base from the agent snapshot, starts a conversation from it with no token inside, and deletes it even without its recorded id", async () => {
    const token = githubToken()
    const revoked: string[] = []
    let started = Date.now()
    const build = await startVercelWorkspaceBase({
      credentials,
      agentSnapshotId: await agentSnapshot(),
      mintGitToken: async () => token,
      revokeGitToken: async (value) => {
        revoked.push(value)
      },
      tags: workspaceBaseTags(environment),
      expiration: 0,
    })
    // The stock clone ignores the exit code of `git clone`. A failed clone
    // left a base with no `.git`, and the test failed later, at the
    // conversation. The production build checks `git rev-parse HEAD` after
    // the clone (workspace-sandbox-base.ts); do the same check here. A clone
    // that fails 3 times is an outside fault: the error tells so.
    const helloWorld = "https://github.com/octocat/Hello-World.git"
    let cloned = ""
    for (let attempt = 1; attempt <= 3 && !cloned; attempt++) {
      if (attempt > 1) await new Promise((r) => setTimeout(r, 2_000 * attempt))
      await bootstrapWorkspace(
        build.handle,
        defineWorkspace({
          // A tiny public repository; the firewall adds the token.
          source: gitSource({
            url: helloWorld,
            ref: "master",
            auth: { token: "" },
          }),
          setup: [...WORKSPACE_CHAT_VERCEL_SETUP],
        }),
      )
      const head = await build.handle.process.exec("git rev-parse HEAD")
      if (head.exitCode === 0 && head.stdout.trim()) cloned = head.stdout
      else
        report(
          `[vercel] base clone attempt ${attempt} has no commit: ${head.stderr.trim()}`,
        )
    }
    if (!cloned) {
      const probe = await build.handle.process.exec(
        `git ls-remote --heads -- ${helloWorld} 2>&1 | tail -n 5`,
      )
      throw new Error(
        `Outside service unavailable: the base builder could not clone ${helloWorld} in 3 attempts: ${probe.stdout.trim() || "no output"}`,
      )
    }
    // The builder's internet is open; only GitHub gets a credential.
    expect(await npmReachable(build.handle)).toBe(true)
    report(
      `[vercel] base builder start + clone + setup ${Date.now() - started}ms`,
    )
    started = Date.now()
    const snapshotId = await build.capture()
    await build.finish()
    report(`[vercel] base snapshot ${Date.now() - started}ms`)
    expect(revoked).toEqual([token])

    // PR-close cleanup finds the stopped builder by its tags, and a crash
    // before the id was recorded still finds the snapshot under its builder.
    expect(
      (
        await listTaggedSandboxes(credentials, workspaceBaseTags(environment))
      ).map((sandbox) => sandbox.name),
    ).toContain(build.builderId)
    expect(
      (
        await (
          await Snapshot.list({ ...credentials, name: build.builderId })
        ).toArray()
      ).map((snapshot) => snapshot.id),
    ).toContain(snapshotId)

    started = Date.now()
    // A failed start from the base goes on from the agent snapshot. Check the
    // source snapshot, so a fallback fails here and not later as a missing
    // clone.
    const conversation = await start(conversationFrom(snapshotId))
    report(`[vercel] conversation sandbox from base ${Date.now() - started}ms`)
    const source = (
      await Sandbox.get({
        ...credentials,
        name: conversation.id,
        resume: false,
      })
    ).sourceSnapshotId
    expect(source, "conversation fell back from the base snapshot").toBe(
      snapshotId,
    )
    // The builder had a commit (checked above): a missing clone here means
    // the snapshot lost files the builder wrote.
    expect(
      await conversation.fs.exists("/workspace/.git"),
      `base snapshot ${snapshotId} lost the builder's clone (HEAD ${cloned.trim()})`,
    ).toBe(true)
    expect(await conversation.fs.read("/workspace/README")).toContain(
      "Hello World",
    )
    expect((await opencode(conversation)).stdout).toContain(OPENCODE_VERSION)
    expect(await npmReachable(conversation)).toBe(true)
    // The base holds the token nowhere: not in the git config or the
    // environment, and not in any file under .git, $HOME, /etc or /tmp. The
    // token never enters the sandbox: the sandbox streams those trees as a
    // tar, and the search runs here, in the test process.
    const config = await conversation.process.exec(
      "git -C /vercel/sandbox config --list --show-origin; env",
    )
    expect(config.stdout.length).toBeGreaterThan(0)
    expect(config.stdout.includes(token)).toBe(false)
    const tree = await conversation.process.exec(
      'tar -czf - --ignore-failed-read /vercel/sandbox/.git "$HOME" /etc /tmp 2>/dev/null | base64 -w0',
    )
    const archive = gunzipSync(Buffer.from(tree.stdout, "base64"))
    expect(archive.includes("vercel/sandbox/.git/config")).toBe(true)
    expect(archive.includes(token)).toBe(false)

    // Measure (ADR-048): does a sandbox survive deletion of its source
    // snapshot? Delete the base the way a crashed build would be cleaned up:
    // by builder only, without the recorded snapshot id.
    await conversation.fs.write("/workspace/kept.txt", "kept")
    await stopVercelSandbox({ credentials, name: conversation.id })
    await deleteVercelBuilder({ credentials, builderName: build.builderId })
    const remaining = await Snapshot.get({ ...credentials, snapshotId }).then(
      (snapshot) => snapshot.status,
      () => "deleted",
    )
    expect(remaining).toBe("deleted")
    started = Date.now()
    const resumed = await conversationFrom(snapshotId).resume({
      id: conversation.id,
    })
    report(
      `[vercel] measured: sandbox resumes after its source snapshot is deleted: ${Boolean(resumed)} (${Date.now() - started}ms)`,
    )
    expect(resumed).not.toBeNull()
    expect(await resumed?.fs.read("/workspace/kept.txt")).toBe("kept")
    // Already deleted counts as deleted.
    await deleteVercelBuilder({
      credentials,
      builderName: build.builderId,
      snapshotId,
    })
  })
})
