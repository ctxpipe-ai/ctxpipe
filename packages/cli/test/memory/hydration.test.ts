import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildImportPayload,
  classifyDelta,
  scanMemoryTree,
  searchCanonical,
  writeCanonicalRecord,
} from "../../src/memory/hydration.js"
import {
  parseRecord,
  serializeRecord,
  type MemoryRecord,
} from "../../src/memory/markdown.js"

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ctxpipe-hydration-"))
}

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = "2026-05-25T00:00:00.000Z"
  return {
    id: overrides.id ?? "mem-foo",
    type: overrides.type ?? "pattern",
    title: overrides.title ?? "Foo",
    body: overrides.body ?? "Body of foo.",
    concepts: overrides.concepts ?? [],
    files: overrides.files ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    extra: overrides.extra ?? {},
  }
}

function seedMemoryRoot(root: string, records: MemoryRecord[]): void {
  for (const r of records) {
    const dir = join(root, r.type)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${r.id}.md`), serializeRecord(r), "utf8")
  }
}

describe("memory/hydration", () => {
  it("scans an empty memory root cleanly", () => {
    const scan = scanMemoryTree(join(tmp(), "missing"))
    expect(scan.records).toEqual([])
    expect(scan.conflicts).toEqual([])
    expect(scan.parseErrors).toEqual([])
  })

  it("collects records and surfaces duplicate ids with their file paths", () => {
    const root = tmp()
    const r = record({ id: "dup", type: "pattern", body: "first" })
    seedMemoryRoot(root, [r])
    mkdirSync(join(root, "decision"), { recursive: true })
    writeFileSync(
      join(root, "decision", "also.md"),
      serializeRecord({ ...r, type: "decision", body: "second" }),
      "utf8",
    )
    const scan = scanMemoryTree(root)
    expect(scan.records).toHaveLength(2)
    expect(scan.conflicts).toEqual([
      {
        id: "dup",
        files: ["decision/also.md", "pattern/dup.md"],
      },
    ])
  })

  it("flags unresolved merge conflicts and refuses hydration", () => {
    const root = tmp()
    mkdirSync(join(root, "pattern"), { recursive: true })
    writeFileSync(
      join(root, "pattern", "broken.md"),
      `---\nid: broken\ntype: pattern\nconcepts: []\nfiles: []\ncreatedAt: 2026-05-25T00:00:00.000Z\nupdatedAt: 2026-05-25T00:00:00.000Z\n---\n<<<<<<< HEAD\na\n=======\nb\n>>>>>>> branch\n`,
      "utf8",
    )
    const scan = scanMemoryTree(root)
    const result = classifyDelta({ manifest: null, scan })
    expect(result.kind).toBe("refuse")
    if (result.kind !== "refuse") return
    expect(result.reason).toBe("merge-conflict")
    expect(result.details[0]?.file).toBe("pattern/broken.md")
  })

  it("classifies a first-run scan as a large replace import", () => {
    const root = tmp()
    seedMemoryRoot(root, [record({ id: "a" }), record({ id: "b" })])
    const scan = scanMemoryTree(root)
    const result = classifyDelta({ manifest: null, scan })
    expect(result.kind).toBe("large")
  })

  it("classifies an unchanged tree as noop", () => {
    const root = tmp()
    const r = record({ id: "a" })
    seedMemoryRoot(root, [r])
    const scan = scanMemoryTree(root)
    const manifest = {
      schemaVersion: 1 as const,
      memoryRoot: ".ai/memory",
      repoId: "repo_test",
      agentmemoryVersion: "0.9.21",
      lastHydratedAt: new Date().toISOString(),
      gitHead: null,
      files: scan.fileEntries,
    }
    const result = classifyDelta({ manifest, scan })
    expect(result.kind).toBe("noop")
  })

  it("classifies a single edit as a small merge import", () => {
    const root = tmp()
    const a = record({ id: "a" })
    const b = record({ id: "b" })
    seedMemoryRoot(root, [a, b])
    const first = scanMemoryTree(root)
    const manifest = {
      schemaVersion: 1 as const,
      memoryRoot: ".ai/memory",
      repoId: "repo_test",
      agentmemoryVersion: "0.9.21",
      lastHydratedAt: new Date().toISOString(),
      gitHead: null,
      files: first.fileEntries,
    }
    writeFileSync(
      join(root, b.type, "b.md"),
      serializeRecord({ ...b, body: "Body edited." }),
      "utf8",
    )
    const next = scanMemoryTree(root)
    const result = classifyDelta({ manifest, scan: next })
    expect(result.kind).toBe("small")
    if (result.kind !== "small") return
    expect(result.changedFiles).toEqual(["pattern/b.md"])
    expect(result.deletedFiles).toEqual([])
  })

  it("classifies deletes and includes the dropped memory ids", () => {
    const root = tmp()
    const a = record({ id: "a" })
    seedMemoryRoot(root, [a, record({ id: "b" })])
    const first = scanMemoryTree(root)
    const manifest = {
      schemaVersion: 1 as const,
      memoryRoot: ".ai/memory",
      repoId: "repo_test",
      agentmemoryVersion: "0.9.21",
      lastHydratedAt: new Date().toISOString(),
      gitHead: null,
      files: first.fileEntries,
    }
    // remove b
    const fs = require("node:fs") as typeof import("node:fs")
    fs.unlinkSync(join(root, "pattern", "b.md"))
    const next = scanMemoryTree(root)
    const result = classifyDelta({ manifest, scan: next })
    expect(result.kind).toBe("small")
    if (result.kind !== "small") return
    expect(result.deletedFiles).toEqual(["pattern/b.md"])
    expect(result.deletedMemoryIds).toEqual(["b"])
  })

  it("escalates large deltas to a full replace", () => {
    const root = tmp()
    const records = Array.from({ length: 10 }, (_, i) => record({ id: `r${i}` }))
    seedMemoryRoot(root, records)
    const first = scanMemoryTree(root)
    const manifest = {
      schemaVersion: 1 as const,
      memoryRoot: ".ai/memory",
      repoId: "repo_test",
      agentmemoryVersion: "0.9.21",
      lastHydratedAt: new Date().toISOString(),
      gitHead: null,
      files: first.fileEntries,
    }
    // touch every file
    for (const r of records) {
      writeFileSync(
        join(root, r.type, `${r.id}.md`),
        serializeRecord({ ...r, body: `Body for ${r.id}, edited.` }),
        "utf8",
      )
    }
    const next = scanMemoryTree(root)
    const result = classifyDelta({
      manifest,
      scan: next,
      fileThreshold: 4,
      ratioThreshold: 0.5,
    })
    expect(result.kind).toBe("large")
    if (result.kind !== "large") return
    expect(result.reason).toBe("above-threshold")
  })

  it("treats a rename via stable id as a small update through path remapping", () => {
    const root = tmp()
    const a = record({ id: "stable", body: "first" })
    seedMemoryRoot(root, [a])
    const first = scanMemoryTree(root)
    const manifest = {
      schemaVersion: 1 as const,
      memoryRoot: ".ai/memory",
      repoId: "repo_test",
      agentmemoryVersion: "0.9.21",
      lastHydratedAt: new Date().toISOString(),
      gitHead: null,
      files: first.fileEntries,
    }
    const fs = require("node:fs") as typeof import("node:fs")
    fs.renameSync(
      join(root, "pattern", "stable.md"),
      join(root, "pattern", "renamed.md"),
    )
    const next = scanMemoryTree(root)
    const result = classifyDelta({ manifest, scan: next })
    expect(result.kind).toBe("small")
    if (result.kind !== "small") return
    // The renamed file is treated as an add + delete, which still preserves
    // the stable id at the AgentMemory layer because both files carry the
    // same `id` in frontmatter — assert path semantics here.
    expect(result.changedFiles).toEqual(["pattern/renamed.md"])
    expect(result.deletedFiles).toEqual(["pattern/stable.md"])
    expect(result.deletedMemoryIds).toEqual(["stable"])
  })

  it("builds an AgentMemory import payload with the ctxpipe_ prefix", () => {
    const r = record({ id: "stable", concepts: ["x"], files: ["src/a.ts"] })
    const payload = buildImportPayload({
      strategy: "merge",
      records: [r],
      deletedIds: [],
      agentmemoryVersion: "0.9.21",
      now: new Date("2026-05-25T00:00:00.000Z"),
    })
    expect(payload.strategy).toBe("merge")
    expect(payload.exportData.memories).toHaveLength(1)
    expect(payload.exportData.memories[0]?.id).toBe("ctxpipe_stable")
    expect(payload.exportData.memories[0]?.concepts).toEqual(["x"])
    expect(payload.exportData.memories[0]?.files).toEqual(["src/a.ts"])
    expect(payload.exportData.sessions).toEqual([])
    expect(payload.exportData.observations).toEqual({})
  })

  it("writeCanonicalRecord creates the file and preserves createdAt on update", () => {
    const cwd = tmp()
    const first = writeCanonicalRecord({
      cwd,
      input: {
        id: "auth-session-refresh",
        type: "architecture",
        title: "Auth Session Refresh",
        body: "We refresh sessions through Better Auth.",
        concepts: ["auth"],
        files: ["apps/backend/src/auth.ts"],
      },
      now: new Date("2026-01-01T00:00:00.000Z"),
    })
    expect(first.wasUpdate).toBe(false)
    expect(first.path).toContain("architecture/auth-session-refresh.md")

    const second = writeCanonicalRecord({
      cwd,
      input: {
        id: "auth-session-refresh",
        type: "architecture",
        title: "Auth Session Refresh",
        body: "Updated body.",
      },
      now: new Date("2026-05-25T00:00:00.000Z"),
    })
    expect(second.wasUpdate).toBe(true)
    const parsed = parseRecord(
      (require("node:fs") as typeof import("node:fs")).readFileSync(
        second.path,
        "utf8",
      ),
    )
    expect(parsed.createdAt).toBe("2026-01-01T00:00:00.000Z")
    expect(parsed.updatedAt).toBe("2026-05-25T00:00:00.000Z")
  })

  it("searchCanonical returns BM25-lite ranked matches", () => {
    const records = [
      record({ id: "a", title: "Auth Session Refresh", body: "auth auth" }),
      record({ id: "b", title: "OpenTelemetry collector", body: "otel" }),
    ]
    const results = searchCanonical(records, "auth")
    expect(results[0]?.record.id).toBe("a")
    expect(results.find((r) => r.record.id === "b")).toBeUndefined()
  })
})
