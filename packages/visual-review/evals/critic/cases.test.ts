import { readFileSync } from "node:fs"

import { describe, expect, test } from "vitest"

import { caseManifestJsonSchema, caseManifestSchema } from "./cases.ts"

const sha = (digit: string) => digit.repeat(40)
const viewport = { name: "desktop", width: 1440, height: 900 } as const
const images = (id: string) => ({
  before: `cases/${id}/before.png`,
  after: `cases/${id}/after.png`,
})

const manifest = {
  $schema: "./cases.schema.json",
  version: 1,
  seed: 1,
  until: sha("a"),
  container: "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:0",
  cases: [
    {
      id: "intended-001",
      kind: "intended",
      label: "intended",
      class: null,
      brief: "Show the sync time on the connector card",
      commit: { sha: sha("b"), parent: sha("c") },
      storyId: "connectors-connectorcard--connected",
      viewport,
      region: null,
      diffPixels: 812,
      images: images("intended-001"),
    },
    {
      id: "regression-padding-01",
      kind: "regression",
      label: "regression",
      class: "padding",
      brief: null,
      commit: null,
      storyId: "connectors-connectorcard--connected",
      viewport,
      region: { x: 98, y: 98, width: 324, height: 44 },
      diffPixels: 2200,
      images: images("regression-padding-01"),
    },
    {
      id: "noise-subpixel-shift-01",
      kind: "noise",
      label: "noise",
      class: "subpixel-shift",
      brief: null,
      commit: null,
      storyId: "connectors-connectorcard--connected",
      viewport,
      region: null,
      diffPixels: 40,
      images: images("noise-subpixel-shift-01"),
    },
    {
      id: "mixed-01",
      kind: "mixed",
      label: "regression",
      class: "contrast-loss",
      brief: "Show the sync time on the connector card",
      commit: { sha: sha("b"), parent: sha("c") },
      storyId: "connectors-connectorcard--connected",
      viewport,
      region: { x: 10, y: 10, width: 80, height: 24 },
      diffPixels: 900,
      images: images("mixed-01"),
    },
  ],
}

describe("caseManifestSchema", () => {
  test("accepts a case of each kind", () => {
    expect(caseManifestSchema.parse(manifest).cases).toHaveLength(4)
  })

  test("a synthetic regression must have a known region", () => {
    const broken = structuredClone(manifest)
    broken.cases[1]!.region = null
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })

  test("a mixed case must name its hidden regression class", () => {
    const broken = structuredClone(manifest)
    broken.cases[3]!.class = "rendering"
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })

  test("an intended case must have a brief and a commit", () => {
    const broken = structuredClone(manifest)
    broken.cases[0]!.brief = null
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })

  test("refuses two cases with one id", () => {
    const broken = structuredClone(manifest)
    broken.cases[2]!.id = "intended-001"
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })

  test("refuses an image path outside the output folder", () => {
    const broken = structuredClone(manifest)
    broken.cases[0]!.images.after = "../secret.png"
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })
})

describe("the committed case manifest", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"))

  test("its JSON schema is the schema of the code", () => {
    expect(read("./cases.schema.json")).toEqual(caseManifestJsonSchema)
  })

  test("has at least 150 cases, and a known region for each synthetic one", () => {
    const { cases } = caseManifestSchema.parse(read("./cases.json"))
    expect(cases.length).toBeGreaterThanOrEqual(150)
    const kinds = new Set(cases.map((entry) => entry.kind))
    expect(kinds).toEqual(new Set(["intended", "regression", "noise", "mixed"]))
  })
})
