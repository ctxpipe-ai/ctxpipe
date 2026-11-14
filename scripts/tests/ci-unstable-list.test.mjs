import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import { overdueEntries } from "../ci/check-unstable-list.mjs"

test("an unstable entry older than 7 days, or without a date, is overdue", () => {
  const entry = (since) => ({
    id: `x--${since}`,
    reason: "r",
    ticket: "CTX-1",
    since,
  })
  assert.deepEqual(
    overdueEntries(
      [
        entry("2026-11-03"),
        entry("2026-11-02"),
        entry(undefined),
        entry("soon"),
        entry("2026-11-31"),
      ],
      "2026-11-10",
    ).map((item) => item.since),
    ["2026-11-02", undefined, "soon", "2026-11-31"],
  )
})

test("the unstable list check fails on an overdue entry and names its ticket", () => {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-unstable-list-"))
  const check = (stories) => {
    mkdirSync(join(root, "scripts/ci"), { recursive: true })
    writeFileSync(
      join(root, "scripts/ci/visual-unstable-stories.json"),
      JSON.stringify({ stories }),
    )
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../ci/check-unstable-list.mjs", import.meta.url),
        ),
        root,
      ],
      { encoding: "utf8" },
    )
  }
  const today = new Date().toISOString().slice(0, 10)
  const entry = (since) => ({
    id: "card--empty",
    reason: "r",
    ticket: "CTX-1",
    since,
  })
  assert.equal(check([entry(today)]).status, 0)
  const overdue = check([entry("2026-01-02")])
  assert.equal(overdue.status, 1)
  assert.match(overdue.stderr, /card--empty \(CTX-1, since 2026-01-02\)/)
})
