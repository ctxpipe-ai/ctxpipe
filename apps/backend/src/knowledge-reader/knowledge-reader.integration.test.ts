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
import { withOrgDbContext } from "../db/client.js"
import { knowledgeState } from "../db/schema/knowledge_state.js"
import { orgFeatures } from "../db/schema/org_features.js"
import { repositories } from "../db/schema/repositories.js"
import { repositoryCheckouts } from "../db/schema/repository_checkouts.js"
import { workspaceKnowledgeUnits, workspaces } from "../db/schema/workspaces.js"
import { servingIdForKnowledgePath } from "../domain/workspaces/hydrate.js"
import {
  createKnowledgeStore,
  type DocumentRows,
} from "../knowledge-store/knowledge-store.js"
import { migrateKnowledgeStore } from "../knowledge-store/migrate.js"
import { generateObjectId } from "../lib/id.js"
import { getRelatedTool } from "../mcp/tools/get-related.js"
import { searchKnowledgeTool } from "../mcp/tools/search-knowledge.js"
import {
  beginKnowledgeRun,
  completeKnowledgeRun,
} from "../models/knowledge-state.js"
import { startClickHouse, userUrl } from "../test/clickhouse.js"
import { embedText } from "../test/knowledge-search-fixture.js"
import {
  callTool,
  connectToolClient,
  dropOrgGraph,
  type RelatedUnit,
  seedRelatedWorkspace,
} from "../test/related-fixture.js"
import { selectKnowledgeReader } from "./knowledge-reader.js"

/*
 * The knowledge reader seam behind the org flag (ADR-069 decision 9), through
 * the MCP tools: real Postgres, FalkorDB and ClickHouse; msw for Jev and the
 * embedding endpoint.
 */

const MODEL_URL = "https://search-model.test/v1"
const legacySha = "a".repeat(40)
const planeSha = "b".repeat(40)

/**
 * Jev answers from markers in the candidate text: "answer" gives a high
 * p(answers), "hub" a high p(explore). In the disagreement step, each pair
 * of items "updates", Position 1 is current and the others are superseded.
 */
const jevRequests: { candidates: number }[] = []
/** The data URL of each image part that Jev got. */
const jevImages: string[] = []
/** The text of each candidate that Jev got. */
const jevTexts: string[] = []
const disagreementRequests: string[][] = []
/** Fail every Jev call, or only the calls of the disagreement step. */
let jevFails: false | "all" | "disagreement" = false
/** Answer this Jev call (from 1) after the 3-second budget, or none. */
let slowJevCall: number | null = null
let jevCalls = 0
/** Answer the embedding of the plane after the 3-second budget. */
let slowEmbedding = false

/** The vector of a text on both stacks: the old stack has 2000 dimensions. */
const planeVector = (text: string) => embedText(text).slice(0, 1024)

const models = setupServer(
  http.post(`${MODEL_URL}/embeddings`, async ({ request }) => {
    const body = (await request.json()) as {
      input: (string | { content: { text?: string }[] })[]
    }
    const texts = body.input.map((input) =>
      typeof input === "string" ? input : (input.content[0]?.text ?? ""),
    )
    if (slowEmbedding && typeof body.input[0] !== "string") await delay(5_000)
    return HttpResponse.json({
      data: body.input.map((input, index) => ({
        index,
        embedding:
          typeof input === "string"
            ? embedText(input)
            : planeVector(texts[index] ?? ""),
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
      if (jevCalls === slowJevCall) await delay(5_000)
      const keys = Object.keys(body.questions)
      const disagreement = keys.every(
        (key) => key.startsWith("pair.") || key.startsWith("status."),
      )
      if (jevFails === "all" || (jevFails === "disagreement" && disagreement))
        return HttpResponse.json({ error: "down" }, { status: 503 })
      if (disagreement) {
        disagreementRequests.push(keys)
        const spread = (options: string[], top: string) =>
          Object.fromEntries(
            options.map((option) => [option, option === top ? 0.8 : 0.05]),
          )
        return HttpResponse.json({
          answers: Object.fromEntries(
            keys.map((key) => [
              key,
              {
                type: "choice",
                probabilities: key.startsWith("pair.")
                  ? spread(
                      [
                        "agrees",
                        "contradicts",
                        "partial",
                        "updates",
                        "unrelated",
                      ],
                      "updates",
                    )
                  : spread(
                      ["current", "superseded", "disputed", "scoped"],
                      key === "status.1" ? "current" : "superseded",
                    ),
              },
            ]),
          ),
        })
      }
      const answers: Record<string, { type: "noul"; noul: number }> = {}
      body.state.forEach((part, index) => {
        const n =
          typeof part === "string" && /^Candidate (\d+) \(/.exec(part)?.[1]
        if (!n) return
        const content = body.state[index + 1] as
          | string
          | { type: "image_url"; image_url: { url: string } }
        // The stub scores each image part as an answer.
        if (typeof content !== "string") jevImages.push(content.image_url.url)
        else jevTexts.push(content)
        const text = typeof content === "string" ? content : "answer"
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

/** The rows of `units` in the knowledge plane for one Workspace. */
function planeRows(workspaceId: string): DocumentRows[] {
  const key = (path: string) => servingIdForKnowledgePath(workspaceId, path)
  const observedAt = new Date("2026-11-01T00:00:00Z")
  return units.map((unit) => ({
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
  await beginKnowledgeRun({ orgId: seed.orgId, workspaceId, tip: planeSha })
  await completeKnowledgeRun({
    orgId: seed.orgId,
    workspaceId,
    tip: planeSha,
    projectionVersion: "test",
    failedCount: 0,
  })
}

async function markNotReady(workspaceId: string) {
  await withOrgDbContext(seed.orgId, (db) =>
    db
      .delete(knowledgeState)
      .where(
        and(
          eq(knowledgeState.organizationId, seed.orgId),
          eq(knowledgeState.workspaceId, workspaceId),
        ),
      ),
  )
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
        await writer.replaceDocuments(
          { orgId: seed.orgId, workspaceId },
          planeRows(workspaceId),
        )
      }
    } finally {
      await writer.close()
    }
    await markReady(ids.ready as string)
    await markReady(ids.paging as string)
    // A first run that has not ended: not ready.
    await beginKnowledgeRun({
      orgId: seed.orgId,
      workspaceId: ids.fresh as string,
      tip: planeSha,
    })
    search = await connectToolClient(seed, searchKnowledgeTool)
    related = await connectToolClient(seed, getRelatedTool)
  }, 240_000)

  beforeEach(() => {
    jevFails = false
    slowJevCall = null
    slowEmbedding = false
    jevCalls = 0
    jevRequests.length = 0
    jevImages.length = 0
    jevTexts.length = 0
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

  it("on: get_related keeps what answers, explores the hubs, and gives the why path", async () => {
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
    ])
    // Layer 0 judges the seed; layer 1 the three neighbors; layer 2 the one
    // neighbor of the hub.
    expect(jevRequests).toEqual([
      { candidates: 1 },
      { candidates: 3 },
      { candidates: 1 },
    ])
    // The disagreement step: one pair, then the status of each position.
    expect(disagreementRequests).toEqual([
      ["pair.1.2"],
      ["status.1", "status.2"],
    ])
    expect(content.positions).toEqual([
      {
        refs: ["knowledge/teams/payments.md"],
        status: "current",
        reason: { by: "jev", probability: 0.8 },
        against: [{ position: 1, label: "updates" }],
      },
      {
        refs: ["knowledge/decisions/adr-7.md"],
        status: "superseded",
        reason: { by: "jev", probability: 0.8 },
        against: [{ position: 0, label: "updates" }],
      },
    ])
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
    // Jev does not explore from the payments team, so no layer runs.
    expect(jevRequests.slice(-1)).toEqual([{ candidates: 1 }])
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
    ).toEqual(["knowledge/teams/payments.md", "knowledge/decisions/adr-7.md"])
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

  it("on: when the time budget ends in the disagreement step, get_related has the results and no positions", async () => {
    await setFlag("on")
    // Calls 1 to 3 are the layers, call 4 the pairs.
    slowJevCall = 4
    const content = structured(await relatedCall({ maxDepth: 3 }))
    expect(content).toMatchObject({
      partial: true,
      partialReason: "total_timeout",
    })
    expect((content.results as unknown[]).length).toBe(2)
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
      // Layer 0, two layers, one pair call and one status call.
      plane: { jevCalls: 5, embeddingCalls: 1 },
    })
    expect(JSON.stringify(event)).not.toContain("knowledge/")
  })

  it("on: the graph view and the chat walk read the plane", async () => {
    await setFlag("on")
    const { reader, planeShas } = await selectKnowledgeReader(seed.orgId, [
      ids.ready as string,
    ])
    expect(reader.stack).toBe("plane")
    expect(planeShas.get(ids.ready as string)).toBe(planeSha)
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

  it("on: Jev gets the bytes of an image from the Workspace Git at the served SHA", async () => {
    await setFlag("on")
    const doc = "knowledge/flows.md"
    const flow = "knowledge/img/flow.png"
    const tiny = "knowledge/img/tiny.png"
    const { workspaceId } = await seedRelatedWorkspace({
      seed,
      slug: "pictures",
      sha: planeSha,
      units: [{ path: doc, kind: "Note", title: "Flows" }],
    })
    const repositoryId = generateObjectId("repo")
    await withOrgDbContext(seed.orgId, async (db) => {
      await db.insert(repositories).values({
        id: repositoryId,
        orgId: seed.orgId,
        name: "acme/pictures",
        gitUrl: "https://git.example.test/acme/pictures.git",
        lastIngestedHash: planeSha,
      })
      await db.insert(repositoryCheckouts).values({
        id: generateObjectId("checkout"),
        orgId: seed.orgId,
        repositoryId,
        checkoutKey: `rev:${planeSha}`,
        ref: "main",
        commitSha: planeSha,
      })
    })
    const key = (path: string) => servingIdForKnowledgePath(workspaceId, path)
    const observedAt = new Date("2026-11-01T00:00:00Z")
    const imageDocument = (path: string): DocumentRows => ({
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
      await writer.replaceDocuments({ orgId: seed.orgId, workspaceId }, [
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
          relations: [embeds(flow, "The flow"), embeds(tiny, "")],
        },
        imageDocument(flow),
        imageDocument(tiny),
      ])
    } finally {
      await writer.close()
    }
    await markReady(workspaceId)

    /** A PNG header with the size of the image. */
    const png = (width: number, height: number) => {
      const bytes = Buffer.alloc(33)
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes)
      bytes.writeUInt32BE(13, 8)
      bytes.write("IHDR", 12, "ascii")
      bytes.writeUInt32BE(width, 16)
      bytes.writeUInt32BE(height, 20)
      return bytes
    }
    const files: Record<string, Buffer> = {
      [flow]: png(800, 600),
      // Smaller than Jev takes: it goes as its text.
      [tiny]: png(100, 100),
    }
    const reads: { repositoryId: string; sha: string; paths: string[] }[] = []
    let codesearchDown = false
    vi.stubEnv("CODESEARCH_URL", "http://codesearch.test")
    models.use(
      http.post(
        "http://codesearch.test/:repoId/blobs-query",
        async ({ request, params }) => {
          const { sha, paths } = (await request.json()) as {
            sha: string
            paths: string[]
          }
          reads.push({ repositoryId: String(params.repoId), sha, paths })
          if (codesearchDown)
            return HttpResponse.json({ error: "down" }, { status: 503 })
          return HttpResponse.json(
            Object.fromEntries(
              paths.map((path) => [
                path,
                files[path]?.toString("base64") ?? null,
              ]),
            ),
          )
        },
      ),
    )
    try {
      const result = await relatedCall({
        workspace: "pictures",
        seeds: [doc],
        maxDepth: 1,
      })
      expect(result.isError).toBeFalsy()
      expect(jevImages).toEqual([
        `data:image/png;base64,${files[flow]?.toString("base64")}`,
      ])
      // One read of each image, in the Workspace repository at the served
      // SHA of the plane.
      expect(
        reads
          .map(({ repositoryId, sha, paths }) => [repositoryId, sha, ...paths])
          .sort(),
      ).toEqual([
        [repositoryId, planeSha, flow],
        [repositoryId, planeSha, tiny],
      ])

      // When codesearch fails, each image goes to Jev as its text, and the
      // call does not fail.
      codesearchDown = true
      jevImages.length = 0
      jevTexts.length = 0
      // Another question, so that no cached result answers.
      const fallback = await relatedCall({
        workspace: "pictures",
        seeds: [doc],
        maxDepth: 1,
        query: "Which diagram shows the flow?",
      })
      expect(fallback.isError).toBeFalsy()
      expect(jevImages).toEqual([])
      expect(jevTexts.some((text) => text.includes(`[image] ${flow}`))).toBe(
        true,
      )
    } finally {
      models.resetHandlers()
    }
  })
})
