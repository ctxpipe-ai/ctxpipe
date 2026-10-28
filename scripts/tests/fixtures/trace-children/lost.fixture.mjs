import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import { expect, test } from "vitest"

// Started by scripts/tests/ci-checks.test.mjs with the trace on. A signal
// stops the Node child before it writes its coverage.
const child = fileURLToPath(new URL("child.mjs", import.meta.url))

test("a Node child that a signal stops", async () => {
  const node = spawn(process.execPath, [child, "--wait"], { stdio: "pipe" })
  let output = ""
  for await (const chunk of node.stdout) {
    output += chunk
    if (output === "known ran") break
  }
  node.kill("SIGKILL")
  await new Promise((resolve) => node.once("exit", resolve))
  expect(output).toBe("known ran")
})
