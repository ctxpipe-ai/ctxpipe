import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { and, eq } from "drizzle-orm"
import { initLogger } from "evlog"
import { delay, HttpResponse, http } from "msw"
import { setupServer } from "msw/node"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../test/db.js"
import { recordSpans } from "../../test/spans.js"
import { withOrgDbContext } from "../db/client.js"
import { conversations } from "../db/schema/conversations.js"
import { knowledgeBranchHeads } from "../db/schema/knowledge_state.js"
import { orgFeatures } from "../db/schema/org_features.js"
import { workspaceKnowledgeUnits, workspaces } from "../db/schema/workspaces.js"
import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import { createKnowledgeStore } from "../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import { getRelatedTool } from "../mcp/tools/get-related.js"
import { searchKnowledgeTool } from "../mcp/tools/search-knowledge.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
} from "../models/knowledge-state.js"
import { textEmbeddingConfig } from "../retrieval/embeddings/textEmbeddings.js"
import { startClickHouse, userUrl } from "../test/clickhouse.js"
import {
  type PlaneDocument,
  writePlaneDocuments,
} from "../test/knowledge-plane.js"
import { embedText, planeVector } from "../test/knowledge-search-fixture.js"
import {
  callTool,
  connectToolClient,
  dropOrgGraph,
  type RelatedUnit,
  seedRelatedWorkspace,
} from "../test/related-fixture.js"
import {
  selectFirstKnowledgeBranch,
  selectKnowledgeReader,
} from "./knowledge-reader.js"
import { ORCHESTRATOR_DEFAULTS } from "./orchestrator.js"

/*
 * The knowledge reader seam behind the org flag (ADR-069 decision 9), through
 * the MCP tools: real Postgres, FalkorDB and ClickHouse; msw for Jev and the
 * embedding endpoint.
 */

const MODEL_URL = "https://search-model.test/v1"
const spans = recordSpans()
const legacySha = "a".repeat(40)
const planeSha = "b".repeat(40)

/**
 * Jev answers from markers in the candidate text: "answer" gives a high
 * p(answers), "hub" a high p(explore). In the disagreement step, each pair
 * of items makes claims about the same part of the question and disagrees,
 * Item 1 changes or replaces the claim of each other item, and no claim is
 * scoped.
 */
const jevRequests: { candidates: number }[] = []
/** The state part of each candidate that Jev got. */
const jevParts: unknown[] = []
const disagreementRequests: string[][] = []
/** Fail every Jev call, or only the calls of the disagreement step. */
let jevFails: false | "all" | "disagreement" = false
/** Answer this Jev call (from 1) after the 3-second budget of these tests, or none. */
let slowJevCall: number | null = null
let jevCalls = 0
/**
 * The test that a Jev call started in. A slow call ends after its test, so
 * it records nothing in the counters of a later test.
 */
let jevTest = 0
/** Answer the embedding of the plane after the 3-second budget of these tests. */
let slowEmbedding = false
/** Answer the embedding of the plane with this HTTP status, or none. */
let embeddingFailure: number | null = null
/** The embedding requests of the plane. */
let planeEmbeddings = 0
/**
 * True: a layer judge call waits until a second one is in flight (at most
 * 2 s), so that two calls of a step that run in parallel overlap.
 */
let jevWaitsForTwo = false
let releaseJevCall: (() => void) | null = null
/** The layer judge calls in flight now, and the most at one time. */
let jevInFlight = 0
let jevMostInFlight = 0
/**
 * True: a call of the disagreement facts waits until a layer judge call
 * comes (at most 2 s). `factsWithLayer` is true when one came: the two
 * calls were in flight at one time.
 */
let factsWaitForLayer = false
/** The state parts of the calls of the disagreement facts. */
const factsParts: string[] = []
let factsWithLayer = false
let releaseFacts: (() => void) | null = null

/**
 * A slow Jev call gets a second copy of its request (`decideNoul`), with the
 * same body. Such a copy never answers, so the first copy gives each result,
 * and the counters of `handler` see one call. The key also holds the test:
 * a slow call of an earlier test can still be in flight with the same body,
 * and it must not stop the same call of the next test.
 */
function copiesNeverAnswer(
  handler: (info: { request: Request }) => Promise<Response>,
) {
  const inFlight = new Set<string>()
  return async ({ request }: { request: Request }) => {
    const key = `${jevTest}\n${await request.clone().text()}`
    if (inFlight.has(key)) return delay("infinite")
    inFlight.add(key)
    try {
      return await handler({ request })
    } finally {
      inFlight.delete(key)
    }
  }
}

const models = setupServer(
  http.post(`${MODEL_URL}/embeddings`, async ({ request }) => {
    const body = (await request.json()) as {
      input: string[]
      dimensions?: number
    }
    // Both stacks use one model; the plane asks for its own dimension.
    const plane = body.dimensions === textEmbeddingConfig.dimensions
    if (plane) planeEmbeddings += 1
    if (slowEmbedding && plane) await delay(5_000)
    if (embeddingFailure && plane)
      return new HttpResponse("busy", { status: embeddingFailure })
    return HttpResponse.json({
      data: body.input.map((input, index) => ({
        index,
        embedding: plane ? planeVector(input) : embedText(input),
      })),
    })
  }),
  http.post(
    "https://search-model.test/alpha/decisions",
    copiesNeverAnswer(async ({ request }) => {
      const body = (await request.json()) as {
        state: unknown[]
        questions: Record<string, unknown>
      }
      jevCalls += 1
      const startedIn = jevTest
      const keys = Object.keys(body.questions)
      const disagreement = !keys.some((key) => /^(answers|explore)\./.test(key))
      if (!disagreement) {
        jevInFlight += 1
        jevMostInFlight = Math.max(jevMostInFlight, jevInFlight)
        if (jevWaitsForTwo && jevInFlight >= 2) {
          // One overlap is the proof: the later calls do not wait.
          jevWaitsForTwo = false
          releaseJevCall?.()
        } else if (jevWaitsForTwo)
          await Promise.race([
            new Promise<void>((resolve) => {
              releaseJevCall = resolve
            }),
            delay(2_000),
          ])
        jevInFlight -= 1
      }
      if (!disagreement && releaseFacts) {
        factsWithLayer = true
        releaseFacts()
        releaseFacts = null
      }
      if (disagreement && factsWaitForLayer)
        await Promise.race([
          new Promise<void>((resolve) => {
            releaseFacts = resolve
          }),
          delay(2_000),
        ])
      if (jevCalls === slowJevCall) await delay(5_000)
      if (startedIn !== jevTest)
        return HttpResponse.json({ error: "test ended" }, { status: 503 })
      if (jevFails === "all" || (jevFails === "disagreement" && disagreement))
        return HttpResponse.json({ error: "down" }, { status: 503 })
      if (disagreement) {
        disagreementRequests.push(keys)
        factsParts.push(...body.state.map(String))
        const fact = (key: string) => {
          const [name, from] = key.split(".")
          if (name === "same" || name === "disagree") return 0.9
          return name === "replaces" && from === "1" ? 0.9 : 0.1
        }
        return HttpResponse.json({
          answers: Object.fromEntries(
            keys.map((key) => [key, { type: "noul", noul: fact(key) }]),
          ),
        })
      }
      const answers: Record<string, { type: "noul"; noul: number }> = {}
      body.state.forEach((part, index) => {
        const n =
          typeof part === "string" && /^Candidate (\d+) \(/.exec(part)?.[1]
        if (!n) return
        jevParts.push(body.state[index + 1])
        const text = String(body.state[index + 1])
        answers[`answers.${n}`] = {
          type: "noul",
          noul: text.includes("answer") ? 0.9 : 0.1,
        }
        answers[`explore.${n}`] = {
          type: "noul",
          noul: text.includes("hub") ? 0.9 : 0.1,
        }
      })
      jevRequests.push({ candidates: Object.keys(answers).length / 2 })
      return HttpResponse.json({ answers })
    }),
  ),
)

/**
 * One Workspace on both stacks. The checkout service is the seed. The
 * payments team owns it and answers. The database is a hub: Jev explores it
 * and finds the decision behind it, which answers at depth 2. The note does
 * neither.
 */
const units: (RelatedUnit & { text: string })[] = [
  {
    path: "knowledge/services/checkout.md",
    kind: "Service",
    title: "Checkout service",
    text: "The checkout service takes payments. hub",
    claims: [
      {
        to: "knowledge/databases/ledger.md",
        predicate: "DEPENDS_ON",
        confidence: 0.9,
      },
      {
        to: "knowledge/notes/noise.md",
        predicate: "MENTIONS",
        confidence: 0.4,
      },
    ],
  },
  {
    path: "knowledge/teams/payments.md",
    kind: "Team",
    title: "Payments team",
    text: "The payments team owns checkout. answer",
    claims: [
      {
        to: "knowledge/services/checkout.md",
        predicate: "OWNS",
        confidence: 0.9,
      },
    ],
  },
  {
    path: "knowledge/databases/ledger.md",
    kind: "Database",
    title: "Ledger database",
    text: "The ledger database of checkout. hub",
    claims: [
      {
        to: "knowledge/decisions/adr-7.md",
        predicate: "GOVERNED_BY",
        confidence: 0.8,
        validFrom: "2026-01-01T00:00:00Z",
      },
    ],
  },
  {
    path: "knowledge/decisions/adr-7.md",
    kind: "Decision",
    title: "Ledger retention decision",
    text: "We keep ledger rows for seven years. answer",
  },
  {
    path: "knowledge/notes/noise.md",
    kind: "Note",
    title: "Noise",
    text: "A note about lunch.",
  },
]

/** The path of document `index` (from 0) of a layer of the wide Workspace. */
const widePath = (prefix: string, index: number) =>
  `wide/${prefix}-${String(index + 1).padStart(2, "0")}.md`
const widePaths = (prefix: string) =>
  Array.from({ length: 49 }, (_, index) => widePath(prefix, index))
/**
 * A Workspace with more answers than the 100 results of a ranking. The seed
 * reaches a middle document that is only a hub, and 49 answers that are
 * hubs. The middle document reaches the far answer. Each answer of layer 1
 * reaches one answer that is a hub, and each of these reaches one more
 * answer. Thus 148 documents answer, and the far answer has one step.
 */
const wideUnits: (RelatedUnit & { text: string })[] = [
  {
    path: "wide/seed.md",
    kind: "Note",
    title: "Wide seed",
    text: "The start.",
    claims: [
      { to: "wide/middle.md", predicate: "DEPENDS_ON", confidence: 0.9 },
      ...widePaths("a").map((to) => ({
        to,
        predicate: "MENTIONS",
        confidence: 0.8,
      })),
    ],
  },
  {
    path: "wide/middle.md",
    kind: "Note",
    title: "Wide middle",
    text: "A bridge. hub",
    claims: [{ to: "wide/b-00.md", predicate: "DEPENDS_ON", confidence: 0.95 }],
  },
  { path: "wide/b-00.md", kind: "Note", title: "Wide far", text: "answer" },
  ...(["a", "b", "c"] as const).flatMap((prefix) =>
    widePaths(prefix).map((path, index) => ({
      path,
      kind: "Note",
      title: `Wide ${prefix} ${index + 1}`,
      text: prefix === "c" ? "answer" : "answer hub",
      claims:
        prefix === "c"
          ? []
          : [
              {
                to: widePath(prefix === "a" ? "b" : "c", index),
                predicate: "MENTIONS",
                confidence: 0.8,
              },
            ],
    })),
  ),
]

/**
 * A Workspace for the claims between the top results (CTX-1720). The seed
 * mentions two plans that answer. The new plan states that it supersedes the
 * old plan. The walk of one layer reads no relation of the two plans.
 */
const claimUnits: (RelatedUnit & { text: string })[] = [
  {
    path: "claims/seed.md",
    kind: "Note",
    title: "Claims seed",
    text: "The start.",
    claims: [
      { to: "claims/new.md", predicate: "MENTIONS", confidence: 0.8 },
      { to: "claims/old.md", predicate: "MENTIONS", confidence: 0.8 },
    ],
  },
  {
    path: "claims/new.md",
    kind: "Decision",
    title: "New plan",
    text: "The new plan. answer",
    claims: [
      {
        to: "claims/old.md",
        predicate: "SUPERSEDES",
        confidence: 0.7,
        validFrom: "2026-03-01T00:00:00Z",
        validTo: "2100-01-01T00:00:00Z",
      },
    ],
  },
  {
    path: "claims/old.md",
    kind: "Decision",
    title: "Old plan",
    text: "The old plan. answer",
  },
]

/**
 * A Workspace for the steps of CTX-1534. Two paths of the same length go
 * from the seed to the answer, each through a middle document that is only
 * a hub. The dead end is a hub with no answer after it. The aside is
 * neither a hub nor an answer.
 */
const diamondUnits: (RelatedUnit & { text: string })[] = [
  {
    path: "diamond/seed.md",
    kind: "Note",
    title: "Diamond seed",
    text: "The start.",
    claims: [
      { to: "diamond/left.md", predicate: "MENTIONS", confidence: 0.8 },
      { to: "diamond/right.md", predicate: "MENTIONS", confidence: 0.8 },
      { to: "diamond/dead-end.md", predicate: "MENTIONS", confidence: 0.8 },
      { to: "diamond/aside.md", predicate: "MENTIONS", confidence: 0.8 },
    ],
  },
  {
    path: "diamond/dead-end.md",
    kind: "Note",
    title: "Diamond dead end",
    text: "A bridge to nothing. hub",
  },
  {
    path: "diamond/aside.md",
    kind: "Note",
    title: "Diamond aside",
    text: "A note about lunch.",
  },
  {
    path: "diamond/left.md",
    kind: "Note",
    title: "Diamond left",
    text: "A bridge. hub",
    claims: [{ to: "diamond/far.md", predicate: "MENTIONS", confidence: 0.8 }],
  },
  {
    path: "diamond/right.md",
    kind: "Note",
    title: "Diamond right",
    text: "A second bridge. hub",
    claims: [{ to: "diamond/far.md", predicate: "MENTIONS", confidence: 0.7 }],
  },
  {
    path: "diamond/far.md",
    kind: "Note",
    title: "Diamond far",
    text: "answer",
  },
]

/**
 * A Workspace for the bridge to other sources. The seed is an issue with no
 * relation to the code document that answers. The other issue also answers,
 * but it is of the source of the seed, so the bridge does not add it.
 */
const bridgeUnits: (RelatedUnit & { text: string })[] = [
  {
    path: "github/issues/acme/shop/12.md",
    kind: "Issue",
    title: "Cart total is wrong",
    text: "The total of the cart is wrong after a coupon.",
  },
  {
    path: "github/issues/acme/shop/13.md",
    kind: "Issue",
    title: "Coupon rounding",
    text: "The coupon rounds the cart total down. answer",
  },
  {
    path: "knowledge/services/cart.md",
    kind: "Service",
    title: "Cart service",
    text: "The cart service adds the coupons to the cart total. answer",
  },
]

/**
 * A Workspace for the neighbors of the best search hits (CTX-1605). The
 * issue answers the question in its words and mentions the mailer. The
 * mailer answers it too, but it has no word of the question, so 60 notes
 * with words of the question come before it in the search order.
 */
const namedUnits: (RelatedUnit & { text: string })[] = [
  {
    path: "github/issues/acme/shop/40.md",
    kind: "Issue",
    title: "Refund email is late",
    text: "The refund email comes one day late.",
    claims: [
      {
        to: "knowledge/services/mailer.md",
        predicate: "MENTIONS",
        confidence: 0.8,
      },
    ],
  },
  {
    path: "knowledge/services/mailer.md",
    kind: "Service",
    title: "Mailer",
    text: "Sends messages from a queue. answer",
  },
  ...Array.from({ length: 60 }, (_, index) => ({
    path: `notes/refund-${String(index + 1).padStart(2, "0")}.md`,
    kind: "Note",
    title: `Refund note ${index + 1}`,
    text: "A note about a refund.",
  })),
]

/** The rows of `list` in the knowledge plane for one Workspace. */
function planeRows(
  workspaceId: string,
  list: readonly (RelatedUnit & { text: string })[] = units,
): PlaneDocument[] {
  const key = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  const observedAt = new Date("2026-11-01T00:00:00Z")
  // The times of the tree rows: the commit that added each file.
  const committedAt = new Date("2026-10-01T00:00:00Z")
  return list.map((unit) => ({
    document: {
      docKey: key(unit.path),
      kind: unit.kind,
      title: unit.title ?? unit.path,
      path: unit.path,
      sourceType: "docs",
      source: "",
      summary: unit.title ?? "",
      mime: "",
      createdAt: committedAt,
      updatedAt: committedAt,
      expiresAt: null,
      observedAt,
    },
    chunks: [
      {
        ordinal: 0,
        text: `${unit.title}\n\n${unit.text}`,
        startLine: 3,
        endLine: 4,
        embedding: planeVector(`${unit.title} ${unit.text}`),
      },
    ],
    relations: (unit.claims ?? []).map((claim) => ({
      srcChunk: 0,
      predicate: claim.predicate,
      dstDoc: key(claim.to),
      confidence: claim.confidence,
      validFrom: claim.validFrom ? new Date(claim.validFrom) : null,
      validTo: claim.validTo ? new Date(claim.validTo) : null,
      source: "git",
      altText: "",
      observedAt,
    })),
  }))
}

let seed: SeededOrg
let clickHouse: Awaited<ReturnType<typeof startClickHouse>>
/** The admin URL of the knowledge database, for test writes. */
let knowledgeUrl: string
let search: Client
let related: Client
const events: Record<string, unknown>[] = []
/** Workspace ids by slug. */
const ids: Record<string, string> = {}
let clock = Date.now()

/** Set the org flag, and move the clock past the 30-second flag cache. */
async function setFlag(value: "off" | "shadow" | "on") {
  await withOrgDbContext(seed.orgId, (db) =>
    db
      .insert(orgFeatures)
      .values({
        organizationId: seed.orgId,
        feature: "knowledge_plane",
        value,
      })
      .onConflictDoUpdate({
        target: [orgFeatures.organizationId, orgFeatures.feature],
        set: { value },
      }),
  )
  clock += 31_000
  vi.setSystemTime(clock)
}

/** Make a Workspace ready on the plane: a run applied `planeSha` in full. */
async function markReady(workspaceId: string) {
  await beginKnowledgeRun({
    orgId: seed.orgId,
    workspaceId,
    branch: "main",
    isDefault: true,
  })
  await completeKnowledgeRun({
    orgId: seed.orgId,
    workspaceId,
    tip: planeSha,
    branch: "main",
    treeVersion: 1,
    baseBranch: null,
    projectionVersion: "test",
    failedCount: 0,
  })
}

async function markNotReady(workspaceId: string) {
  await withOrgDbContext(seed.orgId, (db) =>
    db
      .delete(knowledgeBranchHeads)
      .where(
        and(
          eq(knowledgeBranchHeads.organizationId, seed.orgId),
          eq(knowledgeBranchHeads.workspaceId, workspaceId),
        ),
      ),
  )
}

/**
 * Write `documents` as the overlay of `branch` on the default branch of a
 * ready Workspace, and complete its run.
 */
async function markBranchReady(
  workspaceId: string,
  branch: string,
  documents: PlaneDocument[],
) {
  const writer = createKnowledgeStore(knowledgeUrl)
  try {
    await writePlaneDocuments(
      writer,
      { orgId: seed.orgId, workspaceId },
      documents,
      { branch },
    )
  } finally {
    await writer.close()
  }
  const key = { orgId: seed.orgId, workspaceId, branch }
  await beginKnowledgeRun({ ...key, isDefault: false })
  await completeKnowledgeRun({
    ...key,
    tip: "b".repeat(40),
    treeVersion: 1,
    baseBranch: "main",
    projectionVersion: "test",
    failedCount: 0,
  })
}

/** A document of a branch whose text answers the search of `searchCall`. */
const branchPlaneDocument = (
  workspaceId: string,
  path: string,
  title: string,
): PlaneDocument => ({
  document: {
    docKey: servingIdForKnowledgePath(workspaceId, path),
    kind: "Note",
    title,
    path,
    sourceType: "docs",
    source: "",
    summary: title,
    mime: "",
    createdAt: null,
    updatedAt: null,
    expiresAt: null,
    observedAt: new Date("2026-11-01T00:00:00Z"),
  },
  chunks: [
    {
      ordinal: 0,
      text: `${title}\n\nThe plan of the branch. answer`,
      startLine: 1,
      endLine: 2,
      embedding: planeVector(`${title} The plan of the branch. answer`),
    },
  ],
  relations: [],
})

type ShadowEvent = Record<string, unknown> & {
  plane: Record<string, unknown>
}

/** The one shadow event of a call, after the plane read off the request path ends. */
async function shadowEvent(): Promise<ShadowEvent> {
  const shadow = () =>
    events.filter((event) => event.step === "knowledge_plane.shadow")
  await vi.waitFor(
    () => {
      expect(shadow()).toHaveLength(1)
    },
    { timeout: 10_000 },
  )
  return shadow()[0] as ShadowEvent
}

const structured = (result: CallToolResult) =>
  result.structuredContent as Record<string, unknown>
const searchCall = (args: Record<string, unknown>) =>
  callTool(search, "search_knowledge", {
    org: seed.orgSlug,
    query: "who owns checkout",
    ...args,
  })
const relatedCall = (args: Record<string, unknown>) =>
  callTool(related, "get_related", {
    org: seed.orgSlug,
    workspace: "ready",
    seeds: ["knowledge/services/checkout.md"],
    ...args,
  })

/**
 * The shape of a value: the keys and the types, with the union of the keys
 * of the items of an array.
 */
function shapeOf(value: unknown, omit = ["cursor"]): unknown {
  if (Array.isArray(value)) {
    const items = value.map((item) => shapeOf(item, omit))
    const merged: Record<string, unknown> = {}
    for (const item of items)
      if (item && typeof item === "object") Object.assign(merged, item)
    if (items.length === 0) return []
    return [typeof value[0] === "object" ? merged : items[0]]
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !omit.includes(key))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shapeOf(item, omit)]),
    )
  return typeof value
}

describe("the knowledge reader seam", () => {
  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    vi.useFakeTimers({ now: clock, toFake: ["Date"] })
    vi.stubEnv("MODEL_PROVIDER", "openai-like")
    vi.stubEnv("MODEL_PROVIDER_API_KEY", "fixture-only")
    vi.stubEnv("MODEL_PROVIDER_URL", MODEL_URL)
    // ClickHouse and FalkorDB are real servers.
    models.listen({ onUnhandledRequest: "bypass" })
    initLogger({
      pretty: false,
      silent: true,
      drain: (ctx) => {
        events.push(ctx.event)
      },
    })
    clickHouse = await startClickHouse()
    const url = await clickHouse.freshDatabase()
    knowledgeUrl = url
    await migrateKnowledgeStore(url, {
      reader: "reader-test",
      writer: "writer-test",
    })
    // The backend reads as the reader user, with SELECT only.
    vi.stubEnv("CLICKHOUSE_URL", userUrl(url, "ctxpipe_reader", "reader-test"))
    seed = await seedOrg()
    const writer = createKnowledgeStore(url)
    try {
      for (const slug of ["ready", "fresh", "paging"]) {
        const { workspaceId } = await seedRelatedWorkspace({
          seed,
          slug,
          sha: legacySha,
          units: units.map(({ text, ...unit }) => ({
            ...unit,
            body: `# ${unit.title}\n\n${text}`,
          })),
          chunks: true,
        })
        ids[slug] = workspaceId
        // The claims of the old stack, so that its hits show them as the
        // hits of the plane do.
        await withOrgDbContext(seed.orgId, async (db) => {
          for (const unit of units)
            await db
              .update(workspaceKnowledgeUnits)
              .set({
                claims: (unit.claims ?? []).map((claim) => ({
                  to: claim.to,
                  predicate: claim.predicate,
                  confidence: claim.confidence,
                  validFrom: claim.validFrom ?? null,
                  validTo: null,
                  source: null,
                })),
              })
              .where(
                and(
                  eq(workspaceKnowledgeUnits.workspaceId, workspaceId),
                  eq(workspaceKnowledgeUnits.path, unit.path),
                ),
              )
        })
        await writePlaneDocuments(
          writer,
          { orgId: seed.orgId, workspaceId },
          planeRows(workspaceId),
        )
      }
    } finally {
      await writer.close()
    }
    // The wide and the diamond Workspaces are only on the plane.
    const planeOnly = async (
      slug: string,
      list: readonly (RelatedUnit & { text: string })[],
    ) => {
      const { workspaceId } = await seedRelatedWorkspace({
        seed,
        slug,
        sha: legacySha,
        units: [],
      })
      ids[slug] = workspaceId
      const planeWriter = createKnowledgeStore(url)
      try {
        await writePlaneDocuments(
          planeWriter,
          { orgId: seed.orgId, workspaceId },
          planeRows(workspaceId, list),
        )
      } finally {
        await planeWriter.close()
      }
    }
    await planeOnly("wide", wideUnits)
    await planeOnly("diamond", diamondUnits)
    await planeOnly("bridge", bridgeUnits)
    await planeOnly("named", namedUnits)
    await planeOnly("claims", claimUnits)
    await markReady(ids.ready as string)
    await markReady(ids.paging as string)
    await markReady(ids.wide as string)
    await markReady(ids.diamond as string)
    await markReady(ids.bridge as string)
    await markReady(ids.named as string)
    await markReady(ids.claims as string)
    // A first run that has not ended: not ready.
    await beginKnowledgeRun({
      orgId: seed.orgId,
      workspaceId: ids.fresh as string,
      branch: "main",
      isDefault: true,
    })
    search = await connectToolClient(seed, searchKnowledgeTool)
    related = await connectToolClient(seed, getRelatedTool)
  }, 240_000)

  beforeEach(() => {
    // A budget of 3 s, so that a slow call of 5 s ends it. The product
    // budget is longer than 5 s.
    ORCHESTRATOR_DEFAULTS.timeBudgetMs = 3_000
    jevTest += 1
    jevFails = false
    slowJevCall = null
    slowEmbedding = false
    embeddingFailure = null
    planeEmbeddings = 0
    jevWaitsForTwo = false
    releaseJevCall = null
    jevMostInFlight = 0
    factsWaitForLayer = false
    factsWithLayer = false
    releaseFacts = null
    jevCalls = 0
    jevRequests.length = 0
    jevParts.length = 0
    disagreementRequests.length = 0
    factsParts.length = 0
    events.length = 0
  })

  afterAll(async () => {
    await search?.close()
    await related?.close()
    if (seed) {
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
      )
      await dropOrgGraph(seed.orgId)
      await cleanupSeededOrg(seed)
    }
    await clickHouse?.stop()
    models.close()
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it("off: the old stack answers, and the plane gets no call", async () => {
    await setFlag("off")
    const result = await searchCall({ workspaces: ["ready"] })
    expect(result.isError).toBeFalsy()
    const content = structured(result)
    expect(content.partial).toBeUndefined()
    const hits = content.hits as { ref: string; served: { sha: string } }[]
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.served.sha).toBe(legacySha)
    expect(jevRequests).toEqual([])
  })

  it.each([
    ["off", legacySha],
    ["on", planeSha],
  ] as const)(
    "%s: the mcp.tool spans of the read tools have the retrieval counts, and no query text or ref",
    async (flag, sha) => {
      await setFlag(flag)
      spans.reset()
      const searched = structured(
        await searchCall({ workspaces: ["ready"], kinds: ["Service", "Team"] }),
      )
      const related = structured(
        await relatedCall({ query: "who owns it", maxDepth: 1 }),
      )
      const hits = searched.hits as { score: number; served: { sha: string } }[]
      const results = related.results as { score: number }[]
      expect(hits[0]?.served.sha).toBe(sha)
      expect(results.length).toBeGreaterThan(0)
      const attributes = (name: string) =>
        spans.spanNamed(`mcp.tool ${name}`)?.attributes ?? {}
      const search = attributes("search_knowledge")
      expect(search).toMatchObject({
        "ctxpipe.mcp.args": "kinds,limit,query,workspaces",
        "ctxpipe.mcp.query.length": "who owns checkout".length,
        "ctxpipe.mcp.result.count": hits.length,
        "ctxpipe.mcp.result.top_score": Math.max(
          ...hits.map((hit) => hit.score),
        ),
      })
      const walk = attributes("get_related")
      expect(walk).toMatchObject({
        "ctxpipe.mcp.query.length": "who owns it".length,
        "ctxpipe.mcp.result.count": results.length,
        "ctxpipe.mcp.result.top_score": Math.max(
          ...results.map((result) => result.score),
        ),
      })
      expect(walk["ctxpipe.mcp.args"]).toContain("seeds")
      // The names of the arguments only: no query text, filter value, or ref.
      const serialized = JSON.stringify([search, walk])
      for (const text of ["who owns", "Service", "ready", "knowledge/"])
        expect(serialized).not.toContain(text)
    },
  )

  it("on: the plane answers a ready Workspace in Jev's order, with the lines and the SHA of the plane", async () => {
    await setFlag("on")
    const result = await searchCall({ workspaces: ["ready"] })
    expect(result.isError).toBeFalsy()
    const hits = structured(result).hits as {
      ref: string
      score: number
      startLine: number
      endLine: number
      served: { branch: string; sha: string }
      claims?: string
    }[]
    expect(jevRequests.length).toBe(1)
    // The two documents that answer come first, with p(answers) as score.
    expect(
      hits
        .slice(0, 2)
        .map((hit) => hit.ref)
        .sort(),
    ).toEqual(["knowledge/decisions/adr-7.md", "knowledge/teams/payments.md"])
    expect(hits[0]).toMatchObject({
      score: 0.9,
      startLine: 3,
      endLine: 4,
      served: { branch: "main", sha: planeSha },
    })
    expect(
      hits.find((hit) => hit.ref === "knowledge/teams/payments.md")?.claims,
    ).toBe("OWNS knowledge/services/checkout.md")
  })

  it("on: a branch reads its overlay on the default branch, and each reader of the Workspace reads the session branch of any conversation", async () => {
    await setFlag("on")
    const workspaceId = ids.ready as string
    const branchDocument = (path: string, title: string) =>
      branchPlaneDocument(workspaceId, path, title)
    const refsOf = (result: CallToolResult) =>
      (structured(result).hits as { ref: string }[]).map((hit) => hit.ref)
    await markBranchReady(workspaceId, "feature", [
      branchDocument("knowledge/branch/plan.md", "Feature plan"),
    ])
    const onBranch = await searchCall({
      workspaces: ["ready"],
      branch: "feature",
    })
    expect(onBranch.isError).toBeFalsy()
    expect(refsOf(onBranch)).toContain("knowledge/branch/plan.md")
    // The overlay adds to the default branch: its files stay.
    expect(refsOf(onBranch)).toContain("knowledge/decisions/adr-7.md")
    expect(
      (structured(onBranch).hits as { served: { branch: string } }[])[0]?.served
        .branch,
    ).toBe("feature")
    // The default branch does not see the overlay.
    expect(refsOf(await searchCall({ workspaces: ["ready"] }))).not.toContain(
      "knowledge/branch/plan.md",
    )
    // A branch with no projection.
    const unknown = await searchCall({ workspaces: ["ready"], branch: "nope" })
    expect(unknown.isError).toBe(true)
    expect(JSON.stringify(unknown.content)).toContain(
      "has no knowledge projection",
    )

    // The session branch of the conversation of a user: each actor that can
    // read the Workspace reads it, here the org API key (the CTO: "anyone
    // who can read the workspace can read any branch, because they can read
    // git anyways"). The conversation itself stays private.
    const conversationId = `conv_user_${Math.random().toString(36).slice(2, 8)}`
    await withOrgDbContext(seed.orgId, (db) =>
      db.insert(conversations).values({
        id: conversationId,
        orgId: seed.orgId,
        workspaceId,
        userId: seed.userId,
        source: "web",
      }),
    )
    const sessionBranch = `ctxpipe/chat/${conversationId}/1`
    await markBranchReady(workspaceId, sessionBranch, [
      branchDocument(`knowledge/branch/${conversationId}.md`, "Session work"),
    ])
    const ofUser = await searchCall({
      workspaces: ["ready"],
      branch: sessionBranch,
    })
    expect(ofUser.isError).toBeFalsy()
    expect(refsOf(ofUser)).toContain(`knowledge/branch/${conversationId}.md`)

    // The old stack serves no branch.
    await setFlag("shadow")
    const shadow = await searchCall({
      workspaces: ["ready"],
      branch: "feature",
    })
    expect(shadow.isError).toBe(true)
    expect(JSON.stringify(shadow.content)).toContain(
      "needs the knowledge plane",
    )
  })

  it("a chat call reads its session branch when it has a projection, else its base branch, else the default branch", async () => {
    await setFlag("on")
    const workspaceId = ids.ready as string
    const suffix = Math.random().toString(36).slice(2, 8)
    const base = `base-${suffix}`
    const session = `ctxpipe/chat/conv_${suffix}/1`
    const served = async () => {
      const selection = await selectFirstKnowledgeBranch(
        seed.orgId,
        [workspaceId],
        [session, base],
      )
      return {
        branch: selection.branch,
        sha: selection.planeHeads.get(workspaceId)?.sha,
      }
    }
    expect(await served()).toEqual({ branch: undefined, sha: planeSha })
    await markBranchReady(workspaceId, base, [
      branchPlaneDocument(workspaceId, "knowledge/base.md", "Base plan"),
    ])
    expect((await served()).branch).toBe(base)
    await markBranchReady(workspaceId, session, [
      branchPlaneDocument(workspaceId, "knowledge/session.md", "Session plan"),
    ])
    expect((await served()).branch).toBe(session)
    // The old stack serves only the default branch.
    await setFlag("shadow")
    expect(await served()).toEqual({ branch: undefined, sha: undefined })
  })

  it("on: a Workspace before its first full run uses the old stack", async () => {
    await setFlag("on")
    const result = await searchCall({ workspaces: ["fresh"] })
    const hits = structured(result).hits as { served: { sha: string } }[]
    expect(hits[0]?.served.sha).toBe(legacySha)
    expect(jevRequests).toEqual([])
  })

  it("on: a call over a ready and a not-ready Workspace uses the old stack for the whole call", async () => {
    await setFlag("on")
    const result = await searchCall({ workspaces: ["ready", "fresh"] })
    const hits = structured(result).hits as {
      workspace: string
      served: { sha: string }
    }[]
    expect(new Set(hits.map((hit) => hit.workspace))).toEqual(
      new Set(["ready", "fresh"]),
    )
    expect(hits.every((hit) => hit.served.sha === legacySha)).toBe(true)
    expect(jevRequests).toEqual([])
  })

  it.each(["shadow", "on"] as const)(
    "%s: a read that the old stack serves because a Workspace is not ready logs one fallback event with ids only",
    async (flag) => {
      await setFlag(flag)
      const query = "who owns checkout in the fallback"
      const result = await searchCall({ workspaces: ["ready", "fresh"], query })
      expect(result.isError).toBeFalsy()
      const fallbacks = events.filter(
        (event) => event.step === "knowledge_plane.fallback",
      )
      expect(fallbacks).toEqual([
        expect.objectContaining({
          flag,
          orgId: seed.orgId,
          workspaceIds: expect.arrayContaining([ids.ready, ids.fresh]),
          notReadyIds: [ids.fresh],
        }),
      ])
      expect(fallbacks[0]?.workspaceIds).toHaveLength(2)
      expect(JSON.stringify(fallbacks)).not.toContain(query)
      // The chat selection logs the same event when it ends in the fallback.
      events.length = 0
      const selection = await selectFirstKnowledgeBranch(
        seed.orgId,
        [ids.fresh as string],
        ["no-such-branch"],
      )
      expect(selection.reader.stack).toBe("legacy")
      expect(
        events.filter((event) => event.step === "knowledge_plane.fallback"),
      ).toEqual([
        expect.objectContaining({
          flag,
          orgId: seed.orgId,
          workspaceIds: [ids.fresh],
          notReadyIds: [ids.fresh],
        }),
      ])
    },
  )

  it("no fallback event when the flag is off, or when each Workspace is ready", async () => {
    await setFlag("off")
    await searchCall({ workspaces: ["ready", "fresh"] })
    await setFlag("on")
    await searchCall({ workspaces: ["ready"] })
    expect(
      events.filter((event) => event.step === "knowledge_plane.fallback"),
    ).toEqual([])
  })

  it("on: the output of both tools has the shape of the old stack", async () => {
    await setFlag("off")
    const legacySearch = structured(await searchCall({ workspaces: ["ready"] }))
    const legacyRelated = structured(await relatedCall({ maxDepth: 2 }))
    await setFlag("on")
    const planeSearch = structured(await searchCall({ workspaces: ["ready"] }))
    const planeRelated = structured(await relatedCall({ maxDepth: 2 }))
    // Only the plane gives the createdAt of a result (CTX-1710).
    const omit = ["cursor", "createdAt"]
    expect(shapeOf(planeSearch, omit)).toEqual(shapeOf(legacySearch, omit))
    // Only the plane gives the claims between the top results, and the
    // source type of each result.
    const { claims, results, ...rankedOnly } = planeRelated
    expect(claims).toEqual(expect.any(Array))
    const { results: legacyResults, ...legacyRankedOnly } = legacyRelated
    expect(shapeOf(rankedOnly, omit)).toEqual(shapeOf(legacyRankedOnly, omit))
    expect(
      shapeOf(
        (results as Record<string, unknown>[]).map(
          ({ sourceType: _sourceType, ...result }) => result,
        ),
        omit,
      ),
    ).toEqual(shapeOf(legacyResults, omit))
    expect(legacyRelated.claims).toBeUndefined()
    expect(shapeOf(planeSearch)).toMatchSnapshot()
    expect(shapeOf(planeRelated)).toMatchSnapshot()
  })

  it("on: get_related keeps what answers and each step to it, explores the hubs, and gives the why path", async () => {
    await setFlag("on")
    const result = await relatedCall({ maxDepth: 3 })
    expect(result.isError).toBeFalsy()
    const content = structured(result)
    expect(content.served).toEqual({ branch: "main", sha: planeSha })
    expect(content.partial).toBe(false)
    expect(content.results).toEqual([
      expect.objectContaining({
        ref: "knowledge/teams/payments.md",
        kind: "Team",
        score: 0.9,
        depth: 1,
        path: [
          {
            from: "knowledge/services/checkout.md",
            to: "knowledge/teams/payments.md",
            predicate: "OWNS",
            weight: 0.9,
          },
        ],
      }),
      expect.objectContaining({
        ref: "knowledge/decisions/adr-7.md",
        depth: 2,
        path: [
          {
            from: "knowledge/services/checkout.md",
            to: "knowledge/databases/ledger.md",
            predicate: "DEPENDS_ON",
            weight: 0.9,
          },
          {
            from: "knowledge/databases/ledger.md",
            to: "knowledge/decisions/adr-7.md",
            predicate: "GOVERNED_BY",
            weight: 0.8,
          },
        ],
      }),
      // The ledger does not answer, but it is the step from the seed to the
      // decision (CTX-1520). It comes after the results that answer, with
      // its own p(answers) as its score. The note is no step, so it is out.
      expect.objectContaining({
        ref: "knowledge/databases/ledger.md",
        score: 0.1,
        depth: 1,
        path: [
          {
            from: "knowledge/services/checkout.md",
            to: "knowledge/databases/ledger.md",
            predicate: "DEPENDS_ON",
            weight: 0.9,
          },
        ],
      }),
    ])
    // Layer 0 judges the seed; layer 1 the three neighbors; layer 2 the one
    // neighbor of the hub.
    expect(jevRequests).toEqual([
      { candidates: 1 },
      { candidates: 3 },
      { candidates: 1 },
    ])
    // The disagreement step: one call with the facts of the pair and of
    // each item. Code reads them as readings.
    expect(disagreementRequests).toEqual([
      [
        "same.1.2",
        "disagree.1.2",
        "replaces.1.2",
        "replaces.2.1",
        "scoped.1",
        "scoped.2",
      ],
    ])
    // A reading of the model, as a claim with no verdict on a result.
    expect(content.claims).toEqual([
      {
        from: "knowledge/teams/payments.md",
        to: "knowledge/decisions/adr-7.md",
        predicate: "REPLACES",
        by: "reading",
        confidence: 0.9,
      },
    ])
  })

  it("on: get_related keeps the step of each kept answer when the answers pass the result limit", async () => {
    await setFlag("on")
    const refs: string[] = []
    let cursor: string | undefined
    // The limit is the subject, not the time budget. The walk of three
    // layers of 148 documents can take more than 3 s on a loaded host, and
    // then the result is partial after layer 1 (CTX-1534).
    const before = ORCHESTRATOR_DEFAULTS.timeBudgetMs
    ORCHESTRATOR_DEFAULTS.timeBudgetMs = 0
    try {
      do {
        const content = structured(
          await relatedCall({
            workspace: "wide",
            seeds: ["wide/seed.md"],
            maxDepth: 3,
            limit: 50,
            maxTokens: 8_000,
            ...(cursor ? { cursor } : {}),
          }),
        )
        expect(content.partial).toBe(false)
        refs.push(...(content.results as { ref: string }[]).map((r) => r.ref))
        cursor = content.cursor as string | undefined
      } while (cursor)
    } finally {
      ORCHESTRATOR_DEFAULTS.timeBudgetMs = before
    }
    // 148 documents answer. The 100 results are the best answers, each with
    // its steps: the 49 answers of layer 1, the far answer and its step (the
    // middle document), and the 49 other answers of layer 2. The answers of
    // layer 3 do not fit with their steps.
    expect(refs).toHaveLength(100)
    expect(refs.at(-1)).toBe("wide/middle.md")
    expect(refs).toContain("wide/b-00.md")
    expect(refs.filter((ref) => ref.startsWith("wide/c-"))).toEqual([])
  })

  it("on: get_related keeps each document that Jev marks to explore as a step, also with no answer after it", async () => {
    await setFlag("on")
    const content = structured(
      await relatedCall({
        workspace: "diamond",
        seeds: ["diamond/seed.md"],
        maxDepth: 3,
      }),
    )
    const results = content.results as {
      ref: string
      path: { from: string; to: string }[]
    }[]
    // The why path of the answer goes through the left document, the
    // relation with the higher confidence. The right document is the step
    // of the other path, and the dead end is a step with no answer after
    // it. The aside has a low p(explore), so it is no step.
    expect(results.map((result) => result.ref)).toEqual([
      "diamond/far.md",
      "diamond/dead-end.md",
      "diamond/left.md",
      "diamond/right.md",
    ])
    expect(results[0]?.path.map((step) => step.to)).toEqual([
      "diamond/left.md",
      "diamond/far.md",
    ])
  })

  it("on: get_related adds the documents of other sources that are closest to the question to layer 1, with no relation", async () => {
    await setFlag("on")
    const call = (args: Record<string, unknown>) =>
      relatedCall({
        workspace: "bridge",
        seeds: ["github/issues/acme/shop/12.md"],
        query: "Why is the cart total wrong after a coupon?",
        ...args,
      })
    const results = structured(await call({})).results as {
      ref: string
      depth: number
      path: unknown[]
    }[]
    // The code document has no relation to the issue: the bridge finds it.
    // The other issue is of the source of the seed, so only a relation can
    // reach it.
    expect(results).toEqual([
      expect.objectContaining({
        ref: "knowledge/services/cart.md",
        depth: 1,
        path: [],
      }),
    ])
    // A walk of named predicates follows only those relations.
    const named = structured(await call({ predicates: ["MENTIONS"] }))
    expect(named.results).toEqual([])
  })

  it("the tools take no validity time, and describe the times of each result (CTX-1710)", async () => {
    const [searchTools, relatedTools] = await Promise.all([
      search.listTools(),
      related.listTools(),
    ])
    const tool = (name: string) =>
      [...searchTools.tools, ...relatedTools.tools].find(
        (item) => item.name === name,
      )
    const inputs = (name: string) =>
      Object.keys(tool(name)?.inputSchema.properties ?? {})
    expect(inputs("search_knowledge")).toContain("updatedAfter")
    expect(inputs("search_knowledge")).not.toContain("validAt")
    expect(inputs("get_related")).not.toContain("validAt")
    expect(inputs("get_related")).not.toContain("validBetween")
    const outputs = (tool("search_knowledge")?.outputSchema?.properties ??
      {}) as Record<
      string,
      { items: { properties: Record<string, { description?: string }> } }
    >
    const hit = outputs.hits?.items.properties
    for (const time of ["createdAt", "updatedAt", "expiresAt"])
      expect(hit?.[time]?.description, time).toEqual(expect.any(String))
  })

  it("get_related tells agents about the claims, with no verdict, in its description and output schema", async () => {
    const { tools } = await related.listTools()
    const tool = tools.find((item) => item.name === "get_related")
    expect(tool?.description).toContain("A claim is evidence, not a verdict")
    expect(tool?.description).not.toMatch(/prefer a current|superseded/i)
    const properties = tool?.outputSchema?.properties as Record<
      string,
      {
        description?: string
        items: { oneOf?: { properties: Record<string, unknown> }[] }
      }
    >
    const claims = properties.claims
    if (!claims) throw new Error("get_related has no claims output")
    expect(claims.description).toBe(
      "The claims between the top results whose later end is on this page.",
    )
    expect(
      claims.items.oneOf?.map(({ properties }) =>
        Object.keys(properties).sort(),
      ),
    ).toEqual([
      [
        "by",
        "confidence",
        "from",
        "predicate",
        "source",
        "to",
        "validFrom",
        "validTo",
      ],
      ["by", "confidence", "from", "predicate", "to"],
    ])
    expect(properties.positions).toBeUndefined()
  })

  it("on: get_related shows a stored relation between two top results as a claim, with its source, times and confidence", async () => {
    await setFlag("on")
    const content = structured(
      await relatedCall({
        workspace: "claims",
        seeds: ["claims/seed.md"],
        maxDepth: 1,
      }),
    )
    expect(
      (content.results as { ref: string; sourceType?: string }[]).map(
        ({ ref, sourceType }) => ({ ref, sourceType }),
      ),
    ).toEqual([
      { ref: "claims/new.md", sourceType: "docs" },
      { ref: "claims/old.md", sourceType: "docs" },
    ])
    // The walk of one layer reads no relation of the plans, so the claims
    // read them. The SUPERSEDES is a claim like each other relation, and
    // the reading of the model comes after it.
    expect(content.claims).toEqual([
      {
        from: "claims/new.md",
        to: "claims/old.md",
        predicate: "SUPERSEDES",
        by: "edge",
        source: "git",
        validFrom: "2026-03-01T00:00:00.000Z",
        validTo: "2100-01-01T00:00:00.000Z",
        confidence: 0.7,
      },
      {
        from: "claims/new.md",
        to: "claims/old.md",
        predicate: "REPLACES",
        by: "reading",
        confidence: 0.9,
      },
    ])
    // With one result for each page, the claims come on the page of their
    // later end: the second page.
    const pageCall = (cursor?: string) =>
      relatedCall({
        workspace: "claims",
        seeds: ["claims/seed.md"],
        maxDepth: 1,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      })
    const firstPage = structured(await pageCall())
    expect(
      (firstPage.results as { ref: string }[]).map(({ ref }) => ref),
    ).toEqual(["claims/new.md"])
    expect(firstPage.claims).toEqual([])
    const secondPage = structured(await pageCall(firstPage.cursor as string))
    expect(
      (secondPage.results as { ref: string }[]).map(({ ref }) => ref),
    ).toEqual(["claims/old.md"])
    expect(secondPage.claims).toEqual(content.claims)
  })

  it("on: get_related shows each stored relation between top results with its validFrom and validTo, and filters none by time (CTX-1710)", async () => {
    await setFlag("on")
    const claims = (
      structured(
        await relatedCall({
          workspace: "claims",
          seeds: ["claims/seed.md"],
          maxDepth: 1,
        }),
      ).claims as {
        predicate: string
        by: string
        validFrom?: string | null
        validTo?: string | null
      }[]
    ).map(({ predicate, by, validFrom, validTo }) =>
      by === "edge" ? { predicate, by, validFrom, validTo } : { predicate, by },
    )
    // The SUPERSEDES holds from March 2026. The agent judges the time.
    expect(claims).toEqual([
      {
        predicate: "SUPERSEDES",
        by: "edge",
        validFrom: "2026-03-01T00:00:00.000Z",
        validTo: "2100-01-01T00:00:00.000Z",
      },
      { predicate: "REPLACES", by: "reading" },
    ])
  })

  it("on: Jev reads the relation that reached each candidate of get_related before its text", async () => {
    await setFlag("on")
    await relatedCall({ maxDepth: 1 })
    const partOf = (title: string) =>
      jevParts.find((part) => String(part).includes(`\n\n${title}`))
    // The seed depends on the ledger, and the payments team owns the seed.
    expect(partOf("Ledger database")).toMatch(
      /^<data>"Checkout service" DEPENDS_ON this document\.\n\nLedger database/,
    )
    expect(partOf("Payments team")).toMatch(
      /^<data>This document OWNS "Checkout service"\.\n\nPayments team/,
    )
    // The disagreement step reads the evidence of the answer, with no
    // relation line.
    expect(factsParts.some((part) => part.includes("Payments team"))).toBe(true)
    expect(factsParts.some((part) => part.includes("OWNS"))).toBe(false)
    // A seed has no relation that reached it.
    expect(
      jevParts.some((part) =>
        String(part).startsWith("<data>Checkout service"),
      ),
    ).toBe(true)
  })

  it("on: get_related with maxDepth 1 does not explore past the first layer", async () => {
    await setFlag("on")
    const content = structured(await relatedCall({ maxDepth: 1 }))
    // Jev marks the ledger to explore, so it is a step (CTX-1534), also
    // when the depth stops the loop before the decision after it.
    expect(
      (content.results as { ref: string }[]).map((result) => result.ref),
    ).toEqual(["knowledge/teams/payments.md", "knowledge/databases/ledger.md"])
    expect(jevRequests).toEqual([{ candidates: 1 }, { candidates: 3 }])
  })

  it("on: get_related judges the seeds and layer 1 at the same time", async () => {
    await setFlag("on")
    // The seeds are the first frontier whatever Jev says, so layer 1 needs
    // no judgment of the seeds: both calls are in flight together.
    jevWaitsForTwo = true
    const content = structured(await relatedCall({ maxDepth: 1 }))
    // The same results as a walk with no overlap (the maxDepth 1 test).
    expect(
      (content.results as { ref: string }[]).map((result) => result.ref),
    ).toEqual(["knowledge/teams/payments.md", "knowledge/databases/ledger.md"])
    // The two calls end in any order.
    expect(jevRequests.map((request) => request.candidates).sort()).toEqual([
      1, 3,
    ])
    expect(jevMostInFlight).toBe(2)
  })

  it("on: get_related asks the disagreement facts with the judge of the last layer", async () => {
    await setFlag("on")
    // A call of the facts after the walk would find no layer judge call.
    factsWaitForLayer = true
    const content = structured(await relatedCall({ maxDepth: 2 }))
    // Before the judge of layer 2, the payments team answers, and the
    // decision is the one document of the judge. Both can be top results,
    // so Jev gets the facts of both in the round of the judge.
    expect(factsWithLayer).toBe(true)
    expect(
      (content.results as { ref: string }[]).map((result) => result.ref),
    ).toEqual([
      "knowledge/teams/payments.md",
      "knowledge/decisions/adr-7.md",
      "knowledge/databases/ledger.md",
    ])
    // The same request, and the same claims, as the walk of three layers
    // that ends after layer 2 and asks the facts after the walk.
    expect(disagreementRequests).toEqual([
      [
        "same.1.2",
        "disagree.1.2",
        "replaces.1.2",
        "replaces.2.1",
        "scoped.1",
        "scoped.2",
      ],
    ])
    // A reading of the model, as a claim with no verdict on a result.
    expect(content.claims).toEqual([
      {
        from: "knowledge/teams/payments.md",
        to: "knowledge/decisions/adr-7.md",
        predicate: "REPLACES",
        by: "reading",
        confidence: 0.9,
      },
    ])
  })

  it("on: get_related asks the disagreement facts after the walk when more documents than the top results can be top results", async () => {
    await setFlag("on")
    const before = ORCHESTRATOR_DEFAULTS.timeBudgetMs
    ORCHESTRATOR_DEFAULTS.timeBudgetMs = 0
    try {
      const content = structured(
        await relatedCall({
          workspace: "wide",
          seeds: ["wide/seed.md"],
          maxDepth: 2,
        }),
      )
      expect(content.partial).toBe(false)
      expect(content.claims).toBeDefined()
    } finally {
      ORCHESTRATOR_DEFAULTS.timeBudgetMs = before
    }
    // Layer 1 gives 49 answers, and layer 2 has more documents: Jev gets
    // the facts of the 10 top results only (45 pairs, 4 calls), after the
    // walk.
    expect(disagreementRequests).toHaveLength(4)
    expect(new Set(disagreementRequests.flat()).size).toBe(4 * 45 + 10)
  }, 15_000)

  it("on: get_related after a search of the same org and text makes no second embedding call", async () => {
    await setFlag("on")
    const query = "who owns checkout, asked two times"
    await searchCall({ workspaces: ["ready"], query })
    expect(planeEmbeddings).toBe(1)
    const content = structured(await relatedCall({ maxDepth: 1, query }))
    expect(
      (content.results as { ref: string }[]).map((result) => result.ref),
    ).toEqual(["knowledge/teams/payments.md", "knowledge/databases/ledger.md"])
    expect(planeEmbeddings).toBe(1)
  })

  it("on: includeSeeds adds a seed that answers; layer 0 judges the seeds either way", async () => {
    await setFlag("on")
    const refs = async (args: Record<string, unknown>) =>
      (
        structured(await relatedCall({ maxDepth: 1, ...args })).results as {
          ref: string
        }[]
      ).map((result) => result.ref)
    // The checkout seed does not answer ("hub" only), so it is no result.
    // The ledger is a step (a hub).
    expect(await refs({ includeSeeds: true })).toEqual([
      "knowledge/teams/payments.md",
      "knowledge/databases/ledger.md",
    ])
    // With the payments seed, its neighbor, the checkout service, is a step
    // (a hub).
    expect(
      await refs({
        seeds: ["knowledge/teams/payments.md"],
        includeSeeds: true,
      }),
    ).toEqual(["knowledge/teams/payments.md", "knowledge/services/checkout.md"])
    // Layer 0 judges the payments seed, and layer 1 judges its neighbor.
    expect(jevRequests.slice(-2)).toEqual([
      { candidates: 1 },
      { candidates: 1 },
    ])
  })

  it("on: get_related explores from each seed, also from a seed with a low p(explore)", async () => {
    await setFlag("on")
    // Jev gives the payments team a low p(explore) ("hub" is not in its
    // text). The caller named it as a seed, so layer 1 reads its relations:
    // it owns the checkout service. The checkout service is a hub, so
    // p(explore) makes it the frontier of layer 2.
    const content = structured(
      await relatedCall({
        seeds: ["knowledge/teams/payments.md"],
        maxDepth: 2,
      }),
    )
    expect(content.explored).toMatchObject({ nodes: 4 })
    expect(jevRequests).toEqual([
      { candidates: 1 },
      { candidates: 1 },
      { candidates: 2 },
    ])
  })

  it("on: search_knowledge filters the sources in the store", async () => {
    await setFlag("on")
    const content = structured(
      await searchCall({ workspaces: ["ready"], sources: ["linear"] }),
    )
    expect(content.hits).toEqual([])
    const authored = structured(
      await searchCall({ workspaces: ["ready"], sources: ["authored"] }),
    )
    expect((authored.hits as unknown[]).length).toBe(units.length)
  })

  it("on: search_knowledge adds the documents that its best hits name, in the last places of the hits", async () => {
    await setFlag("on")
    const mailer = "knowledge/services/mailer.md"
    /** The first page, and the texts of the hits that Jev judged. */
    const call = async (args: Record<string, unknown> = {}) => {
      jevRequests.length = 0
      jevParts.length = 0
      const hits = structured(
        await searchCall({
          workspaces: ["named"],
          query: "Why is the refund email late?",
          ...args,
        }),
      ).hits as { ref: string }[]
      return {
        refs: hits.map((hit) => hit.ref),
        judged: jevRequests.reduce((sum, item) => sum + item.candidates, 0),
        judgedMailer: jevParts.some((part) =>
          String(part).includes("Sends messages"),
        ),
      }
    }
    const before = ORCHESTRATOR_DEFAULTS.searchNeighbors
    ORCHESTRATOR_DEFAULTS.searchNeighbors = 0
    try {
      // With no neighbors, the 50 hits are the issue and 49 notes.
      expect(await call()).toMatchObject({ judged: 50, judgedMailer: false })
    } finally {
      ORCHESTRATOR_DEFAULTS.searchNeighbors = before
    }
    // The issue is a best hit, and it mentions the mailer. The mailer takes
    // the last place of the 50 hits, and Jev judges it with the others: it
    // answers, so it comes first.
    const named = await call()
    expect(named).toMatchObject({ judged: 50, judgedMailer: true })
    expect(named.refs[0]).toBe(mailer)
    // A neighbor must pass the filters of the search.
    const filtered = await call({ kinds: ["Issue", "Note"] })
    expect(filtered).toMatchObject({ judgedMailer: false })
    expect(filtered.refs).not.toContain(mailer)
  })

  it("on: search_knowledge gives the times of each hit, keeps an expired hit in Jev's order, and filters updatedAfter on the source time (CTX-1710)", async () => {
    await setFlag("on")
    const { workspaceId } = await seedRelatedWorkspace({
      seed,
      slug: "history",
      sha: planeSha,
      units: [],
    })
    const key = (path: string) => servingIdForKnowledgePath(workspaceId, path)
    // The projection ran after both changes: its time is no document time.
    const observedAt = new Date("2026-11-25T00:00:00Z")
    // Jev gives the expired document a high p(answers) ("answer"), and the
    // other one a low p(answers).
    const document = (
      path: string,
      text: string,
      times: { createdAt: Date; updatedAt: Date; expiresAt: Date | null },
    ) => ({
      document: {
        docKey: key(path),
        kind: "Note",
        title: path,
        path,
        sourceType: "docs",
        source: "",
        summary: "",
        mime: "",
        ...times,
        observedAt,
      },
      chunks: [
        {
          ordinal: 0,
          text,
          startLine: 1,
          endLine: 1,
          embedding: planeVector(text),
        },
      ],
      relations: [],
    })
    const writer = createKnowledgeStore(knowledgeUrl)
    try {
      await writePlaneDocuments(writer, { orgId: seed.orgId, workspaceId }, [
        document("knowledge/old.md", "Checkout owner. answer", {
          createdAt: new Date("2019-05-01T00:00:00Z"),
          updatedAt: new Date("2019-06-01T00:00:00Z"),
          expiresAt: new Date("2020-01-01T00:00:00Z"),
        }),
        document("knowledge/new.md", "Checkout owner.", {
          createdAt: new Date("2026-03-01T00:00:00Z"),
          updatedAt: new Date("2026-04-01T00:00:00Z"),
          expiresAt: null,
        }),
      ])
    } finally {
      await writer.close()
    }
    await markReady(workspaceId)

    const content = structured(await searchCall({ workspaces: ["history"] }))
    expect(
      (content.hits as Record<string, unknown>[]).map(
        ({ ref, score, createdAt, updatedAt, expiresAt }) => ({
          ref,
          score,
          createdAt,
          updatedAt,
          expiresAt,
        }),
      ),
    ).toEqual([
      {
        ref: "knowledge/old.md",
        score: 0.9,
        createdAt: "2019-05-01T00:00:00.000Z",
        updatedAt: "2019-06-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
      {
        ref: "knowledge/new.md",
        score: 0.1,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
        expiresAt: undefined,
      },
    ])
    const changed = structured(
      await searchCall({
        workspaces: ["history"],
        updatedAfter: "2026-01-01T00:00:00Z",
      }),
    )
    expect((changed.hits as { ref: string }[]).map(({ ref }) => ref)).toEqual([
      "knowledge/new.md",
    ])
  })

  it("on: when the time budget ends before the search ends, search_knowledge has no hits and says total_timeout", async () => {
    await setFlag("on")
    slowEmbedding = true
    // A text of its own: the plane keeps the vector of a text it embedded.
    const result = await searchCall({
      workspaces: ["ready"],
      query: "who owns checkout, with a slow embedding",
    })
    expect(result.isError).toBeFalsy()
    expect(structured(result)).toMatchObject({
      hits: [],
      partial: true,
      partialReason: "total_timeout",
    })
    expect(jevRequests).toEqual([])
  }, 15_000)

  it("on: when the query embedding gets a 429, search_knowledge has no hits and says total_timeout at once, with no retry", async () => {
    await setFlag("on")
    embeddingFailure = 429
    const result = await searchCall({
      workspaces: ["ready"],
      query: "who owns checkout, with a 429",
    })
    expect(result.isError).toBeFalsy()
    expect(structured(result)).toMatchObject({
      hits: [],
      partial: true,
      partialReason: "total_timeout",
    })
    // One request and no retry. A backoff wait would end in the budget.
    expect(planeEmbeddings).toBe(1)
    expect(jevRequests).toEqual([])
  })

  it("on: when the query embedding gets a 503, get_related returns partial with no retry", async () => {
    await setFlag("on")
    embeddingFailure = 503
    const content = structured(
      await relatedCall({ maxDepth: 3, query: "what is near checkout, 503" }),
    )
    expect(content).toMatchObject({
      results: [],
      partial: true,
      partialReason: "total_timeout",
    })
    expect(planeEmbeddings).toBe(1)
    expect(jevRequests).toEqual([])
  })

  it("on: when the time budget ends in the judge, search_knowledge gives the search order and says total_timeout", async () => {
    await setFlag("on")
    slowJevCall = 1
    const content = structured(await searchCall({ workspaces: ["ready"] }))
    expect(content).toMatchObject({
      partial: true,
      partialReason: "total_timeout",
    })
    expect((content.hits as unknown[]).length).toBe(units.length)
  }, 15_000)

  it("on: when the time budget ends in a layer, get_related returns the judged layers as partial", async () => {
    await setFlag("on")
    // Call 1 judges the seed, call 2 layer 1, call 3 layer 2.
    slowJevCall = 3
    const content = structured(await relatedCall({ maxDepth: 3 }))
    expect(content).toMatchObject({
      partial: true,
      partialReason: "total_timeout",
    })
    // The judged layers: the answer and the hub of layer 1, a step.
    expect(
      (content.results as { ref: string }[]).map((result) => result.ref),
    ).toEqual(["knowledge/teams/payments.md", "knowledge/databases/ledger.md"])
    expect(content.claims).toBeUndefined()
  }, 15_000)

  it("on: with no time budget (0, the evals), get_related waits for a slow Jev call and returns the full ranking", async () => {
    await setFlag("on")
    // Call 3 judges layer 2 and answers after 5 s, more than the 3 s budget
    // of these tests.
    slowJevCall = 3
    const before = ORCHESTRATOR_DEFAULTS.timeBudgetMs
    ORCHESTRATOR_DEFAULTS.timeBudgetMs = 0
    try {
      const content = structured(await relatedCall({ maxDepth: 3 }))
      expect(content.partial).toBe(false)
      expect(
        (content.results as { ref: string }[]).map((result) => result.ref),
      ).toEqual([
        "knowledge/teams/payments.md",
        "knowledge/decisions/adr-7.md",
        "knowledge/databases/ledger.md",
      ])
      // The ledger is a step, not an answer, so no claim names it.
      expect(
        (content.claims as { from: string; to: string }[]).flatMap(
          ({ from, to }) => [from, to],
        ),
      ).not.toContain("knowledge/databases/ledger.md")
    } finally {
      ORCHESTRATOR_DEFAULTS.timeBudgetMs = before
    }
  }, 15_000)

  it("on: when the time budget ends in the disagreement step, get_related has the results and no claims", async () => {
    await setFlag("on")
    // Calls 1 to 3 are the layers, call 4 the pairs.
    slowJevCall = 4
    const content = structured(await relatedCall({ maxDepth: 3 }))
    expect(content).toMatchObject({
      partial: true,
      partialReason: "total_timeout",
    })
    // The two results that answer, and the ledger, the step to the decision.
    expect((content.results as unknown[]).length).toBe(3)
    expect(content.claims).toBeUndefined()
  }, 15_000)

  it("on: when Jev fails in the disagreement step, get_related fails with judge_unavailable", async () => {
    await setFlag("on")
    jevFails = "disagreement"
    const result = await relatedCall({ maxDepth: 3 })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("judge_unavailable")
    expect(jevRequests.length).toBe(3)
  })

  it("on: an unknown seed gives unknown_ref", async () => {
    await setFlag("on")
    const result = await relatedCall({ seeds: ["knowledge/missing.md"] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain("unknown_ref")
  })

  it("on: when Jev fails, search_knowledge gives the search order with a flag", async () => {
    await setFlag("on")
    jevFails = "all"
    const result = await searchCall({ workspaces: ["ready"] })
    expect(result.isError).toBeFalsy()
    const content = structured(result)
    expect(content).toMatchObject({
      partial: true,
      partialReason: "judge_unavailable",
    })
    expect((content.hits as unknown[]).length).toBeGreaterThan(0)
  })

  it("on: when Jev fails, get_related fails with judge_unavailable", async () => {
    await setFlag("on")
    jevFails = "all"
    const result = await relatedCall({ maxDepth: 2 })
    expect(result.isError).toBe(true)
    const text = JSON.stringify(result.content)
    expect(text).toContain("judge_unavailable")
    expect(text).toContain("The relevance judge did not answer")
  })

  it("a cursor of one stack fails on the other stack with a clear error", async () => {
    await setFlag("on")
    const args = { workspaces: ["paging"], limit: 1 }
    const plane = structured(await searchCall(args))
    expect(plane.cursor).toEqual(expect.any(String))
    await markNotReady(ids.paging as string)
    try {
      const refused = await searchCall({ ...args, cursor: plane.cursor })
      expect(refused.isError).toBe(true)
      const text = JSON.stringify(refused.content)
      expect(text).toContain("stale_cursor")
      expect(text).toContain("other knowledge stack")
      // And back: a cursor of the old stack fails on the plane.
      const legacy = structured(await searchCall(args))
      expect(legacy.cursor).toEqual(expect.any(String))
      await markReady(ids.paging as string)
      const back = await searchCall({ ...args, cursor: legacy.cursor })
      expect(back.isError).toBe(true)
      expect(JSON.stringify(back.content)).toContain("other knowledge stack")
      // A cursor of the same stack still pages.
      const next = await searchCall({ ...args, cursor: plane.cursor })
      expect(next.isError).toBeFalsy()
    } finally {
      await markReady(ids.paging as string)
    }
  })

  it("shadow: the old stack answers, and one event compares the plane with ids, scores and counts only", async () => {
    await setFlag("off")
    const query = "who owns checkout in the shadow"
    const off = structured(await searchCall({ workspaces: ["ready"], query }))
    await setFlag("shadow")
    const answered = structured(
      await searchCall({ workspaces: ["ready"], query }),
    )
    expect(answered).toEqual(off)
    const event = (await shadowEvent()) as ShadowEvent & {
      legacy: { ids: string[] }
      plane: { ids: string[] }
    }
    const key = (path: string) =>
      servingIdForKnowledgePath(ids.ready as string, path)
    expect(event).toMatchObject({
      tool: "search_knowledge",
      orgId: seed.orgId,
      workspaceIds: [ids.ready],
      k: expect.any(Number),
      overlapAtK: expect.any(Number),
      legacy: { latencyMs: expect.any(Number) },
      plane: {
        latencyMs: expect.any(Number),
        jevCalls: 1,
        jevCandidates: expect.any(Number),
        embeddingCalls: 1,
      },
    })
    expect(event.plane.ids.slice(0, 2).sort()).toEqual(
      [
        key("knowledge/decisions/adr-7.md"),
        key("knowledge/teams/payments.md"),
      ].sort(),
    )
    expect(new Set(event.legacy.ids)).toEqual(new Set(event.plane.ids))
    expect(event.overlapAtK).toBe(1)
    // No query, path, title or chunk text.
    const serialized = JSON.stringify(event)
    for (const text of [
      "who owns checkout",
      "knowledge/",
      ...units.flatMap((unit) => [unit.title ?? "", unit.text]),
    ])
      expect(serialized).not.toContain(text)
  })

  it("shadow: get_related logs the comparison of the two rankings", async () => {
    await setFlag("shadow")
    const result = await relatedCall({
      maxDepth: 2,
      query: "what is near checkout in the shadow",
    })
    expect(result.isError).toBeFalsy()
    const event = await shadowEvent()
    expect(event).toMatchObject({
      tool: "get_related",
      // Layer 0, two layers, and one call for the disagreement facts.
      plane: { jevCalls: 4, embeddingCalls: 1 },
    })
    expect(JSON.stringify(event)).not.toContain("knowledge/")
  })

  it("shadow: a failed query embedding gives the kind embedding and the HTTP status, on the event and on a span of the request trace", async () => {
    await setFlag("shadow")
    embeddingFailure = 400
    spans.reset()
    const result = await searchCall({
      workspaces: ["ready"],
      query: "who owns checkout when the embedding fails",
    })
    expect(result.isError).toBeFalsy()
    const event = await shadowEvent()
    expect(event).toMatchObject({
      plane: { failure: "embedding", failureCode: "400" },
    })
    const span = spans.spanNamed("knowledge_plane.shadow")
    expect(span?.attributes).toMatchObject({
      "error.type": "embedding",
      "ctxpipe.knowledge_plane.failure_code": "400",
    })
    expect(span?.status).toEqual({ code: 2, message: "embedding" })
    const tool = spans.spanNamed("mcp.tool search_knowledge")
    expect(span?.spanContext().traceId).toBe(tool?.spanContext().traceId)
    expect(span?.events.map((item) => item.attributes)).toEqual([
      { "exception.type": "embedding" },
    ])
  })

  it("shadow: a ClickHouse error gives the kind clickhouse and the ClickHouse error code", async () => {
    await setFlag("shadow")
    // The reader user loses its grant on the relations: the read of the
    // claims of the hits fails on the server.
    const admin = clickHouse.client(knowledgeUrl)
    await admin.command({
      query: "REVOKE SELECT ON relations FROM ctxpipe_reader",
    })
    try {
      const result = await searchCall({
        workspaces: ["ready"],
        query: "who owns checkout when ClickHouse fails",
      })
      expect(result.isError).toBeFalsy()
      await shadowEvent()
    } finally {
      await migrateKnowledgeStore(knowledgeUrl, {
        reader: "reader-test",
        writer: "writer-test",
      })
    }
    expect(await shadowEvent()).toMatchObject({
      // ACCESS_DENIED
      plane: { failure: "clickhouse", failureCode: "497" },
    })
  })

  it.each([
    [
      "a 503 of the query embedding",
      () => {
        embeddingFailure = 503
      },
      "total_timeout",
      { kind: "embedding", code: "503" },
    ],
    [
      "a failed Jev call of search_knowledge",
      () => {
        jevFails = "all"
      },
      "judge_unavailable",
      { kind: "jev", code: "http_503" },
    ],
    [
      "the end of the time budget",
      () => {
        slowEmbedding = true
      },
      "total_timeout",
      { kind: "timeout" },
    ],
  ] as const)(
    "shadow: a partial answer after %s gives the source of its cause",
    async (cause, fault, partialReason, partialCause) => {
      await setFlag("shadow")
      fault()
      const result = await searchCall({
        workspaces: ["ready"],
        // A query of its own: a kept query vector needs no embedding.
        query: `who owns checkout after ${cause}`,
      })
      expect(result.isError).toBeFalsy()
      const { plane } = await shadowEvent()
      expect(plane).toMatchObject({ partialReason, partialCause })
      expect(plane.failure).toBeUndefined()
      // A partial answer is not an error: the span names the cause.
      const span = spans.spanNamed("knowledge_plane.shadow")
      expect(span?.status.code).toBe(0)
      expect(span?.attributes).toMatchObject({
        "ctxpipe.knowledge_plane.partial_cause": partialCause.kind,
      })
    },
    15_000,
  )

  it("shadow: a failed Jev call of get_related gives the kind jev and its HTTP status", async () => {
    await setFlag("shadow")
    jevFails = "all"
    const result = await relatedCall({
      maxDepth: 1,
      query: "what is near checkout when Jev fails",
    })
    expect(result.isError).toBeFalsy()
    expect(await shadowEvent()).toMatchObject({
      plane: { failure: "jev", failureCode: "http_503" },
    })
  })

  it("on: the graph view and the chat walk read the plane", async () => {
    await setFlag("on")
    const { reader, planeHeads } = await selectKnowledgeReader(seed.orgId, [
      ids.ready as string,
    ])
    expect(reader.stack).toBe("plane")
    expect(planeHeads.get(ids.ready as string)?.sha).toBe(planeSha)
    const key = (path: string) =>
      servingIdForKnowledgePath(ids.ready as string, path)
    const graph = await reader.graph({
      orgId: seed.orgId,
      orgSlug: seed.orgSlug,
      workspaceId: ids.ready as string,
      projection: null,
    })
    expect(graph.metrics).toMatchObject({ totalNodes: 5, totalEdges: 4 })
    expect(graph.nodes.map((node) => node.path).sort()).toEqual(
      units.map((unit) => unit.path).sort(),
    )
    const walk = await reader.expand({
      orgId: seed.orgId,
      orgSlug: seed.orgSlug,
      workspaceId: ids.ready as string,
      projection: { kind: "legacy", url: null, sha: legacySha },
      params: { seeds: [key("knowledge/databases/ledger.md")], maxDepth: 1 },
    })
    expect(walk.nodes.map((node) => node.path).sort()).toEqual([
      "knowledge/databases/ledger.md",
      "knowledge/decisions/adr-7.md",
      "knowledge/services/checkout.md",
    ])
    expect(walk.edges.map((edge) => edge.predicate).sort()).toEqual([
      "DEPENDS_ON",
      "GOVERNED_BY",
    ])
  })

  it("on: Jev gets an image candidate as its text", async () => {
    await setFlag("on")
    const doc = "knowledge/flows.md"
    const flow = "knowledge/img/flow.png"
    const { workspaceId } = await seedRelatedWorkspace({
      seed,
      slug: "pictures",
      sha: planeSha,
      units: [{ path: doc, kind: "Note", title: "Flows" }],
    })
    const key = (path: string) => servingIdForKnowledgePath(workspaceId, path)
    const observedAt = new Date("2026-11-01T00:00:00Z")
    const imageDocument = (path: string): PlaneDocument => ({
      document: {
        docKey: key(path),
        kind: "image",
        title: path.split("/").at(-1) ?? path,
        path,
        sourceType: "docs",
        source: "",
        summary: "",
        mime: "image/png",
        createdAt: null,
        updatedAt: null,
        expiresAt: null,
        observedAt,
      },
      chunks: [
        {
          ordinal: 0,
          text: "",
          startLine: 0,
          endLine: 0,
          embedding: planeVector(path),
        },
      ],
      relations: [],
    })
    const embeds = (path: string, altText: string) => ({
      srcChunk: 0,
      predicate: "EMBEDS_IMAGE",
      dstDoc: key(path),
      confidence: 1,
      validFrom: null,
      validTo: null,
      source: "git",
      altText,
      observedAt,
    })
    const writer = createKnowledgeStore(knowledgeUrl)
    try {
      await writePlaneDocuments(writer, { orgId: seed.orgId, workspaceId }, [
        {
          document: {
            ...imageDocument(doc).document,
            kind: "Note",
            title: "Flows",
            mime: "",
          },
          chunks: [
            {
              ordinal: 0,
              text: "The flows. hub",
              startLine: 1,
              endLine: 3,
              embedding: planeVector("The flows. hub"),
            },
          ],
          relations: [embeds(flow, "The flow")],
        },
        imageDocument(flow),
      ])
    } finally {
      await writer.close()
    }
    await markReady(workspaceId)

    const result = await relatedCall({
      workspace: "pictures",
      seeds: [doc],
      maxDepth: 1,
    })
    expect(result.isError).toBeFalsy()
    expect(jevParts.every((part) => typeof part === "string")).toBe(true)
    expect(jevParts).toContain(
      `<data>"Flows" EMBEDS_IMAGE this document.\n\nflow.png\n\n[image] ${flow}</data>`,
    )
  })
})
