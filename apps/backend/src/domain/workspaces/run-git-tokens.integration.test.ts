import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { eq } from "drizzle-orm"
import { HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest"
import { parseEnv } from "../../config/env.js"
import { closeDb, getSystemDb, initDb } from "../../db/client.js"
import { organizations } from "../../db/schema/auth.js"
import { sandboxGitTokenStore } from "../../models/sandbox-git-tokens.js"
import {
  recordedRunGitToken,
  revokeIdleRunGitTokens,
  revokeRunGitTokens,
} from "./run-git-tokens.js"
import { postgresSandboxLocks } from "./sandbox-lock-store.js"

config({
  path: resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../../.env.local",
  ),
})

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_run_tokens_${suffix}`
const revoked: string[] = []
let revokeStatus = 204
const github = setupServer(
  http.delete("https://api.github.com/installation/token", ({ request }) => {
    revoked.push(request.headers.get("authorization") ?? "")
    return new HttpResponse(null, { status: revokeStatus })
  }),
)

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
  initDb(process.env.DATABASE_URL)
  await getSystemDb().insert(organizations).values({
    id: orgId,
    slug: orgId,
    name: "Run tokens",
    createdAt: new Date(),
  })
  github.listen({ onUnhandledRequest: "error" })
})

beforeEach(() => {
  revoked.length = 0
  revokeStatus = 204
})

afterAll(async () => {
  github.close()
  const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
  for (const row of await store.list("run:")) await store.take(row.key)
  await getSystemDb().delete(organizations).where(eq(organizations.id, orgId))
  await closeDb()
})

it("records one token per label and window, and revokes the token a parallel mint lost", async () => {
  const conversationId = `conv_record_${suffix}`
  let minted = 0
  const mint = async () => {
    const token = `ghs_record_${++minted}`
    // Both requests read the empty record before either mint returns.
    await new Promise((done) => setTimeout(done, 100))
    return token
  }
  const [first, second] = await Promise.all([
    recordedRunGitToken({ orgId, conversationId, label: "clone:a", mint }),
    recordedRunGitToken({ orgId, conversationId, label: "clone:a", mint }),
  ])
  expect(first).toBe(second)
  expect(minted).toBe(2)
  expect(revoked).toEqual([
    `token ${first === "ghs_record_1" ? "ghs_record_2" : "ghs_record_1"}`,
  ])
  expect(
    await recordedRunGitToken({
      orgId,
      conversationId,
      label: "clone:a",
      mint,
    }),
  ).toBe(first)
  expect(minted).toBe(2)
  const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
  expect(
    (await store.list(`run:${conversationId}:`)).map((row) => row.token),
  ).toEqual([first])
  expect(await revokeRunGitTokens({ orgId, conversationId })).toBe(0)
})

it("revokes only one turn's tokens, keeps a token whose revoke failed, and the sweep retries it", async () => {
  const conversationId = `conv_revoke_${suffix}`
  const record = (label: string) =>
    recordedRunGitToken({
      orgId,
      conversationId,
      label,
      mint: async () => `ghs_${label.replaceAll(":", "_")}`,
    })
  await record("clone:turn")
  await record("git:owner-a:scope")
  await record("clone:other")

  revokeStatus = 500
  expect(
    await revokeRunGitTokens({
      orgId,
      conversationId,
      prefixes: ["clone:turn:", "git:owner-a:"],
    }),
  ).toBe(2)
  const store = sandboxGitTokenStore(orgId, parseEnv(process.env))
  expect(await store.list(`run:${conversationId}:`)).toHaveLength(3)

  revokeStatus = 204
  revoked.length = 0
  expect(
    await revokeRunGitTokens({
      orgId,
      conversationId,
      prefixes: ["clone:turn:", "git:owner-a:"],
    }),
  ).toBe(0)
  expect(revoked.sort()).toEqual([
    "token ghs_clone_turn",
    "token ghs_git_owner-a_scope",
  ])
  expect(
    (await store.list(`run:${conversationId}:`)).map((row) => row.token),
  ).toEqual(["ghs_clone_other"])

  // The sweep leaves a conversation that a turn holds, then revokes the rest.
  revoked.length = 0
  await postgresSandboxLocks(orgId).withLock(
    `chat-thread:${conversationId}`,
    async () => {
      expect(await revokeIdleRunGitTokens({ orgId })).toBe(true)
    },
  )
  expect(revoked).toEqual([])
  expect(await revokeIdleRunGitTokens({ orgId })).toBe(false)
  expect(revoked).toEqual(["token ghs_clone_other"])
  expect(await store.list(`run:${conversationId}:`)).toEqual([])
})
