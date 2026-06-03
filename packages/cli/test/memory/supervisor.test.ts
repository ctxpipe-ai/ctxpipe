import { mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import {
  createSupervisor,
  PINNED_AGENTMEMORY_VERSION,
  type Supervisor,
} from "../../src/memory/supervisor.js"
import {
  agentMemoryHomeDir,
  repoStateDir,
  runtimeStateFile,
} from "../../src/memory/paths.js"

const THIS_FILE_DIR = dirname(fileURLToPath(import.meta.url))
const FAKE = join(THIS_FILE_DIR, "fixtures", "fake-agentmemory.cjs")

function freshStateRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "ctxpipe-supervisor-"))
  process.env.CTXPIPE_MEMORY_STATE_ROOT = dir
  return dir
}

describe("memory/supervisor", () => {
  const supervisors: Supervisor[] = []
  afterEach(async () => {
    for (const sup of supervisors.splice(0)) {
      await sup.stop().catch(() => {})
    }
    delete process.env.CTXPIPE_MEMORY_STATE_ROOT
  })

  it("lazily spawns the fake AgentMemory binary and waits for livez", async () => {
    freshStateRoot()
    const fingerprint = "repo_test_alpha"
    const sup = createSupervisor({
      fingerprint,
      command: { command: process.execPath, args: [FAKE] },
      readinessTimeoutMs: 5_000,
    })
    supervisors.push(sup)
    const runtime = await sup.ensureRunning()
    expect(runtime.provider).toBe("agentmemory")
    expect(runtime.agentmemoryVersion).toBe(PINNED_AGENTMEMORY_VERSION)
    expect(runtime.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(runtime.ports.rest).toBeGreaterThan(0)
    expect(runtime.pid).toBeGreaterThan(0)
    expect(existsSync(runtimeStateFile(fingerprint))).toBe(true)
    const persisted = JSON.parse(readFileSync(runtimeStateFile(fingerprint), "utf8"))
    expect(persisted.url).toBe(runtime.url)
  })

  it("generates an isolated HOME and in-memory AGENTMEMORY_SECRET per repo", async () => {
    freshStateRoot()
    const fingerprint = "repo_test_secret"
    const sup = createSupervisor({
      fingerprint,
      command: { command: process.execPath, args: [FAKE] },
      readinessTimeoutMs: 5_000,
    })
    supervisors.push(sup)
    const runtime = await sup.ensureRunning()
    const home = agentMemoryHomeDir(fingerprint)
    expect(runtime.url).toContain("127.0.0.1")
    expect(runtime.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(existsSync(home)).toBe(true)
    expect(existsSync(join(repoStateDir(fingerprint), "agentmemory-secret"))).toBe(
      false,
    )
    const stateFile = join(home, ".agentmemory", "test-state.json")
    expect(existsSync(stateFile)).toBe(true)
    const childState = JSON.parse(readFileSync(stateFile, "utf8"))
    expect(childState.pid).toBe(runtime.pid)
    const persisted = JSON.parse(readFileSync(runtimeStateFile(fingerprint), "utf8"))
    expect(persisted.secret).toBeUndefined()
  })

  it("allocates distinct ports for two concurrent supervisors", async () => {
    freshStateRoot()
    const supA = createSupervisor({
      fingerprint: "repo_test_a",
      command: { command: process.execPath, args: [FAKE] },
      readinessTimeoutMs: 5_000,
    })
    const supB = createSupervisor({
      fingerprint: "repo_test_b",
      command: { command: process.execPath, args: [FAKE] },
      readinessTimeoutMs: 5_000,
    })
    supervisors.push(supA, supB)
    const [a, b] = await Promise.all([supA.ensureRunning(), supB.ensureRunning()])
    expect(a.ports.rest).not.toBe(b.ports.rest)
    expect(a.ports.streams).not.toBe(b.ports.streams)
    expect(a.ports.viewer).not.toBe(b.ports.viewer)
    expect(a.ports.engineWs).not.toBe(b.ports.engineWs)
  })

  it("does not respawn an already-running runtime", async () => {
    freshStateRoot()
    const sup = createSupervisor({
      fingerprint: "repo_test_idem",
      command: { command: process.execPath, args: [FAKE] },
      readinessTimeoutMs: 5_000,
    })
    supervisors.push(sup)
    const first = await sup.ensureRunning()
    const second = await sup.ensureRunning()
    expect(second.pid).toBe(first.pid)
    expect(second.url).toBe(first.url)
  })

  it("stop() terminates the runtime and clears state", async () => {
    freshStateRoot()
    const sup = createSupervisor({
      fingerprint: "repo_test_stop",
      command: { command: process.execPath, args: [FAKE] },
      readinessTimeoutMs: 5_000,
    })
    const runtime = await sup.ensureRunning()
    const killed = await sup.stop()
    expect(killed).toBe(true)
    // Give the OS a moment to reap
    await new Promise((r) => setTimeout(r, 200))
    expect(() => process.kill(runtime.pid, 0)).toThrow()
  })

  it("surfaces a readiness timeout when /livez never responds", async () => {
    freshStateRoot()
    const sup = createSupervisor({
      fingerprint: "repo_test_hang",
      // Use `true` (or a sleep) so livez never becomes 200.
      command: { command: "sh", args: ["-c", "sleep 10"] },
      readinessTimeoutMs: 250,
      liveZUrl: () => "http://127.0.0.1:1/agentmemory/livez", // unroutable
    })
    supervisors.push(sup)
    await expect(sup.ensureRunning()).rejects.toThrow(/failed to become ready/)
  })
})
