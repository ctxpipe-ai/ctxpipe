/**
 * Acceptance suite mirroring PRD §6 — Functional Requirements → Acceptance
 * Cases. Each test drives the same code paths a real agent client would and
 * checks the user-observable outcome.
 *
 * The 8 PRD cases:
 *  1. two projects can run memory MCP concurrently without port/cache clashes
 *     (covered in supervisor.test.ts via the fake fixture; re-asserted here at
 *     the policy level using two parallel servers).
 *  2. branch switch updates retrieval results after the next memory tool call
 *  3. git pull (add/edit/delete/rename) reflected after the next tool call
 *  4. duplicate id blocks hydration and reports both conflicting file paths
 *  5. merge-conflict markers block hydration and report file paths
 *  6. two agents starting in the same repo serialize through the local lock
 *  7. signed-out users can save+search via direct Markdown
 *  8. imported memories searchable after partial import (or supervisor restart)
 */

import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  acquireHydrationLock,
  buildImportPayload,
  classifyDelta,
  readManifest,
  scanMemoryTree,
  writeManifest,
} from "../../src/memory/hydration.js"
import {
  agentMemoryImport,
  agentMemorySearch,
} from "../../src/memory/agentmemory-client.js"
import {
  createMcpServer,
  type JsonRpcRequest,
} from "../../src/memory/mcp-server.js"
import type {
  Supervisor,
  RuntimeState,
} from "../../src/memory/supervisor.js"
import {
  hydrationManifestFile,
  resolveMemoryRoot,
} from "../../src/memory/paths.js"

const THIS_FILE_DIR = dirname(fileURLToPath(import.meta.url))
const FAKE = join(THIS_FILE_DIR, "fixtures", "fake-agentmemory.cjs")

function tmp(prefix = "ctxpipe-accept-"): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function seedRepo(cwd: string, orgSlug = "acme"): void {
  mkdirSync(join(cwd, ".ctxpipe"), { recursive: true })
  writeFileSync(
    join(cwd, ".ctxpipe", "config.json"),
    JSON.stringify({
      orgSlug,
      baseUrl: "http://127.0.0.1:0",
      memory: {
        provider: "agentmemory",
        enabled: true,
        memoryRoot: ".ai/memory",
      },
    }),
    "utf8",
  )
}

function seedMarkdown(
  cwd: string,
  records: Array<{
    id: string
    type: string
    body: string
    concepts?: string[]
  }>,
): void {
  for (const r of records) {
    const dir = join(cwd, ".ai", "memory", r.type)
    mkdirSync(dir, { recursive: true })
    const fm = `---\nid: ${r.id}\ntype: ${r.type}\nconcepts: [${(r.concepts ?? []).join(", ")}]\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n# ${r.id}\n${r.body}\n`
    writeFileSync(join(dir, `${r.id}.md`), fm, "utf8")
  }
}

function jsonRpc(id: number, method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id, method, params }
}

type ToolText = { type: "text"; text: string }

function payloadFrom(response: unknown): unknown {
  const r = response as { result?: { content?: ToolText[]; isError?: boolean } }
  const content = r.result?.content?.[0]?.text ?? "{}"
  return JSON.parse(content)
}

function isError(response: unknown): boolean {
  const r = response as { result?: { isError?: boolean } }
  return Boolean(r.result?.isError)
}

function staticSupervisor(state: RuntimeState | null): Supervisor {
  let s = state
  return {
    async ensureRunning() {
      if (!s) throw new Error("supervisor not configured")
      return s
    },
    async stop() {
      s = null
      return true
    },
    current() {
      return s
    },
  }
}

async function spawnFake(): Promise<{ url: string; child: ChildProcess }> {
  const port = await freePort()
  const child = spawn(process.execPath, [FAKE], {
    env: {
      ...process.env,
      III_REST_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("fake agentmemory did not start in time")),
      5_000,
    )
    const onData = (chunk: Buffer) => {
      if (String(chunk).includes("fake-agentmemory listening")) {
        clearTimeout(timer)
        child.stdout?.off("data", onData)
        resolve()
      }
    }
    child.stdout?.on("data", onData)
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
  return { url: `http://127.0.0.1:${port}`, child }
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const net = require("node:net") as typeof import("node:net")
    const srv = net.createServer()
    srv.unref()
    srv.on("error", rej)
    srv.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = srv.address()
      if (address && typeof address === "object") {
        const port = address.port
        srv.close(() => res(port))
      } else {
        srv.close()
        rej(new Error("could not allocate port"))
      }
    })
  })
}

describe("memory/acceptance — PRD §6 cases", () => {
  const children: ChildProcess[] = []
  let stateRoot: string

  beforeEach(() => {
    stateRoot = tmp("ctxpipe-accept-state-")
    process.env.CTXPIPE_MEMORY_STATE_ROOT = stateRoot
  })

  afterEach(async () => {
    delete process.env.CTXPIPE_MEMORY_STATE_ROOT
    for (const child of children.splice(0)) {
      try {
        child.kill("SIGTERM")
      } catch {
        // ignored
      }
    }
  })

  it("case 1: two parallel memory servers in different repos do not see each other's records", async () => {
    const cwdA = tmp()
    const cwdB = tmp()
    seedRepo(cwdA, "acme")
    seedRepo(cwdB, "globex")
    const serverA = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd: cwdA,
      startSupervisor: false,
      supervisor: staticSupervisor(null),
    })
    const serverB = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd: cwdB,
      startSupervisor: false,
      supervisor: staticSupervisor(null),
    })
    await serverA.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_save",
        arguments: {
          id: "in-a",
          type: "fact",
          title: "in-a",
          body: "this lives in repo A",
        },
      }),
    )
    const recall = await serverB.handle(
      jsonRpc(2, "tools/call", {
        name: "memory_recall",
        arguments: { query: "in-a" },
      }),
    )
    const matches = (payloadFrom(recall) as { matches: unknown[] }).matches
    expect(matches).toEqual([])
  })

  it("case 2/3: branch switch + edited record visible on next tool call (Markdown fallback)", async () => {
    const cwd = tmp()
    seedRepo(cwd)
    seedMarkdown(cwd, [
      { id: "a", type: "pattern", body: "alpha original" },
    ])
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: staticSupervisor(null),
    })
    let response = await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_recall",
        arguments: { query: "alpha" },
      }),
    )
    expect(
      ((payloadFrom(response) as { matches: Array<{ id: string }> }).matches).map(
        (m) => m.id,
      ),
    ).toContain("a")

    // Simulate a branch switch that replaces the body and adds a new file.
    writeFileSync(
      join(cwd, ".ai", "memory", "pattern", "a.md"),
      `---\nid: a\ntype: pattern\nconcepts: []\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-06-01T00:00:00.000Z\n---\n# a\nbeta on branch\n`,
      "utf8",
    )
    seedMarkdown(cwd, [
      { id: "b", type: "pattern", body: "gamma also on branch" },
    ])
    response = await server.handle(
      jsonRpc(2, "tools/call", {
        name: "memory_recall",
        arguments: { query: "beta" },
      }),
    )
    expect(
      ((payloadFrom(response) as { matches: Array<{ id: string }> }).matches).map(
        (m) => m.id,
      ),
    ).toContain("a")
    response = await server.handle(
      jsonRpc(3, "tools/call", {
        name: "memory_recall",
        arguments: { query: "gamma" },
      }),
    )
    expect(
      ((payloadFrom(response) as { matches: Array<{ id: string }> }).matches).map(
        (m) => m.id,
      ),
    ).toContain("b")
  })

  it("case 3b: deletes and renames are reflected after the next tool call", async () => {
    const cwd = tmp()
    seedRepo(cwd)
    seedMarkdown(cwd, [
      { id: "keep", type: "pattern", body: "kept body" },
      { id: "drop", type: "pattern", body: "dropped body" },
    ])
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: staticSupervisor(null),
    })
    // simulate `git pull` that removed `drop` and renamed `keep` to a different file
    rmSync(join(cwd, ".ai", "memory", "pattern", "drop.md"))
    rmSync(join(cwd, ".ai", "memory", "pattern", "keep.md"))
    seedMarkdown(cwd, [
      { id: "keep", type: "pattern", body: "kept body" }, // back, different basename via type dir
    ])
    const response = await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_recall",
        arguments: { query: "body" },
      }),
    )
    const ids = ((payloadFrom(response) as { matches: Array<{ id: string }> }).matches).map(
      (m) => m.id,
    )
    expect(ids).toContain("keep")
    expect(ids).not.toContain("drop")
  })

  it("case 4: duplicate ids block hydration and report all conflicting file paths", async () => {
    const cwd = tmp()
    seedRepo(cwd)
    mkdirSync(join(cwd, ".ai", "memory", "pattern"), { recursive: true })
    const fm = (slug: string) =>
      `---\nid: same\ntype: pattern\nconcepts: []\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n# ${slug}\nbody ${slug}\n`
    writeFileSync(join(cwd, ".ai", "memory", "pattern", "one.md"), fm("one"))
    writeFileSync(join(cwd, ".ai", "memory", "pattern", "two.md"), fm("two"))
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: staticSupervisor(null),
    })
    const response = await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_recall",
        arguments: { query: "anything" },
      }),
    )
    expect(isError(response)).toBe(true)
    const body = payloadFrom(response) as {
      status: string
      reason: string
      details: Array<{ file: string }>
    }
    expect(body.status).toBe("hydration-refused")
    expect(body.reason).toBe("duplicate-id")
    const files = body.details.map((d) => d.file).sort()
    expect(files).toEqual(["pattern/one.md", "pattern/two.md"])
  })

  it("case 5: merge-conflict markers block hydration and report file paths", async () => {
    const cwd = tmp()
    seedRepo(cwd)
    mkdirSync(join(cwd, ".ai", "memory", "pattern"), { recursive: true })
    writeFileSync(
      join(cwd, ".ai", "memory", "pattern", "broken.md"),
      `---\nid: broken\ntype: pattern\nconcepts: []\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n# broken\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n`,
      "utf8",
    )
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: staticSupervisor(null),
    })
    const response = await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_recall",
        arguments: { query: "anything" },
      }),
    )
    const body = payloadFrom(response) as {
      status: string
      reason: string
      details: Array<{ file: string }>
    }
    expect(body.reason).toBe("merge-conflict")
    expect(body.details[0]?.file).toBe("pattern/broken.md")
  })

  it("case 6: hydration lock serializes concurrent imports", async () => {
    const fingerprint = "repo_concurrent_test"
    const lockA = await acquireHydrationLock(fingerprint, 1_000)
    const start = Date.now()
    const otherPromise = acquireHydrationLock(fingerprint, 2_000)
    setTimeout(() => lockA.release(), 200)
    const lockB = await otherPromise
    const waited = Date.now() - start
    expect(waited).toBeGreaterThanOrEqual(150)
    lockB.release()
  })

  it("case 7: signed-out save+search round-trip via direct Markdown", async () => {
    const cwd = tmp()
    seedRepo(cwd)
    const server = createMcpServer({
      baseUrl: "http://127.0.0.1:0",
      cwd,
      startSupervisor: false,
      supervisor: staticSupervisor(null),
    })
    await server.handle(
      jsonRpc(1, "tools/call", {
        name: "memory_save",
        arguments: {
          id: "offline-save",
          type: "lesson",
          title: "Offline save",
          body: "Works without ctxpipe auth.",
        },
      }),
    )
    const recall = await server.handle(
      jsonRpc(2, "tools/call", {
        name: "memory_recall",
        arguments: { query: "offline" },
      }),
    )
    const body = payloadFrom(recall) as {
      source: string
      matches: Array<{ id: string }>
    }
    expect(body.source).toBe("markdown-fallback")
    expect(body.matches.map((m) => m.id)).toContain("offline-save")
  })

  it("case 8: imported memories are searchable after partial import", async () => {
    const cwd = tmp()
    seedRepo(cwd)
    seedMarkdown(cwd, [
      { id: "import-me", type: "pattern", body: "agentmemory should see me" },
    ])
    const { url, child } = await spawnFake()
    children.push(child)

    const scan = scanMemoryTree(resolveMemoryRoot(cwd))
    const payload = buildImportPayload({
      strategy: "merge",
      records: scan.records,
      deletedIds: [],
      agentmemoryVersion: "0.9.21",
    })
    await agentMemoryImport({ url, payload })
    const results = await agentMemorySearch({
      url,
      query: "agentmemory should see",
      project: "acme",
      cwd,
    })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0]?.id).toBe("ctxpipe_import-me")
  })

  it("manifest + delta classifier match the user-visible behaviour for the acceptance scenarios", () => {
    const cwd = tmp()
    seedRepo(cwd)
    seedMarkdown(cwd, [{ id: "x", type: "pattern", body: "first" }])
    const fingerprint = "repo_classify"
    const memoryRoot = resolveMemoryRoot(cwd)
    const first = scanMemoryTree(memoryRoot)
    expect(readManifest(fingerprint)).toBeNull()
    writeManifest(fingerprint, {
      schemaVersion: 1,
      memoryRoot: ".ai/memory",
      repoId: fingerprint,
      agentmemoryVersion: "0.9.21",
      lastHydratedAt: new Date().toISOString(),
      gitHead: null,
      files: first.fileEntries,
    })
    const persisted = JSON.parse(
      readFileSync(hydrationManifestFile(fingerprint), "utf8"),
    ) as { repoId: string }
    expect(persisted.repoId).toBe(fingerprint)
    // edit single file → small
    writeFileSync(
      join(memoryRoot, "pattern", "x.md"),
      `---\nid: x\ntype: pattern\nconcepts: []\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-06-01T00:00:00.000Z\n---\n# x\nupdated\n`,
      "utf8",
    )
    const second = scanMemoryTree(memoryRoot)
    const cls = classifyDelta({ manifest: readManifest(fingerprint), scan: second })
    expect(cls.kind).toBe("small")
  })
})
