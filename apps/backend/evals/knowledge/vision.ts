import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { z } from "zod"

import { convertFile } from "../../src/knowledge-plane/convert-file.js"
import {
  firstOfEachId,
  IMAGE_TEXT_PROMPT_VERSION,
  type ImageReading,
  imageText,
  readImage,
} from "../../src/knowledge-plane/image-text.js"
import { buildConverter } from "../../test/converter.js"
import type { ModelCalls } from "./model-calls.js"

/*
 * The vision eval (CTX-1433). Each vision model reads each diagram fixture
 * through the production client (`readImage`), and the score compares its
 * reading with the gold graph of the fixture. Diagrams are the main feature
 * of the image text: the score measures the nodes, the edges, the edge
 * labels, the groups, the direction and the order of a sequence. The report
 * also gives the cost of each image and the ZDR endpoints of each model that
 * take the JSON schema: with no provider pin, they are the fallbacks.
 *
 * The fixtures are made-up diagrams, drawn with Graphviz, D2 (also in its
 * hand-drawn sketch style), PlantUML and Mermaid. A hard set adds a dense
 * mesh, two photos, a small screenshot, swimlanes and a C4 diagram
 * (`fixtures/vision/README.md`).
 */

/** The candidates of the eval: ZDR vision models of three families. */
export const VISION_MODELS = [
  "openai/gpt-6.1-terra",
  "google/gemini-3.8-flash",
  "anthropic/claude-sonnet-5.5",
]

const goldSchema = z.discriminatedUnion("kind", [
  z.object({
    category: z.enum(["architecture", "flow", "sequence"]),
    kind: z.literal("graph"),
    /** Null for a layout with no main direction (a mesh): not scored. */
    direction: z.enum(["TB", "LR", "BT", "RL"]).nullable(),
    groups: z.array(
      z.object({ label: z.string(), parent: z.string().nullable() }),
    ),
    nodes: z.array(
      z.object({ label: z.string(), group: z.string().nullable() }),
    ),
    edges: z.array(
      z.object({
        from: z.string(),
        to: z.string(),
        label: z.string().nullable(),
      }),
    ),
  }),
  z.object({
    category: z.enum(["architecture", "flow", "sequence"]),
    kind: z.literal("sequence"),
    participants: z.array(z.string()),
    messages: z.array(
      z.object({ from: z.string(), to: z.string(), label: z.string() }),
    ),
  }),
])
export type Gold = z.infer<typeof goldSchema>

/** The score of one reading against the gold graph of its fixture. */
export type Score = {
  /** Nodes, or the participants of a sequence. */
  nodeF1: number
  /** Edges, or the messages of a sequence (with their labels). */
  edgeF1: number
  /** The share of the matched edges of a graph with the gold label. */
  edgeLabel: number | null
  /** The groups of a graph, matched by label and by parent group. */
  groupF1: number | null
  /** The share of the matched nodes of a graph in the gold group. */
  membership: number | null
  direction: boolean | null
  /** The share of the matched messages of a sequence in the gold order. */
  order: number | null
}

const normalize = (label: string) =>
  label
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

const bigrams = (text: string) => {
  const compact = text.replace(/ /g, "")
  return Array.from({ length: Math.max(compact.length - 1, 0) }, (_, i) =>
    compact.slice(i, i + 2),
  )
}

/**
 * The similarity of a predicted label to a gold label: 1 when they are
 * equal after normalization, 0.9 when the predicted label holds all the
 * words of the gold label in a row, else the Dice coefficient of their
 * character pairs. It accepts small reading errors, as in the photo
 * fixtures, and the full text of a C4 box (a stereotype, the name, a type
 * and a description). A predicted label that drops words gets no 0.9.
 */
function similarity(gold: string, predicted: string): number {
  const left = normalize(gold)
  const right = normalize(predicted)
  if (left === right) return 1
  if (left && ` ${right} `.includes(` ${left} `)) return 0.9
  const pairs = bigrams(left)
  const others = bigrams(right)
  if (pairs.length === 0 || others.length === 0) return 0
  const pool = [...others]
  let shared = 0
  for (const pair of pairs) {
    const at = pool.indexOf(pair)
    if (at >= 0) {
      shared += 1
      pool.splice(at, 1)
    }
  }
  return (2 * shared) / (pairs.length + others.length)
}

const SAME_LABEL = 0.75
const sameLabel = (gold: string, predicted: string) =>
  (!normalize(gold) && !normalize(predicted)) ||
  similarity(gold, predicted) >= SAME_LABEL

/**
 * A one-to-one match of predicted labels to gold labels, best pairs first.
 * Returns the gold index of each matched predicted index.
 */
function matchLabels(
  gold: readonly string[],
  predicted: readonly string[],
): Map<number, number> {
  const pairs: { g: number; p: number; score: number }[] = []
  gold.forEach((g, gi) => {
    predicted.forEach((p, pi) => {
      const score = similarity(g, p)
      if (score >= SAME_LABEL) pairs.push({ g: gi, p: pi, score })
    })
  })
  pairs.sort((a, b) => b.score - a.score || a.g - b.g || a.p - b.p)
  const match = new Map<number, number>()
  const usedGold = new Set<number>()
  for (const pair of pairs)
    if (!match.has(pair.p) && !usedGold.has(pair.g)) {
      match.set(pair.p, pair.g)
      usedGold.add(pair.g)
    }
  return match
}

function f1(matched: number, predicted: number, gold: number): number {
  if (predicted === 0 && gold === 0) return 1
  if (matched === 0) return 0
  const precision = matched / predicted
  const recall = matched / gold
  return (2 * precision * recall) / (precision + recall)
}

/** The length of the longest increasing run (not contiguous) of `values`. */
function longestIncreasing(values: readonly number[]): number {
  const tails: number[] = []
  for (const value of values) {
    let low = 0
    let high = tails.length
    while (low < high) {
      const mid = (low + high) >> 1
      if ((tails[mid] ?? 0) < value) low = mid + 1
      else high = mid
    }
    tails[low] = value
  }
  return tails.length
}

function scoreGraph(
  gold: Extract<Gold, { kind: "graph" }>,
  reading: ImageReading,
): Score {
  const diagram = reading.diagram
  const nodes = firstOfEachId(diagram.nodes)
  const groups = firstOfEachId(diagram.groups)
  const nodeMatch = matchLabels(
    gold.nodes.map((node) => node.label),
    nodes.map((node) => node.label),
  )
  const groupMatch = matchLabels(
    gold.groups.map((group) => group.label),
    groups.map((group) => group.label),
  )
  const goldNodeOf = new Map(
    nodes.map((node, i) => [node.id, nodeMatch.get(i) ?? -1]),
  )
  const goldIndex = new Map(gold.nodes.map((node, i) => [node.label, i]))
  const used = new Set<number>()
  let matchedEdges = 0
  let sameEdgeLabel = 0
  // Each gold edge has one arrowhead, at `to`. A predicted edge matches it
  // only in the same direction and with one arrowhead.
  for (const edge of gold.edges) {
    const from = goldIndex.get(edge.from)
    const to = goldIndex.get(edge.to)
    const at = diagram.edges.findIndex(
      (candidate, i) =>
        !used.has(i) &&
        candidate.arrow === "forward" &&
        goldNodeOf.get(candidate.from) === from &&
        goldNodeOf.get(candidate.to) === to,
    )
    if (at < 0) continue
    used.add(at)
    matchedEdges += 1
    if (sameLabel(edge.label ?? "", diagram.edges[at]?.label ?? ""))
      sameEdgeLabel += 1
  }
  // The gold label of a predicted group id: null for "" (no group), and a
  // label that no gold group has for a group with no gold match.
  const unmatched = "\0unmatched"
  const goldLabelOf = new Map(
    groups.map((group, i) => {
      const g = groupMatch.get(i)
      return [group.id, g === undefined ? unmatched : gold.groups[g]?.label]
    }),
  )
  const goldGroupOf = (id: string) =>
    id ? (goldLabelOf.get(id) ?? unmatched) : null
  // A group counts only in the gold place: a reading that flattens nested
  // groups loses the inner ones.
  const groupsInPlace = [...groupMatch].filter(
    ([p, g]) =>
      goldGroupOf(groups[p]?.parent ?? "") === (gold.groups[g]?.parent ?? null),
  ).length
  const inGoldGroup = [...nodeMatch].filter(
    ([p, g]) =>
      goldGroupOf(nodes[p]?.group ?? "") === (gold.nodes[g]?.group ?? null),
  ).length
  return {
    nodeF1: f1(nodeMatch.size, nodes.length, gold.nodes.length),
    edgeF1: f1(matchedEdges, diagram.edges.length, gold.edges.length),
    edgeLabel: matchedEdges ? sameEdgeLabel / matchedEdges : null,
    groupF1: f1(groupsInPlace, groups.length, gold.groups.length),
    membership: nodeMatch.size ? inGoldGroup / nodeMatch.size : null,
    direction: gold.direction && diagram.direction === gold.direction,
    order: null,
  }
}

function scoreSequence(
  gold: Extract<Gold, { kind: "sequence" }>,
  reading: ImageReading,
): Score {
  const diagram = reading.diagram
  const participants = firstOfEachId(diagram.participants)
  const match = matchLabels(
    gold.participants,
    participants.map((participant) => participant.label),
  )
  const goldOf = new Map(
    participants.map((participant, i) => [participant.id, match.get(i) ?? -1]),
  )
  const goldIndex = new Map(gold.participants.map((label, i) => [label, i]))
  const used = new Set<number>()
  // The gold index of each matched message, in the predicted order.
  const matched: { predicted: number; gold: number }[] = []
  gold.messages.forEach((message, g) => {
    const at = diagram.messages.findIndex(
      (candidate, i) =>
        !used.has(i) &&
        goldOf.get(candidate.from) === goldIndex.get(message.from) &&
        goldOf.get(candidate.to) === goldIndex.get(message.to) &&
        sameLabel(message.label, candidate.label),
    )
    if (at < 0) return
    used.add(at)
    matched.push({ predicted: at, gold: g })
  })
  matched.sort((a, b) => a.predicted - b.predicted)
  return {
    nodeF1: f1(match.size, participants.length, gold.participants.length),
    edgeF1: f1(matched.length, diagram.messages.length, gold.messages.length),
    edgeLabel: null,
    groupF1: null,
    membership: null,
    direction: null,
    order: matched.length
      ? longestIncreasing(matched.map((item) => item.gold)) / matched.length
      : null,
  }
}

/** The score of a reading against the gold graph of its fixture. */
export function scoreReading(gold: Gold, reading: ImageReading): Score {
  return gold.kind === "graph"
    ? scoreGraph(gold, reading)
    : scoreSequence(gold, reading)
}

type Fixture = {
  name: string
  gold: Gold
  image: { bytes: Buffer; mimeType: string }
}

/**
 * Each `<name>.gold.json` of `fixtures/vision/` with its image `<name>.png`,
 * `<name>.jpg` or `<name>.svg`. An SVG becomes the PNG of the converter, as
 * in the projection (`convertFile`).
 */
export async function readFixtures(): Promise<Fixture[]> {
  // The export of `factory eval` has no build of the converter.
  buildConverter()
  const dir = fileURLToPath(new URL("./fixtures/vision", import.meta.url))
  const mimeTypes: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    svg: "image/svg+xml",
  }
  const files = (await readdir(dir)).sort()
  const fixtures: Fixture[] = []
  for (const file of files) {
    if (!file.endsWith(".gold.json")) continue
    const name = file.slice(0, -".gold.json".length)
    const image = files.find((other) =>
      Object.keys(mimeTypes).some((ext) => other === `${name}.${ext}`),
    )
    if (!image) throw new Error(`The fixture ${name} has no image.`)
    const bytes = await readFile(join(dir, image))
    const svg = image.endsWith(".svg") ? await convertFile("svg", bytes) : null
    if (svg && svg.kind !== "image")
      throw new Error(`The converter cannot render the fixture ${name}.`)
    fixtures.push({
      name,
      gold: goldSchema.parse(
        JSON.parse(await readFile(join(dir, file), "utf8")),
      ),
      image: svg
        ? { bytes: svg.png, mimeType: "image/png" }
        : {
            bytes,
            mimeType: mimeTypes[image.split(".").pop() ?? ""] ?? "image/png",
          },
    })
  }
  return fixtures
}

const zdrSchema = z.object({
  data: z.array(
    z.object({
      model_id: z.string(),
      provider_name: z.string(),
      tag: z.string(),
      supported_parameters: z.array(z.string()).default([]),
    }),
  ),
})

/**
 * The ZDR endpoints of each model that take a JSON schema
 * (`GET /endpoints/zdr`). With no provider pin, OpenRouter can fall back
 * from one of them to another. Null when the list is not available: the
 * report then says "unknown", and the scores still count.
 */
async function zdrEndpoints(
  base: string,
  models: readonly string[],
): Promise<Map<string, { endpoints: string[]; providers: string[] }> | null> {
  const response = await fetch(
    `${base.replace(/\/+$/, "")}/endpoints/zdr`,
  ).catch(() => null)
  const parsed = zdrSchema.safeParse(
    response?.ok ? await response.json().catch(() => null) : null,
  )
  if (!parsed.success) return null
  const list = parsed.data.data
  return new Map(
    models.map((model) => {
      const endpoints = list.filter(
        (endpoint) =>
          endpoint.model_id === model &&
          endpoint.supported_parameters.includes("structured_outputs"),
      )
      return [
        model,
        {
          endpoints: endpoints.map((endpoint) => endpoint.tag).sort(),
          providers: [
            ...new Set(endpoints.map((endpoint) => endpoint.provider_name)),
          ].sort(),
        },
      ]
    }),
  )
}

type Result = {
  model: string
  fixture: string
  category: Gold["category"]
  score: Score | null
  /** The cost of all the attempts of the call, failed ones too. */
  costUsd: number
  latencyMs: number
  provider: string | null
  error: string | null
  text: string | null
  reading: ImageReading | null
}

const mean = (values: readonly (number | boolean | null)[]): number | null => {
  const numbers = values
    .filter((value) => value !== null)
    .map((value) => Number(value))
  return numbers.length
    ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length
    : null
}

const median = (values: readonly number[]): number | null => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? null) : null
}

/** The summary of one model over the fixtures. */
export type ModelSummary = {
  model: string
  nodeF1: number | null
  edgeF1: number | null
  edgeLabel: number | null
  groupF1: number | null
  membership: number | null
  direction: number | null
  order: number | null
  edgeF1ByCategory: Record<Gold["category"], number | null>
  failed: number
  costPerImageUsd: number | null
  medianLatencyMs: number | null
  answeredBy: string[]
  /** Null when the ZDR list was not available. */
  zdrEndpoints: string[] | null
  zdrProviders: string[] | null
}

function summarize(
  model: string,
  results: readonly Result[],
  zdr: { endpoints: string[]; providers: string[] } | null,
): ModelSummary {
  const scored = results.filter((result) => result.score)
  const of = (pick: (score: Score) => number | boolean | null) =>
    mean(scored.map((result) => (result.score ? pick(result.score) : null)))
  const byCategory = (category: Gold["category"]) =>
    mean(
      scored
        .filter((result) => result.category === category)
        .map((result) => result.score?.edgeF1 ?? null),
    )
  return {
    model,
    nodeF1: of((score) => score.nodeF1),
    edgeF1: of((score) => score.edgeF1),
    edgeLabel: of((score) => score.edgeLabel),
    groupF1: of((score) => score.groupF1),
    membership: of((score) => score.membership),
    direction: of((score) => score.direction),
    order: of((score) => score.order),
    edgeF1ByCategory: {
      architecture: byCategory("architecture"),
      flow: byCategory("flow"),
      sequence: byCategory("sequence"),
    },
    failed: results.length - scored.length,
    costPerImageUsd: mean(results.map((result) => result.costUsd)),
    medianLatencyMs: median(scored.map((result) => result.latencyMs)),
    answeredBy: [
      ...new Set(results.flatMap((result) => result.provider ?? [])),
    ].sort(),
    zdrEndpoints: zdr?.endpoints ?? null,
    zdrProviders: zdr?.providers ?? null,
  }
}

const pct = (value: number | null) => (value === null ? "–" : value.toFixed(2))
const usd = (value: number | null) =>
  value === null ? "–" : `$${value.toFixed(4)}`

function renderReport(input: {
  summaries: readonly ModelSummary[]
  results: readonly Result[]
  fixtures: readonly Fixture[]
  spentUsd: number
  capUsd: number
  stopped: boolean
  now: Date
}): string {
  const lines = [
    "# Vision eval",
    "",
    `Run at ${input.now.toISOString()}. Prompt version ${IMAGE_TEXT_PROMPT_VERSION}. ${input.fixtures.length} fixtures. Spend $${input.spentUsd.toFixed(4)} of the cap $${input.capUsd}.${input.stopped ? " **The spend cap stopped the run.**" : ""}`,
    "",
    "The scores are means over the fixtures (1.00 is the gold graph). Node F1 counts the participants of a sequence, and edge F1 its messages with their labels. The cost per image includes the retries and the failed calls. Fallback: the ZDR endpoints of the model that take the JSON schema, and their providers.",
    "",
    "| Model | Node F1 | Edge F1 | Edge label | Group F1 | Group membership | Direction | Sequence order | Failed | Cost per image | Median latency | Answered by | Fallback endpoints (providers) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...input.summaries.map(
      (s) =>
        `| ${s.model} | ${pct(s.nodeF1)} | ${pct(s.edgeF1)} | ${pct(s.edgeLabel)} | ${pct(s.groupF1)} | ${pct(s.membership)} | ${pct(s.direction)} | ${pct(s.order)} | ${s.failed} | ${usd(s.costPerImageUsd)} | ${s.medianLatencyMs === null ? "–" : `${(s.medianLatencyMs / 1000).toFixed(1)} s`} | ${s.answeredBy.join(", ") || "–"} | ${s.zdrEndpoints === null ? "unknown" : `${s.zdrEndpoints.length} (${s.zdrProviders?.join(", ") || "none"})`} |`,
    ),
    "",
    "## Edge F1 by category",
    "",
    "| Model | Architecture | Flow | Sequence |",
    "| --- | --- | --- | --- |",
    ...input.summaries.map(
      (s) =>
        `| ${s.model} | ${pct(s.edgeF1ByCategory.architecture)} | ${pct(s.edgeF1ByCategory.flow)} | ${pct(s.edgeF1ByCategory.sequence)} |`,
    ),
    "",
    "## Edge F1 of each fixture",
    "",
    `| Fixture | Category | ${input.summaries.map((s) => s.model).join(" | ")} |`,
    `| --- | --- | ${input.summaries.map(() => "---").join(" | ")} |`,
    ...input.fixtures.map((fixture) => {
      const cells = input.summaries.map((s) => {
        const result = input.results.find(
          (item) => item.model === s.model && item.fixture === fixture.name,
        )
        return result?.score ? pct(result.score.edgeF1) : (result?.error ?? "–")
      })
      return `| ${fixture.name} | ${fixture.gold.category} | ${cells.join(" | ")} |`
    }),
    "",
    "The text of each reading is in `<model>/<fixture>.md`, and each reading and score in `vision.json`.",
    "",
  ]
  return lines.join("\n")
}

/**
 * Read each fixture with each model, score the readings and write the
 * report (`vision.md`, `vision.json`, and the text of each reading) to
 * `out`. `calls` is the recorder in front of `fetch`: it applies the spend
 * cap and counts the cost of each call.
 */
export async function runVision(input: {
  models: readonly string[]
  out: string
  calls: ModelCalls
  capUsd: number
  base: string
  now?: Date
}): Promise<{ summaries: ModelSummary[]; stopped: boolean }> {
  const fixtures = await readFixtures()
  const zdr = await zdrEndpoints(input.base, input.models)
  const results: Result[] = []
  // One call at a time, so that the recorder gives the cost of each call
  // with its retries. After the spend cap, no call goes out.
  for (const model of input.models)
    for (const fixture of fixtures) {
      if (input.calls.stopped) break
      const base = {
        model,
        fixture: fixture.name,
        category: fixture.gold.category,
      }
      input.calls.begin(model, fixture.name)
      const started = performance.now()
      const read = await readImage(fixture.image, { models: [model] }).catch(
        (error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
      )
      const latencyMs = Math.round(performance.now() - started)
      const { costUsd } = input.calls.end()
      results.push(
        read instanceof Error
          ? {
              ...base,
              score: null,
              costUsd,
              latencyMs,
              provider: null,
              error: read.message,
              text: null,
              reading: null,
            }
          : {
              ...base,
              score: scoreReading(fixture.gold, read.reading),
              costUsd,
              latencyMs,
              provider: read.provider,
              error: null,
              text: imageText(read.reading),
              reading: read.reading,
            },
      )
    }
  const summaries = input.models.map((model) =>
    summarize(
      model,
      results.filter((result) => result.model === model),
      zdr?.get(model) ?? null,
    ),
  )
  const now = input.now ?? new Date()
  await mkdir(input.out, { recursive: true })
  for (const result of results)
    if (result.text) {
      const dir = join(input.out, result.model.replace(/\//g, "__"))
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `${result.fixture}.md`), result.text)
    }
  await writeFile(
    join(input.out, "vision.json"),
    `${JSON.stringify(
      {
        now: now.toISOString(),
        promptVersion: IMAGE_TEXT_PROMPT_VERSION,
        capUsd: input.capUsd,
        spentUsd: input.calls.spentUsd,
        stopped: input.calls.stopped,
        summaries,
        results,
      },
      null,
      2,
    )}\n`,
  )
  await writeFile(
    join(input.out, "vision.md"),
    renderReport({
      summaries,
      results,
      fixtures,
      spentUsd: input.calls.spentUsd,
      capUsd: input.capUsd,
      stopped: input.calls.stopped,
      now,
    }),
  )
  return { summaries, stopped: input.calls.stopped }
}
