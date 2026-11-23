import { execFileSync, spawn } from "node:child_process"
import { once } from "node:events"
import { hostname } from "node:os"
import { createInterface } from "node:readline"

import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import Docker from "dockerode"
import { describe, expect, it } from "vitest"

import {
  removeOrphanTestContainers,
  removeOrphanTestImages,
  TEST_LABEL,
  testLabelArgs,
} from "../../../../scripts/ci/test-containers.mjs"
import { contractImage } from "./contract-images.js"

/*
 * A run that stops half-way leaves no test container behind (CTX-1442), and
 * no test image (CTX-1551). Each container case starts a real owner process
 * that starts a real container, then ends that process in one way.
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

const imageExists = (name: string) =>
  docker("image", "ls", "-q", "--no-trunc", name) !== ""

/** The pid of a process on this host that has ended. */
async function endedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  await once(child, "exit")
  return child.pid as number
}

/** Builds a test image `tag` with the owner label `owner`. */
const buildImage = (tag: string, owner: string) =>
  execFileSync(
    "docker",
    ["build", "-q", "--label", `${TEST_LABEL}=${owner}`, "-t", tag, "-"],
    {
      input: `FROM ${contractImage("alpine")}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "inherit"],
    },
  )

describe("test images", () => {
  it(
    "of an owner that ended are removed, unless a container uses them, and those of a live owner or another host stay",
    { timeout: 240_000 },
    async () => {
      const suffix = `${process.pid}-${Date.now()}`
      const tags = {
        ended: `ctxpipe-test-images-proof:ended-${suffix}`,
        used: `ctxpipe-test-images-proof:used-${suffix}`,
        live: `ctxpipe-test-images-proof:live-${suffix}`,
        otherHost: `ctxpipe-test-images-proof:other-host-${suffix}`,
      }
      const ended = `${hostname()}/${await endedPid()}`
      let container = ""
      try {
        buildImage(tags.ended, ended)
        buildImage(tags.used, ended)
        buildImage(tags.live, `${hostname()}/${process.pid}`)
        buildImage(tags.otherHost, `another-host/${await endedPid()}`)
        // A run of another agent still runs this image.
        container = docker(
          "run",
          "-d",
          ...testLabelArgs(),
          tags.used,
          "sleep",
          "300",
        )

        removeOrphanTestImages()

        expect(imageExists(tags.ended)).toBe(false)
        expect(imageExists(tags.used)).toBe(true)
        expect(imageExists(tags.live)).toBe(true)
        expect(imageExists(tags.otherHost)).toBe(true)

        // When the container is gone, the next run removes the image.
        docker("rm", "--force", "--volumes", container)
        container = ""
        removeOrphanTestImages()
        expect(imageExists(tags.used)).toBe(false)
      } finally {
        if (container) docker("rm", "--force", "--volumes", container)
        for (const tag of Object.values(tags))
          if (imageExists(tag)) docker("image", "rm", "--force", tag)
      }
    },
  )
})

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

  // The product sandbox providers and @tanstack/ai-sandbox-docker create
  // their containers with dockerode (setup-test-containers.ts).
  it(
    "that product code creates with dockerode have the owner of the run, and an image of one has no owner",
    { timeout: 120_000 },
    async () => {
      const owner = process.env.CTXPIPE_TEST_OWNER
      const labels = async (id: string) =>
        (await new Docker().getContainer(id).inspect()).Config.Labels
      const handle = await dockerSandbox({
        image: contractImage("alpine"),
      }).create({ workspace: { source: { type: "none" } } })
      try {
        const [id] = docker(
          "ps",
          "-q",
          "--no-trunc",
          "--filter",
          `label=${TEST_LABEL}=${owner}`,
          "--filter",
          `ancestor=${contractImage("alpine")}`,
        ).split("\n")
        expect(id).toBeTruthy()
        // The labels that the code gives stay.
        const container = await new Docker().createContainer({
          Image: contractImage("alpine"),
          Cmd: ["true"],
          Labels: { "ai.ctxpipe.purpose": "proof" },
        })
        try {
          expect(await labels(container.id)).toMatchObject({
            "ai.ctxpipe.purpose": "proof",
            [TEST_LABEL]: owner,
          })
          const image = (await container.commit({
            repo: "ctxpipe-test-containers-proof",
            tag: "unowned",
            changes: ["USER 1000:1000"],
          })) as { Id: string }
          try {
            const config = (await new Docker().getImage(image.Id).inspect())
              .Config
            expect(config.User).toBe("1000:1000")
            expect(config.Labels?.[TEST_LABEL]).toBe("")
          } finally {
            await new Docker().getImage(image.Id).remove({ force: true })
          }
        } finally {
          await container.remove({ force: true, v: true })
        }
      } finally {
        await handle.destroy()
      }
    },
  )
})
