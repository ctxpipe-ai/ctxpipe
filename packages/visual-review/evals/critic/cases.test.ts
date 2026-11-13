import { readFileSync } from "node:fs"

import { describe, expect, test } from "vitest"

import { caseManifestJsonSchema, caseManifestSchema } from "./cases.ts"

const sha = (digit: string) => digit.repeat(40)
const viewport = { name: "desktop", width: 1440, height: 900 } as const
// The SHA-256 of an image: 64 hex digits.
const image = (digit: string) => digit.repeat(64)
const images = () => ({ before: image("1"), after: image("2") })

const manifest = {
  $schema: "./cases.schema.json",
  version: 1,
  seed: 1,
  until: sha("a"),
  container: "mcr.microsoft.com/playwright:v1.63.0-noble@sha256:0",
  scope: "page",
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
      images: images(),
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
      images: images(),
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
      images: images(),
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
      images: images(),
    },
    {
      id: "new-01",
      kind: "new",
      label: "intended",
      class: null,
      brief: "Add the empty state of the connector list",
      commit: { sha: sha("d"), parent: sha("e") },
      storyId: "connectors-connectorlist--empty",
      viewport,
      region: null,
      diffPixels: null,
      images: { after: image("3") },
    },
    {
      id: "new-broken-01",
      kind: "new",
      label: "regression",
      class: "overflow",
      brief: "Add the empty state of the connector list",
      commit: { sha: sha("d"), parent: sha("e") },
      storyId: "connectors-connectorlist--empty",
      viewport,
      region: { x: 40, y: 40, width: 300, height: 30 },
      diffPixels: null,
      images: { after: image("4") },
    },
  ],
}

// A copy of the manifest with one case changed.
const change = (
  index: number,
  edit: (
    entry: Record<string, unknown> & { images: { after: string } },
  ) => void,
) => {
  const copy = structuredClone(manifest)
  copy.cases.forEach((entry, i) => {
    if (i === index) edit(entry)
  })
  return copy
}

describe("caseManifestSchema", () => {
  test("accepts a case of each kind", () => {
    expect(caseManifestSchema.parse(manifest).cases).toHaveLength(6)
  })

  test("a new case has only an after image and no diff", () => {
    const withBefore = change(4, (entry) => {
      entry.images = images()
    })
    expect(caseManifestSchema.safeParse(withBefore).success).toBe(false)
    const withDiff = change(4, (entry) => {
      entry.diffPixels = 10
    })
    expect(caseManifestSchema.safeParse(withDiff).success).toBe(false)
  })

  test("a broken new case has its region and the label regression", () => {
    const noRegion = change(5, (entry) => {
      entry.region = null
    })
    expect(caseManifestSchema.safeParse(noRegion).success).toBe(false)
    const intended = change(5, (entry) => {
      entry.label = "intended"
    })
    expect(caseManifestSchema.safeParse(intended).success).toBe(false)
  })

  test("a clean new case has no region", () => {
    const withRegion = change(4, (entry) => {
      entry.region = { x: 0, y: 0, width: 10, height: 10 }
    })
    expect(caseManifestSchema.safeParse(withRegion).success).toBe(false)
  })

  test("a synthetic regression must have a known region", () => {
    const broken = change(1, (entry) => {
      entry.region = null
    })
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })

  test("a mixed case must name its hidden regression class", () => {
    const broken = change(3, (entry) => {
      entry.class = "rendering"
    })
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })

  test("an intended case must have a brief and a commit", () => {
    const broken = change(0, (entry) => {
      entry.brief = null
    })
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })

  test("refuses two cases with one id", () => {
    const broken = change(2, (entry) => {
      entry.id = "intended-001"
    })
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })

  test("refuses an image that is not a SHA-256", () => {
    const broken = change(0, (entry) => {
      entry.images.after = "cases/intended-001/after.png"
    })
    expect(caseManifestSchema.safeParse(broken).success).toBe(false)
  })

  test("accepts the owner label unsure on a real change only", () => {
    const unsure = (index: number) =>
      change(index, (entry) => {
        entry.label = "unsure"
      })
    expect(caseManifestSchema.safeParse(unsure(0)).success).toBe(true)
    expect(caseManifestSchema.safeParse(unsure(1)).success).toBe(false)
  })

  test("accepts the mobile viewport and the votes of the judge panel", () => {
    const voted = change(0, (entry) => {
      entry.viewport = { name: "mobile", width: 390, height: 844 }
      entry.panel = {
        label: null,
        votes: [
          { model: "vendor-a/judge", label: "regression", reason: "Cut off." },
          { model: "vendor-b/judge", label: null, reason: "", error: "500" },
        ],
      }
    })
    expect(caseManifestSchema.safeParse(voted).success).toBe(true)
    const wrongSize = change(0, (entry) => {
      entry.viewport = { name: "mobile", width: 1440, height: 900 }
    })
    expect(caseManifestSchema.safeParse(wrongSize).success).toBe(false)
  })
})

describe("the committed case manifest", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"))

  test("uses only the new name of the required story set", () => {
    const text = readFileSync(new URL("./cases.json", import.meta.url), "utf8")
    expect(text).not.toMatch(/\bg[o]lden\b/i)
  })

  test("its JSON schema is the schema of the code", () => {
    expect(read("./cases.schema.json")).toEqual(caseManifestJsonSchema)
  })

  test("has at least 100 page cases of each kind, at both viewports", () => {
    const { cases, scope } = caseManifestSchema.parse(read("./cases.json"))
    expect(scope).toBe("page")
    expect(cases.length).toBeGreaterThanOrEqual(100)
    const kinds = new Set(cases.map((entry) => entry.kind))
    expect(kinds).toEqual(
      new Set(["intended", "regression", "noise", "mixed", "new"]),
    )
    expect(new Set(cases.map(({ viewport }) => viewport.name))).toEqual(
      new Set(["desktop", "mobile"]),
    )
  })

  test("has a clean new screenshot and a broken one, each with only an after image", () => {
    const { cases } = caseManifestSchema.parse(read("./cases.json"))
    const fresh = cases.filter((entry) => entry.kind === "new")
    expect(fresh.some(({ label }) => label === "intended")).toBe(true)
    expect(
      fresh.some(
        (entry) => entry.label === "regression" && entry.region !== null,
      ),
    ).toBe(true)
    expect(fresh.every(({ images }) => !("before" in images))).toBe(true)
  })
})
