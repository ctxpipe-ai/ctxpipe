import {
  bootstrapWorkspace,
  defineWorkspace,
  gitSource,
} from "@tanstack/ai-sandbox"
import { VercelHandle } from "@tanstack/ai-sandbox-vercel"
import { type NetworkPolicy, Sandbox, Snapshot } from "@vercel/sandbox"
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
  agentSnapshotTags,
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
import { writeWorkspaceChatOpenCodeConfig } from "./workspace-chat-opencode-contract.js"

/**
 * Real Vercel Sandbox behavior the hosted provider relies on (ticket 02).
 * Runs only in the "hosted sandbox (Vercel)" CI lane, which has the deploy
 * credentials; without them it fails rather than skips.
 */

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
  for (const name of created) {
    try {
      const sandbox = await Sandbox.get({ ...credentials, name, resume: false })
      await sandbox.delete()
    } catch (error) {
      report(`[vercel] cleanup ${name}: ${String(error)}`)
    }
  }
  for (const snapshotId of snapshots) {
    try {
      await (await Snapshot.get({ ...credentials, snapshotId })).delete()
    } catch (error) {
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
      runtime: "node24",
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
      runtime: "node24",
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
    const base = await create({ runtime: "node24" })
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
      runtime: "node24",
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
    const sandbox = await create({ runtime: "node24", networkPolicy })
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
    const sandbox = await create({ runtime: "node24", ports: [4096] })
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
    const sandbox = await create({ runtime: "node24" })
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
      backendHost: "ctxpipe-contract.invalid",
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
      const result = await sandboxHandle.process.exec(
        "curl -sS https://api.github.com/rate_limit",
      )
      return (
        JSON.parse(result.stdout) as { resources: { core: { limit: number } } }
      ).resources.core.limit
    }
    // Unauthenticated callers get 60 requests an hour.
    expect(await coreLimit(handle)).toBeGreaterThan(60)
    const environment = await handle.process.exec(
      "env; cat /proc/1/environ 2>/dev/null | tr '\\0' '\\n'",
    )
    expect(environment.stdout.includes(githubToken)).toBe(false)
    const clone = await handle.process.exec(
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
  const conversationFrom = (baseRef?: string) =>
    vercelConversationProvider({
      credentials,
      agentPassword: "contract-agent-password",
      access: {
        backendHost: "ctxpipe-contract.invalid",
        tokens: memoryTokens(),
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
    handle.process.exec("opencode --version && node --version && npm --version", {
      env: {
        PATH: writeWorkspaceChatOpenCodeConfig({
          conversationId: "conv_contract",
          modelBase: "openai/gpt-5.6-terra",
          isolation: "vercel",
        }).homeEnv.PATH,
      },
    })
  const npmReachable = async (handle: {
    process: { exec: (c: string) => Promise<{ stdout: string }> }
  }) =>
    !(
      await handle.process.exec(
        `node -e "fetch('https://registry.npmjs.org/').then(r=>console.log(r.status),e=>console.log('blocked',e.cause?.code??e.message))"`,
      )
    ).stdout.includes("blocked")

  it("a conversation without a base starts from the agent snapshot: OpenCode present, npm unreachable", async () => {
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
    expect(await npmReachable(conversation)).toBe(false)
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
    await bootstrapWorkspace(
      build.handle,
      defineWorkspace({
        // A tiny public repository; the firewall adds the token.
        source: gitSource({
          url: "https://github.com/octocat/Hello-World.git",
          ref: "master",
          auth: { token: "" },
        }),
        setup: [...WORKSPACE_CHAT_VERCEL_SETUP],
      }),
    )
    // The builder reaches GitHub only: not the npm registry.
    expect(await npmReachable(build.handle)).toBe(false)
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
    const conversation = await start(conversationFrom(snapshotId))
    report(`[vercel] conversation sandbox from base ${Date.now() - started}ms`)
    expect(await conversation.fs.exists("/workspace/.git")).toBe(true)
    expect(await conversation.fs.read("/workspace/README")).toContain(
      "Hello World",
    )
    expect((await opencode(conversation)).stdout).toContain(OPENCODE_VERSION)
    expect(await npmReachable(conversation)).toBe(false)
    // The base holds the token nowhere: git config, environment and the
    // small files a credential would land in. The token never enters the
    // sandbox; the output is checked here, in the test process.
    const scan = await conversation.process.exec(
      'git -C /vercel/sandbox config --list --show-origin; env; for f in $(find /vercel/sandbox/.git "$HOME" -maxdepth 1 -type f -size -1M 2>/dev/null) /etc/gitconfig; do cat "$f" 2>/dev/null; done; true',
    )
    expect(scan.stdout.length).toBeGreaterThan(0)
    expect(scan.stdout.includes(token)).toBe(false)

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
