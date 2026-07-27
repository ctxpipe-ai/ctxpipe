/**
 * PRD §6 + POLICY contract tests — tool routing and hydration side effects.
 * Complements policy.test.ts with import request tracing via fake-agentmemory.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createMcpServer } from "../../src/memory/mcp-server.js"
import { createSupervisor, type Supervisor } from "../../src/memory/supervisor.js"
import { POLICY } from "../../src/memory/policy.js"
import {
  assertCanonicalFile,
  FAKE_AGENTMEMORY,
  fetchFakeRequests,
  getToolResult,
  importCalls,
  jsonRpc,
  resetFakeRequests,
  seedMarkdown,
  seedRepoConfig,
  tmpDir,
  toolPayload,
  visiblePolicyToolNames,
} from "./memory-test-helpers.js"

describe("memory/policy-contract", () => {
  let cwd: string
  let stateRoot: string
  const supervisors: Supervisor[] = []

  beforeEach(() => {
    cwd = tmpDir("ctxpipe-policy-contract-")
    stateRoot = tmpDir("ctxpipe-policy-contract-state-")
    process.env.CTXPIPE_MEMORY_STATE_ROOT = stateRoot
    seedRepoConfig(cwd)
  })

  afterEach(async () => {
    delete process.env.CTXPIPE_MEMORY_STATE_ROOT
    for (const sup of supervisors.splice(0)) {
      await sup.stop().catch(() => {})
    }
  })

  it("tools/list exposes exactly non-hidden POLICY tools", async () => {
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
    })
    const response = await server.handle(jsonRpc(1, "tools/list"))
    const tools = (response as { result?: { tools?: Array<{ name: string }> } })
      .result?.tools
    expect(tools?.map((t) => t.name).sort()).toEqual(visiblePolicyToolNames())
    expect(Object.keys(POLICY).filter((k) => POLICY[k] === "hide")).toEqual([
      "memory_export",
      "memory_governance_delete",
    ])
  })

  it("memory_save writes Markdown then hydrates when supervisor is available", async () => {
    const fingerprint = "repo_policy_save_hydrate"
    const sup = createSupervisor({
      fingerprint,
      command: { command: process.execPath, args: [FAKE_AGENTMEMORY] },
      readinessTimeoutMs: 8_000,
    })
    supervisors.push(sup)
    const runtime = await sup.ensureRunning()
    await resetFakeRequests(runtime.url, runtime.secret)

    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      supervisor: sup,
    })
    const response = await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_save",
        arguments: {
          id: "contract-save",
          type: "lesson",
          title: "Contract Save",
          body: "Saved through policy contract test.",
          concepts: ["testing"],
        },
      }),
    )
    const result = getToolResult(response)
    expect(result.isError).toBeFalsy()
    assertCanonicalFile(cwd, {
      id: "contract-save",
      type: "lesson",
      bodyContains: "policy contract test",
      concepts: ["testing"],
    })
    const requests = await fetchFakeRequests(runtime.url, runtime.secret)
    expect(importCalls(requests).length).toBeGreaterThanOrEqual(1)
  })

  it("first memory_recall imports corpus; second recall with noop skips further imports", async () => {
    seedMarkdown(cwd, [
      {
        id: "hydrate-a",
        type: "pattern",
        body: "hydration contract alpha",
      },
    ])
    const fingerprint = "repo_policy_noop"
    const sup = createSupervisor({
      fingerprint,
      command: { command: process.execPath, args: [FAKE_AGENTMEMORY] },
      readinessTimeoutMs: 8_000,
    })
    supervisors.push(sup)
    const runtime = await sup.ensureRunning()
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      supervisor: sup,
    })

    await resetFakeRequests(runtime.url, runtime.secret)
    const first = await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_recall",
        arguments: { query: "hydration contract" },
      }),
    )
    expect(getToolResult(first).isError).toBeFalsy()
    const afterFirst = importCalls(
      await fetchFakeRequests(runtime.url, runtime.secret),
    )
    expect(afterFirst.length).toBe(1)

    await resetFakeRequests(runtime.url, runtime.secret)
    const second = await server.handle(
      jsonRpc(2, "tools/call", {
        name: "memory_recall",
        arguments: { query: "hydration contract" },
      }),
    )
    const body = toolPayload(getToolResult(second)) as {
      source: string
      matches: Array<{ id: string }>
    }
    expect(body.source).toBe("agentmemory")
    expect(body.matches.map((m) => m.id)).toContain("ctxpipe_hydrate-a")
    expect(importCalls(await fetchFakeRequests(runtime.url, runtime.secret))).toEqual(
      [],
    )
  })

  it("edited Markdown triggers a merge import on the next recall", async () => {
    seedMarkdown(cwd, [
      { id: "edit-me", type: "pattern", body: "original body for merge" },
    ])
    const fingerprint = "repo_policy_small_delta"
    const sup = createSupervisor({
      fingerprint,
      command: { command: process.execPath, args: [FAKE_AGENTMEMORY] },
      readinessTimeoutMs: 8_000,
    })
    supervisors.push(sup)
    const runtime = await sup.ensureRunning()
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      supervisor: sup,
    })

    await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_recall",
        arguments: { query: "original" },
      }),
    )
    await resetFakeRequests(runtime.url, runtime.secret)

    writeFileSync(
      join(cwd, ".ai", "memory", "pattern", "edit-me.md"),
      `---\nid: edit-me\ntype: pattern\nconcepts: []\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-06-02T00:00:00.000Z\n---\n# edit-me\nupdated body for merge\n`,
      "utf8",
    )

    await server.handle(
      jsonRpc(2, "tools/call", {
        name: "memory_recall",
        arguments: { query: "updated body" },
      }),
    )
    const imports = importCalls(
      await fetchFakeRequests(runtime.url, runtime.secret),
    )
    expect(imports.length).toBe(1)
    const summary = imports[0]?.bodySummary as {
      strategy?: string
      memoryCount?: number
    }
    expect(summary.strategy).toBe("merge")
  })

  it("memory_status does not call AgentMemory import", async () => {
    seedMarkdown(cwd, [
      { id: "status-only", type: "pattern", body: "status probe" },
    ])
    const fingerprint = "repo_policy_status"
    const sup = createSupervisor({
      fingerprint,
      command: { command: process.execPath, args: [FAKE_AGENTMEMORY] },
      readinessTimeoutMs: 8_000,
    })
    supervisors.push(sup)
    const runtime = await sup.ensureRunning()
    await resetFakeRequests(runtime.url, runtime.secret)

    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      supervisor: sup,
    })
    const response = await server.handle(
      jsonRpc(1, "tools/call", { name: "memory_status", arguments: {} }),
    )
    const body = toolPayload(getToolResult(response)) as {
      signedIn: boolean
      memoryRootExists: boolean
      runtime: unknown
    }
    expect(body.signedIn).toBe(false)
    expect(body.memoryRootExists).toBe(true)
    expect(importCalls(await fetchFakeRequests(runtime.url, runtime.secret))).toEqual(
      [],
    )
  })

  it("memory_smart_search uses the same hydrate path as memory_recall", async () => {
    seedMarkdown(cwd, [
      { id: "smart-q", type: "pattern", body: "smart search contract body" },
    ])
    const fingerprint = "repo_policy_smart"
    const sup = createSupervisor({
      fingerprint,
      command: { command: process.execPath, args: [FAKE_AGENTMEMORY] },
      readinessTimeoutMs: 8_000,
    })
    supervisors.push(sup)
    const runtime = await sup.ensureRunning()
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      supervisor: sup,
    })
    const response = await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_smart_search",
        arguments: { query: "smart search contract" },
      }),
    )
    const body = toolPayload(getToolResult(response)) as {
      source: string
      matches: Array<{ id: string }>
    }
    expect(body.source).toBe("agentmemory")
    expect(importCalls(await fetchFakeRequests(runtime.url, runtime.secret)).length).toBe(
      1,
    )
  })

  it("memory_recall falls back to Markdown without supervisor", async () => {
    seedMarkdown(cwd, [
      { id: "fallback-x", type: "pattern", body: "offline fallback recall" },
    ])
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
    })
    const response = await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_recall",
        arguments: { query: "offline fallback" },
      }),
    )
    const body = toolPayload(getToolResult(response)) as {
      source: string
      matches: Array<{ id: string }>
    }
    expect(body.source).toBe("markdown-fallback")
    expect(body.matches.map((m) => m.id)).toContain("fallback-x")
  })

  it("memory_consolidate is gated when signed out", async () => {
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
    })
    const response = await server.handle(
      jsonRpc(1, "tools/call", { name: "memory_consolidate", arguments: {} }),
    )
    const body = toolPayload(getToolResult(response)) as {
      status: string
      reason: string
    }
    expect(body.status).toBe("enhanced-memory-unavailable")
    expect(body.reason).toBe("signed-out")
  })

  it("memory_save update-in-place overwrites canonical Markdown", async () => {
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
    })
    await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_save",
        arguments: {
          id: "update-in-place",
          type: "note",
          body: "version one content",
        },
      }),
    )
    await server.handle(
      jsonRpc(2, "tools/call", {
        name: "memory_save",
        arguments: {
          id: "update-in-place",
          type: "note",
          body: "version two content",
        },
      }),
    )
    assertCanonicalFile(cwd, {
      id: "update-in-place",
      type: "note",
      bodyContains: "version two content",
    })
    const file = join(cwd, ".ai", "memory", "note", "update-in-place.md")
    const text = readFileSync(file, "utf8")
    expect(text).not.toContain("version one content")
  })
})
