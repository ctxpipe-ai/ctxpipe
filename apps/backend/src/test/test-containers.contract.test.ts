import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { hostname } from "node:os"
import { createInterface } from "node:readline"

import { describe, expect, it } from "vitest"

import {
  removeOrphanTestContainers,
  TEST_LABEL,
} from "../../../../scripts/ci/test-containers.mjs"
import { contractImage } from "./contract-images.js"

/*
 * A run that stops half-way leaves no test container behind (CTX-1442). Each
 * case starts a real owner process that starts a real container, then ends
 * that process in one way.
 */

const MODULE = new URL(
  "../../../../scripts/ci/test-containers.mjs",
  import.meta.url,
).href

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8" }).trim()

const exists = (id: string) =>
  docker("ps", "-aq", "--no-trunc", "--filter", `id=${id}`) !== ""

/**
 * Starts an owner process that starts one test container and prints its id.
 * Then the process does `then`: it throws, or it waits.
 */
async function startOwner(then: "throw" | "wait") {
  const script = `
import { execFileSync } from "node:child_process"
import { ownTestContainers, testLabelArgs } from ${JSON.stringify(MODULE)}
ownTestContainers()
const id = execFileSync("docker", ["run", "-d", ...testLabelArgs(), ${JSON.stringify(contractImage("alpine"))}, "sleep", "300"], { encoding: "utf8" }).trim()
console.log(id)
if (${JSON.stringify(then)} === "throw") throw new Error("the test failed half-way")
setInterval(() => {}, 1000)
`
  // The owner is the child process, not this test run.
  const env = { ...process.env }
  delete env.CTXPIPE_TEST_OWNER
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env,
    stdio: ["ignore", "pipe", "ignore"],
  })
  const exited = once(child, "exit")
  const [id] = (await once(
    createInterface({ input: child.stdout }),
    "line",
  )) as [string]
  return { child, id, exited }
}

describe("test containers", () => {
  it("are owned by the test run", () => {
    expect(process.env.CTXPIPE_TEST_OWNER).toMatch(/\/\d+$/)
  })

  it("are removed when the owner fails", { timeout: 120_000 }, async () => {
    const { id, exited } = await startOwner("throw")
    await exited
    expect(exists(id)).toBe(false)
  })

  it(
    "are removed when the owner gets SIGINT",
    { timeout: 120_000 },
    async () => {
      const { child, id, exited } = await startOwner("wait")
      expect(exists(id)).toBe(true)
      child.kill("SIGINT")
      const [, signal] = await exited
      // The process still ends because of the signal.
      expect(signal).toBe("SIGINT")
      expect(exists(id)).toBe(false)
    },
  )

  it(
    "of a killed owner are removed by the next run, and those of a live owner stay",
    { timeout: 120_000 },
    async () => {
      const killed = await startOwner("wait")
      const live = await startOwner("wait")
      try {
        killed.child.kill("SIGKILL")
        await killed.exited
        expect(exists(killed.id)).toBe(true)
        expect(
          docker(
            "inspect",
            "--format",
            `{{index .Config.Labels "${TEST_LABEL}"}}`,
            killed.id,
          ),
        ).toBe(`${hostname()}/${killed.child.pid}`)

        removeOrphanTestContainers()

        expect(exists(killed.id)).toBe(false)
        expect(exists(live.id)).toBe(true)
      } finally {
        live.child.kill("SIGTERM")
        await live.exited
      }
      expect(exists(live.id)).toBe(false)
    },
  )
})
