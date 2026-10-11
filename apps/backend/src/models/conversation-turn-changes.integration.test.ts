import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { closeDb, initDb, withOrgDbContext } from "../db/client.js"
import {
  type ConversationTurnChanges,
  deleteConversationTurnChanges,
  listConversationTurnChanges,
  saveConversationTurnChanges,
} from "./conversation-turn-changes.js"

const __dirname = fileURLToPath(new URL(".", import.meta.url))
config({ path: resolve(__dirname, "../../.env.local") })

const suffix = `${Date.now()}_${Math.random().toString(36).slice(2)}`
const orgId = `org_test_turn_changes_${suffix}`
const otherOrgId = `org_test_turn_changes_other_${suffix}`
const conversationId = `conv_test_turn_${suffix}`
// A conversation id that starts with the first one must not match it.
const lookalikeId = `${conversationId}_x`

function changes(runId: string, turn: number): ConversationTurnChanges {
  return {
    runId,
    turn,
    startTree: "a".repeat(40),
    endTree: "b".repeat(40),
    finishedAt: Date.now(),
    files: [
      { path: "notes.md", status: "modified", additions: 2, deletions: 1 },
    ],
  }
}

describe("conversation turn changes (Postgres)", () => {
  beforeAll(() => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    initDb(process.env.DATABASE_URL)
  })

  afterAll(async () => {
    for (const id of [conversationId, lookalikeId])
      await withOrgDbContext(orgId, (db) =>
        deleteConversationTurnChanges(db, id),
      )
    await closeDb()
  })

  it("keeps each turn's files per conversation and org, in turn order", async () => {
    await saveConversationTurnChanges({
      orgId,
      conversationId,
      changes: changes("run_b", 3),
    })
    await saveConversationTurnChanges({
      orgId,
      conversationId,
      changes: changes("run_a", 1),
    })
    await saveConversationTurnChanges({
      orgId,
      conversationId: lookalikeId,
      changes: changes("run_c", 1),
    })
    // The same run again replaces its row.
    await saveConversationTurnChanges({
      orgId,
      conversationId,
      changes: { ...changes("run_b", 3), files: [] },
    })

    const listed = await listConversationTurnChanges({ orgId, conversationId })
    expect(
      listed.map((item) => [item.runId, item.turn, item.files.length]),
    ).toEqual([
      ["run_a", 1, 1],
      ["run_b", 3, 0],
    ])
    expect(
      await listConversationTurnChanges({ orgId: otherOrgId, conversationId }),
    ).toEqual([])

    await withOrgDbContext(orgId, (db) =>
      deleteConversationTurnChanges(db, conversationId),
    )
    expect(
      await listConversationTurnChanges({ orgId, conversationId }),
    ).toEqual([])
    expect(
      await listConversationTurnChanges({ orgId, conversationId: lookalikeId }),
    ).toHaveLength(1)
  })
})
