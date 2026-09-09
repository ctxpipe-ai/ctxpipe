import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dockerSandbox } from "@tanstack/ai-sandbox-docker"
import { eq } from "drizzle-orm"
import { expect, it } from "vitest"
import {
  closeDb,
  getSystemDb,
  initDb,
  withOrgDbContext,
} from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { workspaces } from "../../db/schema/workspaces.js"
import { generateObjectId } from "../../lib/id.js"

it(
  "reuses one native Docker worktree across replicas and process restarts",
  { timeout: 90_000 },
  async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for native replica proof")
    initDb(process.env.DATABASE_URL)
    const orgId = generateObjectId("org")
    const workspaceId = generateObjectId("ws")
    const names: string[] = []
    const clients: ReturnType<typeof start>[] = []
    function start(mode: "ensure" | "write" | "read" | "destroy"): {
      child: ChildProcessWithoutNullStreams
      exited: Promise<number | null>
      output: () => string
      errors: () => string
    } {
      // Different allocation names ensure Docker's name uniqueness cannot mask a broken PG lock.
      const name = `ctxpipe-native-replica-${orgId}-${names.length}`
      names.push(name)
      const child = spawn(
        "bun",
        [
          fileURLToPath(
            new URL(
              "../../test/native-sandbox-owner-client.ts",
              import.meta.url,
            ),
          ),
          orgId,
          workspaceId,
          name,
          mode,
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      )
      let output = ""
      let errors = ""
      child.stdout.on("data", (chunk) => {
        output += chunk.toString()
      })
      child.stderr.on("data", (chunk) => {
        errors += chunk.toString()
      })
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      )
      const client = {
        child,
        exited,
        output: () => output,
        errors: () => errors,
      }
      clients.push(client)
      return client
    }
    async function ready(client: ReturnType<typeof start>) {
      await expect
        .poll(() => client.output() || client.errors(), { timeout: 10_000 })
        .toContain("ready")
    }
    async function result(client: ReturnType<typeof start>) {
      expect(await client.exited, client.errors()).toBe(0)
      const line = client
        .output()
        .split("\n")
        .find((line) => line.startsWith("{"))
      if (!line) throw new Error(`Missing native result: ${client.output()}`)
      return JSON.parse(line) as { id: string; contents?: string }
    }
    const provider = dockerSandbox({ image: "node:22" })
    try {
      await getSystemDb().insert(organizations).values({
        id: orgId,
        slug: orgId,
        name: "Native replica proof",
        createdAt: new Date(),
      })
      await withOrgDbContext(orgId, (db) =>
        db.insert(workspaces).values({
          id: workspaceId,
          orgId,
          slug: "context",
          displayName: "Context",
          workspaceRepositoryUrl: "https://example.test/context.git",
        }),
      )
      const first = start("write")
      const second = start("ensure")
      await Promise.all([ready(first), ready(second)])
      first.child.stdin.end("go\n")
      second.child.stdin.end("go\n")
      const [a, b] = await Promise.all([result(first), result(second)])
      expect(a.id).toBeTruthy()
      expect(b.id).toBe(a.id)
      const restarted = start("read")
      await ready(restarted)
      restarted.child.stdin.end("go\n")
      expect(await result(restarted)).toEqual({
        id: a.id,
        contents: "survives-backend-restart",
      })
      const destroyer = start("destroy")
      await ready(destroyer)
      destroyer.child.stdin.end("go\n")
      expect(await destroyer.exited, destroyer.errors()).toBe(0)
      expect(destroyer.output()).toContain("destroyed")
      expect(await provider.resume({ id: a.id })).toBeNull()
    } finally {
      for (const client of clients) {
        if (client.child.exitCode === null && client.child.signalCode === null)
          client.child.kill("SIGKILL")
        await client.exited
      }
      for (const name of names) await provider.destroy({ id: name })
      await withOrgDbContext(orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.id, workspaceId)),
      )
      await getSystemDb()
        .delete(organizations)
        .where(eq(organizations.id, orgId))
      await closeDb()
    }
  },
)
