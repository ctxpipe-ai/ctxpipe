import { VercelHandle } from "@tanstack/ai-sandbox-vercel"
import { type NetworkPolicy, Sandbox, Snapshot } from "@vercel/sandbox"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Real Vercel Sandbox behaviour the hosted provider relies on (ticket 02).
 * Runs only in the "hosted sandbox (Vercel)" CI lane, which has the deploy
 * credentials; without them it fails rather than skips.
 */

const OPENCODE_VERSION = "1.18.34"
const tags = { purpose: "ci-contract" }
const created: string[] = []
const snapshots: string[] = []
let credentials: { token: string; teamId: string; projectId: string }

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
    let started = Date.now()
    await sandbox.stop()
    report(`[vercel] stop ${Date.now() - started}ms`)
    started = Date.now()
    const resumed = await Sandbox.get({ ...credentials, name: sandbox.name })
    expect(await handle(resumed).fs.read("/workspace/state.txt")).toBe("kept")
    report(`[vercel] resume and read ${Date.now() - started}ms`)
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
