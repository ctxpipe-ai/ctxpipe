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
/** Answer this Jev call (from 1) after the 3-second budget, or none. */
let slowJevCall: number | null = null
let jevCalls = 0
/**
 * The test that a Jev call started in. A slow call ends after its test, so
 * it records nothing in the counters of a later test.
 */
let jevTest = 0
/** Answer the embedding of the plane after the 3-second budget. */
let slowEmbedding = false
/** Answer the embedding of the plane with this HTTP status, or none. */
let embeddingFailure: number | null = null
/** The embedding requests of the plane. */
let planeEmbeddings = 0

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
    async ({ request }) => {
      const body = (await request.json()) as {
        state: unknown[]
        questions: Record<string, unknown>
      }
      jevCalls += 1
      const startedIn = jevTest
      if (jevCalls === slowJevCall) await delay(5_000)
      if (startedIn !== jevTest)
        return HttpResponse.json({ error: "test ended" }, { status: 503 })
      const keys = Object.keys(body.questions)
      const disagreement = !keys.some((key) => /^(answers|explore)\./.test(key))
      if (jevFails === "all" || (jevFails === "disagreement" && disagreement))
        return HttpResponse.json({ error: "down" }, { status: 503 })
      if (disagreement) {
        disagreementRequests.push(keys)
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
    },
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
const wide = (prefix: string, index: number) =>
  `wide/${prefix}-${String(index + 1).padStart(2, "0")}.md`
const layer = (prefix: string) =>
  Array.from({ length: 49 }, (_, index) => wide(prefix, index))
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
      ...layer("a").map((to) => ({
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
    layer(prefix).map((path, index) => ({
      path,
      kind: "Note",
      title: `Wide ${prefix} ${index + 1}`,
      text: prefix === "c" ? "answer" : "answer hub",
      claims:
        prefix === "c"
          ? []
          : [
              {
                to: wide(prefix === "a" ? "b" : "c", index),
                predicate: "MENTIONS",
                confidence: 0.8,
              },
            ],
    })),
  ),
]

/** The rows of `list` in the knowledge plane for one Workspace. */
function planeRows(
  workspaceId: string,
  list: readonly (RelatedUnit & { text: string })[] = units,
): PlaneDocument[] {
  const key = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  const observedAt = new Date("2026-11-01T00:00:00Z")
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
      validFrom: null,
      validTo: null,
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
      validTo: null,
      source: "",
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
    validFrom: null,
    validTo: null,
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
function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(shapeOf)
    const merged: Record<string, unknown> = {}
    for (const item of items)
      if (item && typeof item === "object") Object.assign(merged, item)
    if (items.length === 0) return []
    return [typeof value[0] === "object" ? merged : items[0]]
  }
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "cursor")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shapeOf(item)]),
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
    // The wide Workspace is only on the plane.
    const wide = await seedRelatedWorkspace({
      seed,
      slug: "wide",
      sha: legacySha,
      units: [],
    })
    ids.wide = wide.workspaceId
    const wideWriter = createKnowledgeStore(url)
    try {
      await writePlaneDocuments(
        wideWriter,
        { orgId: seed.orgId, workspaceId: wide.workspaceId },
        planeRows(wide.workspaceId, wideUnits),
      )
    } finally {
      await wideWriter.close()
    }
    await markReady(ids.ready as string)
    await markReady(ids.paging as string)
    await markReady(ids.wide as string)
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
    jevTest += 1
    jevFails = false
    slowJevCall = null
    slowEmbedding = false
    embeddingFailure = null
    planeEmbeddings = 0
    jevCalls = 0
    jevRequests.length = 0
    jevParts.length = 0
    disagreementRequests.length = 0
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

  it("on: the output of both tools has the shape of the old stack", async () => {
    await setFlag("off")
    const legacySearch = structured(await searchCall({ workspaces: ["ready"] }))
    const legacyRelated = structured(await relatedCall({ maxDepth: 2 }))
    await setFlag("on")
    const planeSearch = structured(await searchCall({ workspaces: ["ready"] }))
    const planeRelated = structured(await relatedCall({ maxDepth: 2 }))
    expect(shapeOf(planeSearch)).toEqual(shapeOf(legacySearch))
    // Only the plane gives the disagreement positions.
    const { positions, ...rankedOnly } = planeRelated
    expect(positions).toEqual(expect.any(Array))
    expect(shapeOf(rankedOnly)).toEqual(shapeOf(legacyRelated))
    expect(legacyRelated.positions).toBeUndefined()
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
    // each item. Code gives the status.
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
    expect(content.positions).toEqual([
      {
        refs: ["knowledge/teams/payments.md"],
        status: "current",
        reason: { by: "tie-break", rule: "updates" },
        against: [{ position: 1, label: "updates" }],
      },
      {
        refs: ["knowledge/decisions/adr-7.md"],
        status: "superseded",
        reason: { by: "tie-break", rule: "updates" },
        against: [{ position: 0, label: "updates" }],
      },
    ])
  })

  it("on: get_related keeps the step of each kept answer when the answers pass the result limit", async () => {
    await setFlag("on")
    const refs: string[] = []
    let cursor: string | undefined
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
      refs.push(...(content.results as { ref: string }[]).map((r) => r.ref))
      cursor = content.cursor as string | undefined
    } while (cursor)
    // 148 documents answer. The 100 results are the best answers, each with
    // its steps: the 49 answers of layer 1, the far answer and its step (the
    // middle document), and the 49 other answers of layer 2. The answers of
    // layer 3 do not fit with their steps.
    expect(refs).toHaveLength(100)
    expect(refs.at(-1)).toBe("wide/middle.md")
    expect(refs).toContain("wide/b-00.md")
    expect(refs.filter((ref) => ref.startsWith("wide/c-"))).toEqual([])
  })

  it("get_related tells agents about the positions in its description and output schema", async () => {
    const { tools } = await related.listTools()
    const tool = tools.find((item) => item.name === "get_related")
    expect(tool?.description).toContain(
      "status (current, superseded, disputed, scoped)",
    )
    const properties = tool?.outputSchema?.properties as Record<
      string,
      { description?: string; items: { properties: Record<string, unknown> } }
    >
    const positions = properties.positions
    if (!positions) throw new Error("get_related has no positions output")
    expect(positions.description).toBe(
      "The disagreement positions of the top results.",
    )
    expect(positions.items.properties.status).toMatchObject({
      enum: ["current", "superseded", "disputed", "scoped"],
      description: expect.stringContaining("superseded: replaced"),
    })
    expect(Object.keys(positions.items.properties).sort()).toEqual([
      "against",
      "reason",
      "refs",
      "status",
    ])
  })

  it("on: get_related with maxDepth 1 does not explore past the first layer", async () => {
    await setFlag("on")
    const content = structured(await relatedCall({ maxDepth: 1 }))
    expect(
      (content.results as { ref: string }[]).map((result) => result.ref),
    ).toEqual(["knowledge/teams/payments.md"])
    expect(jevRequests).toEqual([{ candidates: 1 }, { candidates: 3 }])
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
    expect(await refs({ includeSeeds: true })).toEqual([
      "knowledge/teams/payments.md",
    ])
    expect(
      await refs({
        seeds: ["knowledge/teams/payments.md"],
        includeSeeds: true,
      }),
    ).toEqual(["knowledge/teams/payments.md"])
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

  it("on: validBetween follows only relations valid in the window", async () => {
    await setFlag("on")
    const refs = async (validBetween: { from: string; to: string }) =>
      (
        structured(await relatedCall({ maxDepth: 3, validBetween }))
          .results as {
          ref: string
        }[]
      ).map((result) => result.ref)
    // GOVERNED_BY is valid from 2026-01-01.
    expect(
      await refs({ from: "2025-01-01T00:00:00Z", to: "2025-06-01T00:00:00Z" }),
    ).toEqual(["knowledge/teams/payments.md"])
    expect(
      await refs({ from: "2026-02-01T00:00:00Z", to: "2026-03-01T00:00:00Z" }),
    ).toEqual([
      "knowledge/teams/payments.md",
      "knowledge/decisions/adr-7.md",
      "knowledge/databases/ledger.md",
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

  it("on: search_knowledge puts a hit that is not valid now after the valid hits, through code", async () => {
    await setFlag("on")
    const { workspaceId } = await seedRelatedWorkspace({
      seed,
      slug: "history",
      sha: planeSha,
      units: [],
    })
    const key = (path: string) => servingIdForKnowledgePath(workspaceId, path)
    const observedAt = new Date("2026-11-01T00:00:00Z")
    // Jev gives the expired document a high p(answers) ("answer"), and the
    // valid one a low p(answers).
    const document = (path: string, text: string, validTo: Date | null) => ({
      document: {
        docKey: key(path),
        kind: "Note",
        title: path,
        path,
        sourceType: "docs",
        source: "",
        summary: "",
        mime: "",
        validFrom: null,
        validTo,
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
        document(
          "knowledge/old.md",
          "Checkout owner. answer",
          new Date("2020-01-01T00:00:00Z"),
        ),
        document("knowledge/new.md", "Checkout owner.", null),
      ])
    } finally {
      await writer.close()
    }
    await markReady(workspaceId)

    const content = structured(await searchCall({ workspaces: ["history"] }))
    expect(
      (content.hits as { ref: string; score: number }[]).map(
        ({ ref, score }) => [ref, score],
      ),
    ).toEqual([
      ["knowledge/new.md", 0.1],
      ["knowledge/old.md", 0.9],
    ])
  })

  it("on: when the time budget ends before the search ends, search_knowledge has no hits and says total_timeout", async () => {
    await setFlag("on")
    slowEmbedding = true
    const result = await searchCall({ workspaces: ["ready"] })
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
    const result = await searchCall({ workspaces: ["ready"] })
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
    const content = structured(await relatedCall({ maxDepth: 3 }))
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
    expect(
      (content.results as { ref: string }[]).map((result) => result.ref),
    ).toEqual(["knowledge/teams/payments.md"])
    expect(content.positions).toBeUndefined()
  }, 15_000)

  it("on: with no time budget (0, the evals), get_related waits for a slow Jev call and returns the full ranking", async () => {
    await setFlag("on")
    // Call 3 judges layer 2 and answers after 5 s, more than the 3 s budget
    // of the product.
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
      // The ledger is a step, not an answer, so no position holds it.
      expect(content.positions).toHaveLength(2)
    } finally {
      ORCHESTRATOR_DEFAULTS.timeBudgetMs = before
    }
  }, 15_000)

  it("on: when the time budget ends in the disagreement step, get_related has the results and no positions", async () => {
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
    expect(content.positions).toBeUndefined()
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
    const off = structured(await searchCall({ workspaces: ["ready"] }))
    await setFlag("shadow")
    const answered = structured(await searchCall({ workspaces: ["ready"] }))
    expect(answered).toEqual(off)
    await vi.waitFor(
      () => {
        expect(
          events.filter((event) => event.step === "knowledge_plane.shadow"),
        ).toHaveLength(1)
      },
      { timeout: 10_000 },
    )
    const event = events.find(
      (item) => item.step === "knowledge_plane.shadow",
    ) as Record<string, unknown> & {
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
    const result = await relatedCall({ maxDepth: 2 })
    expect(result.isError).toBeFalsy()
    await vi.waitFor(
      () => {
        expect(
          events.filter((event) => event.step === "knowledge_plane.shadow"),
        ).toHaveLength(1)
      },
      { timeout: 10_000 },
    )
    const event = events.find((item) => item.step === "knowledge_plane.shadow")
    expect(event).toMatchObject({
      tool: "get_related",
      // Layer 0, two layers, and one call for the disagreement facts.
      plane: { jevCalls: 4, embeddingCalls: 1 },
    })
    expect(JSON.stringify(event)).not.toContain("knowledge/")
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
        validFrom: null,
        validTo: null,
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
    expect(jevParts).toContain(`<data>flow.png\n\n[image] ${flow}</data>`)
  })
})
