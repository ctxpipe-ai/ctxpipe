import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

test("missing git is a failed prerequisite, never an optional test skip", () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("../ci/prerequisites.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: "/nonexistent-ctxpipe-fixture" },
    },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Required prerequisite git/)
})
