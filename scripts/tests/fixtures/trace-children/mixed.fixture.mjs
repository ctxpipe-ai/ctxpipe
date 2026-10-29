import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { expect, test } from "vitest"

import { known } from "./known.mjs"

// Started by scripts/tests/ci-checks.test.mjs with the trace on. known.mjs
// runs in a Bun child in the first case, and in this process in the second.
const child = fileURLToPath(new URL("child.mjs", import.meta.url))

test("a Bun child", async () => {
  const bun = spawn("bun", [child], { stdio: "pipe" })
  let output = ""
  for await (const chunk of bun.stdout) output += chunk
  expect(output).toBe("known ran")
})

test("in process", () => {
  expect(known()).toBe("known ran")
})
