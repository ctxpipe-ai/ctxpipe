import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { expect, test } from "vitest"

// Started by scripts/tests/ci-checks.test.mjs with the trace on. Each case
// starts child.mjs, which runs known() from known.mjs.
const child = fileURLToPath(new URL("child.mjs", import.meta.url))

test("a Node child", () => {
  const result = spawnSync(process.execPath, [child], { encoding: "utf8" })
  expect(result.stdout).toBe("known ran")
})

test("a Bun child that a signal stops", async () => {
  const bun = spawn("bun", [child, "--wait"], { stdio: "pipe" })
  let output = ""
  for await (const chunk of bun.stdout) {
    output += chunk
    if (output === "known ran") break
  }
  bun.kill("SIGKILL")
  await new Promise((resolve) => bun.once("exit", resolve))
  expect(output).toBe("known ran")
})
