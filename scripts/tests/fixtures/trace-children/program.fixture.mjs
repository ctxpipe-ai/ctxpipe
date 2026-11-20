import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

import { expect, test } from "vitest"

// Started by scripts/tests/ci-checks-repo.test.mjs with the trace on. The case
// starts a program of the repo, as a backend test starts the file converter.
const program = fileURLToPath(new URL("program", import.meta.url))

test("a repo program", () => {
  expect(execFileSync(program, { encoding: "utf8" })).toBe("program ran\n")
})
