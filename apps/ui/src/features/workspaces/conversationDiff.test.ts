import { describe, expect, it } from "vitest"

import {
  formatLineCount,
  groupChangedFilesByFolder,
  placeThreadRecords,
} from "./conversationDiff"

const placeTurnChanges = (
  messages: Parameters<typeof placeThreadRecords>[0],
  turns: Parameters<typeof placeThreadRecords>[1]["turns"],
) => placeThreadRecords(messages, { turns, syncs: [] }).turns
const placeSyncs = (
  messages: Parameters<typeof placeThreadRecords>[0],
  syncs: Parameters<typeof placeThreadRecords>[1]["syncs"],
) => placeThreadRecords(messages, { turns: [], syncs }).syncs

describe("placeTurnChanges", () => {
  const user = (id: string) => ({ id, role: "user" as const, parts: [] })
  const reply = (id: string, runId?: string) => ({
    id,
    role: "assistant" as const,
    parts: [],
    ...(runId ? { metadata: { tanstack: { run: { id: runId } } } } : {}),
  })
  const record = (runId: string, turn: number) => ({
    runId,
    turn,
    files: [
      { path: "a.md", status: "modified" as const, additions: 1, deletions: 0 },
    ],
  })

  it("puts each card after the last message of its run, also with the same user count", () => {
    const placed = placeTurnChanges(
      [
        user("u1"),
        reply("a1", "run_1"),
        reply("a1b", "run_2"),
        user("u2"),
        reply("a2", "run_3"),
      ],
      [record("run_1", 1), record("run_2", 1), record("run_3", 2)],
    )
    // a1 and a1b are one shown reply (the thread groups them), so both
    // cards go after it, in run order.
    expect(
      [...placed].map(([id, items]) => [id, items.map((item) => item.runId)]),
    ).toEqual([
      ["a1", ["run_1", "run_2"]],
      ["a2", ["run_3"]],
    ])
  })

  it("puts the card of a failed turn with no reply after its user message", () => {
    const placed = placeTurnChanges(
      [user("u1"), reply("a1", "run_1"), user("u2"), user("u3")],
      [record("run_failed", 2)],
    )
    expect([...placed.keys()]).toEqual(["u2"])
  })

  it("puts the card of a live turn, whose reply has no run id yet, after that reply", () => {
    const placed = placeTurnChanges(
      [user("u1"), reply("a1")],
      [record("run_live", 1)],
    )
    expect([...placed.keys()]).toEqual(["a1"])
  })
})

describe("placeSyncs", () => {
  const user = (id: string) => ({ id, role: "user" as const, parts: [] })
  const reply = (id: string) => ({
    id,
    role: "assistant" as const,
    parts: [],
  })
  const sync = (sha: string, turn: number) => ({
    trigger: "sync" as const,
    branch: "ctxpipe/chat/conv_1/1",
    sha,
    files: 2,
    treeUrl: "https://github.com/acme/docs/tree/ctxpipe/chat/conv_1/1",
    turn,
    syncedAt: "2026-08-16T10:00:00.000Z",
  })

  it("puts each Sync after the last shown message of its user turn", () => {
    const placed = placeSyncs(
      [user("u1"), reply("a1"), reply("a1b"), user("u2"), reply("a2")],
      [sync("s1", 1), sync("s2", 1), sync("s3", 2), sync("s0", 0)],
    )
    // a1 and a1b are one shown reply. A Sync before the first user message
    // has no place.
    expect(
      [...placed].map(([id, items]) => [id, items.map((item) => item.sha)]),
    ).toEqual([
      ["a1", ["s1", "s2"]],
      ["a2", ["s3"]],
    ])
  })
})

describe("groupChangedFilesByFolder", () => {
  it("groups files by folder in path order and adds up each folder", () => {
    const groups = groupChangedFilesByFolder([
      {
        path: "apps/ui/src/b.ts",
        status: "modified",
        additions: 3,
        deletions: 1,
      },
      { path: "README.md", status: "modified", additions: 1, deletions: 0 },
      { path: "apps/ui/src/a.ts", status: "added", additions: 4, deletions: 0 },
      {
        path: "scripts/ci/x.sh",
        status: "deleted",
        additions: 0,
        deletions: 9,
      },
    ])
    expect(
      groups.map((group) => ({
        folder: group.folder,
        additions: group.additions,
        deletions: group.deletions,
        files: group.files.map((file) => file.path),
      })),
    ).toEqual([
      { folder: "", additions: 1, deletions: 0, files: ["README.md"] },
      {
        folder: "apps/ui/src",
        additions: 7,
        deletions: 1,
        files: ["apps/ui/src/a.ts", "apps/ui/src/b.ts"],
      },
      {
        folder: "scripts/ci",
        additions: 0,
        deletions: 9,
        files: ["scripts/ci/x.sh"],
      },
    ])
  })
})

describe("formatLineCount", () => {
  it("shortens large counts", () => {
    expect(formatLineCount(12)).toBe("12")
    expect(formatLineCount(1_234)).toBe("1.2k")
    expect(formatLineCount(297_000)).toBe("297k")
  })
})
