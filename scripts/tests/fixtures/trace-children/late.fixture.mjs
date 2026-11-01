import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { expect, test } from "vitest"

// Started by scripts/tests/ci-checks.test.mjs with the trace on. One Node
// child gives coverage. Another child still runs when the file ends, and
// exits normally later.
const child = fileURLToPath(new URL("child.mjs", import.meta.url))

test("a Node child that gives coverage", () => {
  const result = spawnSync(process.execPath, [child], { encoding: "utf8" })
  expect(result.stdout).toBe("known ran")
})

test("a Node child that outlives its file", () => {
  const node = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"])
  node.unref()
})
