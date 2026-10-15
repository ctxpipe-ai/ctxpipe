/**
 * Relevance eval for `get_related` on a synthetic engineering Workspace
 * (`test/workspaceOrgGraph.ts`). The gold answers come from how the fixture
 * is built: the owners of a service, the decisions that shape it, the newest
 * pull requests that changed it, and what it depends on. The real walk
 * (`expandWorkspaceGraph`) reads the graph in FalkorDB, and `rankRelated`
 * ranks it. Recall@5 must stay at or above a committed floor for each intent.
 *
 * The eval runs twice: on the `canonical` vocabulary (the predicates of the
 * presets) and on the `free-form` vocabulary (the names that authors write,
 * and plain body links). It asserts on the call with only `intent` and on the
 * call with no `intent` (the `general` default).
 *
 * The test asserts only values that do not depend on time or load: each walk
 * gets 30 s, far above its real time. The cost budget is the size of the
 * explored graph, not a duration.
 *
 * The Workspace graph stores no node-level authority, so this eval does not
 * use that signal. `signalWeights` turns each remaining signal off, to show
 * what it adds. Requires DATABASE_URL and GRAPH_DB_URI (CI starts FalkorDB;
 * locally `pnpm dev:infra`).
 */
import { appendFileSync } from "node:fs"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import { cleanupSeededOrg, type SeededOrg, seedOrg } from "../../../test/db.js"
import {
  type EvalIntent,
  type EvalQuestion,
  type EvalVocabulary,
  workspaceOrgFixture,
} from "../../../test/workspaceOrgGraph.js"
import { withOrgDbContext } from "../../db/client.js"
import { workspaces } from "../../db/schema/workspaces.js"
import {
  getRelatedInputShape,
  rankWorkspaceRelated,
} from "../../mcp/tools/get-related.js"
import { projectionFromWorkspace } from "../../models/workspaces.js"
import { closeGraphDb } from "../../platform/graph/client.js"
import {
  dropOrgGraph,
  seedRelatedWorkspace,
} from "../../test/related-fixture.js"
import { expandWorkspaceGraph, type GraphExpansion } from "./graph-expand.js"
import {
  INTENT_PRESETS,
  type RelevanceOptions,
  rankRelated,
} from "./graph-relevance.js"
import { publishedProjection } from "./revision.js"

const INTENTS: readonly EvalIntent[] = [
  "ownership",
  "why",
  "change",
  "dependencies",
]

/**
 * The walk of each intent (`INTENT_PRESETS[intent].walk`), which `get_related`
 * uses when the caller gives no `predicates`. The ablation rows use it with a
 * fan-out of 1,000, so that no fan-out cap decides the result.
 */
const scopedPredicates = (intent: EvalIntent) => [
  ...(INTENT_PRESETS[intent].walk ?? []),
]

/**
 * Recall@5 floors of the `get_related` defaults, for each vocabulary: the call
 * that an agent makes with only `intent`, and the call with no `intent`. The
 * measured value is at or above the floor. With no intent, one first page
 * must serve four kinds of question (an owner, decisions, five changes, and
 * the dependencies), so its floors are lower. On free-form predicates, the
 * rules of a hub service still crowd out its decisions and dependencies.
 */
const floors: Record<
  EvalVocabulary,
  Record<"intent" | "no intent", Record<EvalIntent, number>>
> = {
  canonical: {
    intent: { ownership: 0.95, why: 0.95, change: 0.85, dependencies: 0.95 },
    "no intent": {
      ownership: 0.8,
      why: 0.45,
      change: 0.2,
      dependencies: 0.1,
    },
  },
  "free-form": {
    intent: { ownership: 0.95, why: 0.45, change: 0.8, dependencies: 0.09 },
    "no intent": {
      ownership: 0.95,
      why: 0.45,
      change: 0.2,
      dependencies: 0.1,
    },
  },
}

/** Each walk gets far more time than it needs, so the load of the machine does not change a result. */
const caps = { hopTimeoutMs: 30_000, totalTimeoutMs: 30_000 }

type Config = {
  /** Expand only the edges of the intent. */
  scoped: boolean
  /** Rank every question with the `general` intent instead of its own. */
  general?: boolean
  signalWeights?: RelevanceOptions["signalWeights"]
  hubPenalty?: number
}

type Recall = Record<EvalIntent, number>

/** Share of the gold paths (at most `k`) that the first `k` results hold. */
function recallAtK(question: EvalQuestion, ranked: readonly string[]): number {
  const wanted = Math.min(question.k, question.gold.size)
  const hits = ranked
    .slice(0, question.k)
    .filter((path) => question.gold.has(path)).length
  return hits / wanted
}

/**
 * Seed the Workspace of `vocabulary`, measure each walk, and add the tests
 * that every vocabulary passes. Call it inside a `describe`.
 */
function evalSuite(vocabulary: EvalVocabulary) {
  const fixture = workspaceOrgFixture(vocabulary)
  const rows = new Map<string, Recall>()
  let seed: SeededOrg
  let workspaceId: string
  let projection: ReturnType<typeof publishedProjection>
  const expansions = new Map<string, Promise<GraphExpansion>>()
  const defaultRankings = new Map<
    EvalQuestion,
    Awaited<ReturnType<typeof rankWorkspaceRelated>>
  >()

  function expand(question: EvalQuestion, scoped: boolean) {
    const key = `${question.intent}\0${question.seed}\0${scoped}`
    let expansion = expansions.get(key)
    if (!expansion) {
      expansion = expandWorkspaceGraph({
        orgId: seed.orgId,
        orgSlug: seed.orgSlug,
        projection,
        seeds: [`ku_${workspaceId}_${question.seed}`],
        // The defaults of `get_related`, except the fan-out of a scoped walk:
        // no node of the fixture has more than 1,000 matching edges, so no
        // tie in the edge order decides which edges the walk keeps. The
        // unscoped walk is the `general` walk: all edges, fan-out 50.
        maxDepth: 2,
        direction: "both",
        minConfidence: 0.2,
        maxFanOut: scoped ? 1_000 : 50,
        predicates: scoped ? scopedPredicates(question.intent) : undefined,
        validAt: fixture.now.toISOString(),
        caps,
      })
      expansions.set(key, expansion)
    }
    return expansion
  }

  async function ranked(question: EvalQuestion, config: Config) {
    const expansion = await expand(question, config.scoped)
    const pathOf = new Map(expansion.nodes.map((node) => [node.id, node.path]))
    const results = rankRelated({
      nodes: expansion.nodes,
      signals: expansion.edges,
      seeds: [`ku_${workspaceId}_${question.seed}`],
      options: {
        intent: config.general ? "general" : question.intent,
        signalWeights: config.signalWeights,
        hubPenalty: config.hubPenalty,
        now: fixture.now,
        limit: 100,
      },
    })
    return {
      expansion,
      paths: results.map((result) => pathOf.get(result.id) ?? result.id),
    }
  }

  /** The `get_related` tool with only `seeds` and `intent`, or with no `intent`. */
  async function toolDefaults(question: EvalQuestion, withIntent: boolean) {
    const input = z.object(getRelatedInputShape).parse({
      workspace: "eval",
      seeds: [question.seed],
      ...(withIntent ? { intent: question.intent } : {}),
    })
    const tool = await rankWorkspaceRelated(
      { id: seed.orgId, slug: seed.orgSlug },
      { id: workspaceId, slug: "eval" },
      "e".repeat(40),
      input,
      fixture.now,
      { caps },
    )
    if (withIntent) defaultRankings.set(question, tool)
    return tool.results.map((result) => result.ref)
  }

  async function recallOf(
    config: Config | "intent" | "no intent",
  ): Promise<Recall> {
    const sums = Object.fromEntries(INTENTS.map((intent) => [intent, [0, 0]]))
    for (const question of fixture.questions) {
      const paths =
        config === "intent" || config === "no intent"
          ? await toolDefaults(question, config === "intent")
          : (await ranked(question, config)).paths
      const sum = sums[question.intent] as number[]
      sum[0] = (sum[0] ?? 0) + recallAtK(question, paths)
      sum[1] = (sum[1] ?? 0) + 1
    }
    return Object.fromEntries(
      INTENTS.map((intent) => {
        const [total = 0, count = 0] = sums[intent] ?? []
        return [intent, count > 0 ? total / count : 0]
      }),
    ) as Recall
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
    if (!process.env.GRAPH_DB_URI) throw new Error("GRAPH_DB_URI is required")
    seed = await seedOrg()
    const seeded = await seedRelatedWorkspace({
      seed,
      slug: "eval",
      sha: "e".repeat(40),
      units: fixture.units,
    })
    workspaceId = seeded.workspaceId
    const [row] = await withOrgDbContext(seed.orgId, (db) =>
      db.select().from(workspaces).where(eq(workspaces.id, workspaceId)),
    )
    if (!row) throw new Error("The fixture Workspace is missing.")
    projection = publishedProjection(projectionFromWorkspace(row))
    rows.set("tool defaults (only intent)", await recallOf("intent"))
    rows.set("tool defaults (no intent)", await recallOf("no intent"))
    const configs: Array<[string, Config]> = [
      ["all edges, fan-out 50", { scoped: false }],
      [
        "all edges, fan-out 50, intent general",
        { scoped: false, general: true },
      ],
      ["scoped walk", { scoped: true }],
      ["scoped, intent general", { scoped: true, general: true }],
      ["scoped, truth off", { scoped: true, signalWeights: { truth: 0 } }],
      ["scoped, recency off", { scoped: true, signalWeights: { recency: 0 } }],
      [
        "scoped, truth and recency off",
        { scoped: true, signalWeights: { truth: 0, recency: 0 } },
      ],
      ["scoped, hub penalty off", { scoped: true, hubPenalty: 0 }],
    ]
    for (const [label, config] of configs) {
      rows.set(label, await recallOf(config))
    }
    const report = [
      `### Graph relevance eval, ${vocabulary} vocabulary (${fixture.questions.length} questions, recall@5)`,
      "",
      `| walk | ${INTENTS.join(" | ")} |`,
      `|---|${INTENTS.map(() => "---").join("|")}|`,
      ...[...rows].map(
        ([label, recall]) =>
          `| ${label} | ${INTENTS.map((intent) => recall[intent].toFixed(2)).join(" | ")} |`,
      ),
      "",
    ].join("\n")
    process.stdout.write(`${report}\n`)
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, report)
  }, 600_000)

  afterAll(async () => {
    if (seed) {
      await withOrgDbContext(seed.orgId, (db) =>
        db.delete(workspaces).where(eq(workspaces.orgId, seed.orgId)),
      )
      await dropOrgGraph(seed.orgId)
      await cleanupSeededOrg(seed)
    }
  })

  it("has gold answers for each intent, with a hub service among them", () => {
    expect(fixture.questions.length).toBeGreaterThanOrEqual(20)
    for (const intent of INTENTS) {
      const asked = fixture.questions.filter((q) => q.intent === intent)
      expect(asked.length).toBeGreaterThanOrEqual(5)
      expect(asked.some((q) => q.hub)).toBe(true)
    }
  })

  it.each([
    "intent",
    "no intent",
  ] as const)("keeps recall@5 of the tool defaults (%s) at or above the floor for each intent", (mode) => {
    const defaults = rows.get(
      mode === "intent"
        ? "tool defaults (only intent)"
        : "tool defaults (no intent)",
    ) as Recall
    for (const intent of INTENTS) {
      expect(defaults[intent], intent).toBeGreaterThanOrEqual(
        floors[vocabulary][mode][intent],
      )
    }
  })

  it("explores a bounded graph for each question", async () => {
    for (const question of fixture.questions) {
      const defaults = defaultRankings.get(question)
      expect(defaults?.partial, `${question.intent} ${question.seed}`).toBe(
        false,
      )
      expect(defaults?.explored.nodes).toBeLessThanOrEqual(400)
      expect(defaults?.explored.edges).toBeLessThanOrEqual(500)
      // The unscoped walk keeps its fan-out cap: the hub service hits it.
      const unscoped = await expand(question, false)
      expect(unscoped.partial).toBe(false)
      if (question.hub)
        expect(unscoped.cappedHubs).toContain(
          `ku_${workspaceId}_${question.seed}`,
        )
    }
  })

  return {
    fixture,
    rows,
    ranked,
    org: () => ({ id: seed.orgId, slug: seed.orgSlug }),
    workspaceId: () => workspaceId,
  }
}

describe("graph relevance eval (synthetic engineering Workspace, canonical vocabulary)", () => {
  const { fixture, rows, ranked, org, workspaceId } = evalSuite("canonical")

  it("loses the dated signals: recency and truth lift the change questions", () => {
    const full = rows.get("scoped walk") as Recall
    const off = rows.get("scoped, truth and recency off") as Recall
    expect(full.change - off.change).toBeGreaterThanOrEqual(0.3)
  })

  it("loses the hub penalty: it lifts the decisions that shape one service above the broad ones", () => {
    const full = rows.get("scoped walk") as Recall
    const off = rows.get("scoped, hub penalty off") as Recall
    expect(full.why - off.why).toBeGreaterThanOrEqual(0.3)
  })

  it("ranks the same top results as the get_related tool for the same call", async () => {
    for (const question of fixture.questions) {
      const input = z.object(getRelatedInputShape).parse({
        workspace: "eval",
        seeds: [question.seed],
        intent: question.intent,
        predicates: scopedPredicates(question.intent),
        maxFanOut: 1_000,
      })
      const tool = await rankWorkspaceRelated(
        org(),
        { id: workspaceId(), slug: "eval" },
        "e".repeat(40),
        input,
        fixture.now,
        { caps },
      )
      const { paths } = await ranked(question, { scoped: true })
      expect(
        tool.results.slice(0, 5).map((result) => result.ref),
        `${question.intent} ${question.seed}`,
      ).toEqual(paths.slice(0, 5))
    }
  })
})

describe("graph relevance eval (synthetic engineering Workspace, free-form vocabulary)", () => {
  evalSuite("free-form")
})

afterAll(async () => {
  await closeGraphDb()
})
