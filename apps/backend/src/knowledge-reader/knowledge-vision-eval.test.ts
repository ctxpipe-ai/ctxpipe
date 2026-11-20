import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HttpResponse, http } from "msw"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ModelCalls } from "../../evals/knowledge/model-calls.js"
import {
  type Gold,
  readFixtures,
  runVision,
  scoreReading,
} from "../../evals/knowledge/vision.js"
import { useMswServer } from "../../test/msw.js"
import type { ImageReading } from "../knowledge-plane/image-text.js"

const BASE = "https://openrouter.test/api/v1"
const server = useMswServer()

beforeEach(() => {
  vi.stubEnv("MODEL_PROVIDER", "openrouter")
  vi.stubEnv("MODEL_PROVIDER_API_KEY", "test-key")
  vi.stubEnv("MODEL_PROVIDER_URL", BASE)
})
afterEach(() => {
  vi.unstubAllEnvs()
})

/** The reading that a perfect model gives for a gold graph. */
function perfectReading(gold: Gold): ImageReading {
  const empty = {
    groups: [],
    nodes: [],
    edges: [],
    participants: [],
    messages: [],
  }
  if (gold.kind === "sequence")
    return {
      description: "A sequence diagram.",
      text: "",
      diagram: {
        ...empty,
        kind: "sequence",
        direction: "TB",
        participants: gold.participants.map((label, i) => ({
          id: `p${i}`,
          label,
        })),
        messages: gold.messages.map((message) => ({
          from: `p${gold.participants.indexOf(message.from)}`,
          to: `p${gold.participants.indexOf(message.to)}`,
          label: message.label,
          reply: false,
        })),
      },
    }
  const groupId = (label: string | null) =>
    label === null
      ? ""
      : `g${gold.groups.findIndex((group) => group.label === label)}`
  const nodeId = (label: string) =>
    `n${gold.nodes.findIndex((node) => node.label === label)}`
  return {
    description: "A diagram.",
    text: "",
    diagram: {
      ...empty,
      kind: "graph",
      direction: gold.direction ?? "LR",
      groups: gold.groups.map((group) => ({
        id: groupId(group.label),
        label: group.label,
        parent: groupId(group.parent),
      })),
      nodes: gold.nodes.map((node) => ({
        id: nodeId(node.label),
        label: node.label,
        group: groupId(node.group),
      })),
      edges: gold.edges.map((edge) => ({
        from: nodeId(edge.from),
        to: nodeId(edge.to),
        label: edge.label ?? "",
        arrow: "forward" as const,
      })),
    },
  }
}

const graphGold: Gold = {
  category: "architecture",
  kind: "graph",
  direction: "LR",
  groups: [{ label: "Private subnet", parent: null }],
  nodes: [
    { label: "User", group: null },
    { label: "API service", group: "Private subnet" },
    { label: "PostgreSQL", group: "Private subnet" },
    { label: "Redis cache", group: "Private subnet" },
  ],
  edges: [
    { from: "User", to: "API service", label: "HTTPS" },
    { from: "API service", to: "PostgreSQL", label: "SQL" },
    { from: "API service", to: "Redis cache", label: "sessions" },
    { from: "PostgreSQL", to: "Redis cache", label: null },
  ],
}

describe("scoreReading", () => {
  it("gives 1 for each measure of a perfect reading", () => {
    expect(scoreReading(graphGold, perfectReading(graphGold))).toEqual({
      nodeF1: 1,
      edgeF1: 1,
      edgeLabel: 1,
      groupF1: 1,
      membership: 1,
      direction: true,
      order: null,
    })
  })

  it("counts a reversed edge, a dropped edge, a wrong label and a node out of its group", () => {
    const reading = perfectReading(graphGold)
    const [toApi, toDb, toRedis] = reading.diagram.edges
    if (!toApi || !toDb || !toRedis) throw new Error("fixture")
    reading.diagram.edges = [
      toApi,
      { ...toDb, label: "JDBC" },
      // Reversed: the arrowhead is at the API service.
      { ...toRedis, from: toRedis.to, to: toRedis.from },
    ]
    reading.diagram.nodes = reading.diagram.nodes.map((node) =>
      node.label === "Redis cache" ? { ...node, group: "" } : node,
    )
    // A reading error of a photo still matches its node.
    reading.diagram.nodes = reading.diagram.nodes.map((node) =>
      node.label === "PostgreSQL" ? { ...node, label: "PostgreSOL" } : node,
    )
    const score = scoreReading(graphGold, reading)
    // 2 of 3 predicted edges match, of 4 gold edges.
    expect(score.edgeF1).toBeCloseTo((2 * (2 / 3) * (2 / 4)) / (2 / 3 + 2 / 4))
    expect(score.edgeLabel).toBe(0.5)
    expect(score.nodeF1).toBe(1)
    expect(score.membership).toBe(0.75)
  })

  it("does not match an edge with no arrowhead or with arrowheads at both ends", () => {
    const reading = perfectReading(graphGold)
    reading.diagram.edges = reading.diagram.edges.map((edge, i) =>
      i === 0
        ? { ...edge, arrow: "none" }
        : i === 1
          ? { ...edge, arrow: "both" }
          : edge,
    )
    expect(scoreReading(graphGold, reading).edgeF1).toBe(0.5)
  })

  it("counts a nested group only under its gold parent", () => {
    const gold: Gold = {
      ...graphGold,
      groups: [
        { label: "VPC", parent: null },
        { label: "Private subnet", parent: "VPC" },
      ],
    }
    expect(scoreReading(gold, perfectReading(gold)).groupF1).toBe(1)
    const flattened = perfectReading(gold)
    flattened.diagram.groups = flattened.diagram.groups.map((group) => ({
      ...group,
      parent: "",
    }))
    // VPC is in place; Private subnet lost its parent.
    expect(scoreReading(gold, flattened).groupF1).toBe(0.5)
    expect(scoreReading(gold, flattened).membership).toBe(1)
  })

  it("scores the order of the messages of a sequence", () => {
    const gold: Gold = {
      category: "sequence",
      kind: "sequence",
      participants: ["Browser", "Server"],
      messages: [
        { from: "Browser", to: "Server", label: "GET /" },
        { from: "Server", to: "Browser", label: "200" },
        { from: "Browser", to: "Server", label: "POST /form" },
      ],
    }
    const reading = perfectReading(gold)
    const [first, second, third] = reading.diagram.messages
    if (!first || !second || !third) throw new Error("fixture")
    reading.diagram.messages = [second, first, third]
    const score = scoreReading(gold, reading)
    expect(score.edgeF1).toBe(1)
    expect(score.order).toBeCloseTo(2 / 3)
  })

  it("matches a label that holds the gold name and more text, and skips a null direction", () => {
    const gold: Gold = { ...graphGold, direction: null }
    const reading = perfectReading(gold)
    reading.diagram.nodes = reading.diagram.nodes.map((node) =>
      node.label === "API service"
        ? { ...node, label: "«container» API service [Go] The JSON API" }
        : node,
    )
    reading.diagram.edges = reading.diagram.edges.map((edge) =>
      edge.label === "SQL" ? { ...edge, label: "SQL [JDBC]" } : edge,
    )
    const score = scoreReading(gold, reading)
    expect(score).toMatchObject({ nodeF1: 1, edgeF1: 1, edgeLabel: 1 })
    expect(score.direction).toBeNull()
  })

  it("does not match a label that drops words of the gold name", () => {
    const reading = perfectReading(graphGold)
    reading.diagram.nodes = reading.diagram.nodes.map((node) =>
      node.label === "Redis cache" ? { ...node, label: "Redis" } : node,
    )
    expect(scoreReading(graphGold, reading).nodeF1).toBeLessThan(1)
  })

  it("gives 0 to a reading that finds no diagram", () => {
    const reading = perfectReading(graphGold)
    reading.diagram = {
      ...reading.diagram,
      kind: "none",
      groups: [],
      nodes: [],
      edges: [],
    }
    expect(scoreReading(graphGold, reading)).toMatchObject({
      nodeF1: 0,
      edgeF1: 0,
    })
  })
})

describe("runVision", () => {
  it("reads each fixture with each model through the client, and reports the scores, the cost and the fallback endpoints", async () => {
    // The reading of each fixture image, by its base64 bytes.
    const readings = new Map(
      (await readFixtures()).map((fixture) => [
        fixture.image.bytes.toString("base64"),
        perfectReading(fixture.gold),
      ]),
    )
    const bodies: Record<string, unknown>[] = []
    server.use(
      http.get(`${BASE}/endpoints/zdr`, () =>
        HttpResponse.json({
          data: [
            {
              model_id: "vendor/good",
              provider_name: "Alpha",
              tag: "alpha",
              supported_parameters: ["structured_outputs"],
            },
            {
              model_id: "vendor/good",
              provider_name: "Beta",
              tag: "beta/fp8",
              supported_parameters: ["structured_outputs"],
            },
            {
              model_id: "vendor/good",
              provider_name: "Gamma",
              tag: "gamma",
              supported_parameters: ["tools"],
            },
          ],
        }),
      ),
      http.post(`${BASE}/chat/completions`, async ({ request }) => {
        const body = (await request.json()) as {
          model: string
          messages: { content: unknown }[]
        }
        bodies.push(body)
        if (body.model === "vendor/broken")
          return HttpResponse.json({ error: {} }, { status: 400 })
        const url = JSON.stringify(body.messages).match(
          /base64,([A-Za-z0-9+/=]+)/,
        )?.[1]
        return HttpResponse.json({
          provider: "Alpha",
          choices: [
            {
              message: { content: JSON.stringify(readings.get(url ?? "")) },
            },
          ],
          usage: { cost: 0.01 },
        })
      }),
    )
    const out = await mkdtemp(join(tmpdir(), "vision-eval-"))
    const calls = new ModelCalls(BASE, 5)
    const restore = calls.install()
    try {
      const result = await runVision({
        models: ["vendor/good", "vendor/broken"],
        out,
        calls,
        capUsd: 5,
        base: BASE,
        now: new Date("2026-11-20T00:00:00Z"),
      })
      const [good, broken] = result.summaries
      expect(readings.size).toBe(17)
      expect(bodies).toHaveLength(34)
      expect(good).toMatchObject({
        model: "vendor/good",
        nodeF1: 1,
        edgeF1: 1,
        edgeLabel: 1,
        groupF1: 1,
        membership: 1,
        direction: 1,
        order: 1,
        failed: 0,
        answeredBy: ["Alpha"],
        zdrEndpoints: ["alpha", "beta/fp8"],
        zdrProviders: ["Alpha", "Beta"],
      })
      expect(good?.costPerImageUsd).toBeCloseTo(0.01)
      // A failed call with no reported cost keeps the reserved cost.
      expect(broken).toMatchObject({
        failed: 17,
        edgeF1: null,
        costPerImageUsd: 0.25,
        zdrEndpoints: [],
      })
      expect(calls.spentUsd).toBeGreaterThan(0)
      const report = await readFile(join(out, "vision.md"), "utf8")
      expect(report).toContain("| vendor/good | 1.00 | 1.00 |")
      expect(report).toContain("2 (Alpha, Beta)")
      expect(
        await readFile(join(out, "vendor__good", "oauth-login.md"), "utf8"),
      ).toContain("sequenceDiagram")
    } finally {
      restore()
    }
  })
})
