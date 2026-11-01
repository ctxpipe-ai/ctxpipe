import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { expect, test } from "vitest"

// Started by scripts/tests/ci-checks.test.mjs with the trace on. The Bun child
// gets an `env` without BUN_OPTIONS, so it cannot load the preload.
const child = fileURLToPath(new URL("child.mjs", import.meta.url))

test("a Bun child with its own env", async () => {
  const bun = spawn("bun", [child], {
    env: { PATH: process.env.PATH },
    stdio: "pipe",
  })
  let output = ""
  for await (const chunk of bun.stdout) output += chunk
  expect(output).toBe("known ran")
})
