import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { sandboxLocks } from "../../db/schema/sandbox-locks.js"
import { generateObjectId } from "../../lib/id.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"

it(
  "serializes independent processes and recovers after the holder is killed",
  { timeout: 45_000 },
  async () => {
    const databaseUrl = process.env.DATABASE_URL
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for native sandbox lock proof")
    initDb(databaseUrl)
    const orgId = generateObjectId("org")
    const clients: ReturnType<typeof start>[] = []
    function start(mode: "hold" | "release") {
      const process = spawn(
        "bun",
        [
          fileURLToPath(
            new URL(
              "../../test/native-sandbox-lock-client.ts",
              import.meta.url,
            ),
          ),
          orgId,
          "native-shared-lock",
          mode,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      )
      let output = ""
      let errors = ""
      process.stdout.on("data", (chunk) => {
        output += chunk.toString()
      })
      process.stderr.on("data", (chunk) => {
        errors += chunk.toString()
      })
      const exited = new Promise<number | null>((resolve) =>
        process.once("exit", (code) => resolve(code)),
      )
      return { process, exited, output: () => output, errors: () => errors }
    }
    try {
      await getSystemDb().insert(organizations).values({
        id: orgId,
        slug: orgId,
        name: "Native lock proof",
        createdAt: new Date(),
      })
      const first = start("hold")
      clients.push(first)
      await expect
        .poll(() => first.output() || first.errors(), { timeout: 8_000 })
        .toContain("entered")
      const second = start("hold")
      clients.push(second)
      await expect
        .poll(() => second.output() || second.errors(), { timeout: 8_000 })
        .toContain("ready")
      await new Promise((resolve) => setTimeout(resolve, 250))
      expect(second.output()).not.toContain("entered")
      first.process.kill("SIGKILL")
      await first.exited
      await expect
        .poll(() => second.output() || second.errors(), { timeout: 35_000 })
        .toContain("entered")
      second.process.stdin.end("release\n")
      expect(await second.exited, second.errors()).toBe(0)
      expect(second.output()).toContain("released")
      const third = start("release")
      clients.push(third)
      expect(await third.exited, third.errors()).toBe(0)
      expect(third.output()).toContain("entered\nreleased")
    } finally {
      for (const client of clients) {
        if (
          client.process.exitCode === null &&
          client.process.signalCode === null
        )
          client.process.kill("SIGKILL")
        await client.exited
      }
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
      await closeDb()
    }
  },
)

it(
  "renews ownership beyond the initial expiration and aborts callers when ownership is lost",
  { timeout: 50_000 },
  async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for native sandbox lock proof")
    initDb(process.env.DATABASE_URL)
    const orgId = generateObjectId("org")
    const controller = new AbortController()
    let entered = false
    let completed = false
    try {
      await getSystemDb().insert(organizations).values({
        id: orgId,
        slug: orgId,
        name: "Native lock renewal proof",
        createdAt: new Date(),
      })
      await expect(
        withOrgDbContext(orgId, () =>
          postgresSandboxLocks(orgId).withLock("nested", async () => undefined),
        ),
      ).rejects.toThrow("Outbound I/O cannot run inside withOrgDbContext")
      const held = postgresSandboxLocks(orgId, controller).withLock(
        "renewal",
        async (signal) => {
          entered = true
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          )
          completed = true
        },
      )
      // Attach the rejection observer before deliberately revoking the row.
      const failed = expect(held).rejects.toThrow("Sandbox lock ownership lost")
      await expect.poll(() => entered).toBe(true)
      const initial = await withOrgDbContext(orgId, (db) =>
        db.select().from(sandboxLocks),
      )
      expect(initial).toHaveLength(1)
      await new Promise((resolve) => setTimeout(resolve, 31_000))
      const renewed = await withOrgDbContext(orgId, (db) =>
        db.select().from(sandboxLocks),
      )
      expect(renewed[0]?.owner).toBe(initial[0]?.owner)
      expect(renewed[0]?.expiresAt.getTime()).toBeGreaterThan(
        initial[0]?.expiresAt.getTime() ?? 0,
      )
      expect(controller.signal.aborted).toBe(false)
      let contenderEntered = false
      const contenderController = new AbortController()
      const contender = postgresSandboxLocks(
        orgId,
        contenderController,
      ).withLock("renewal", async () => {
        contenderEntered = true
      })
      const canceled = expect(contender).rejects.toThrow()
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(contenderEntered).toBe(false)
      contenderController.abort(new Error("Contender canceled"))
      await canceled
      await withOrgDbContext(orgId, (db) => db.delete(sandboxLocks))
      await failed
      expect(controller.signal.aborted).toBe(true)
      expect(completed).toBe(true)
    } finally {
      controller.abort(new Error("Fixture teardown"))
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
      await closeDb()
    }
  },
)
