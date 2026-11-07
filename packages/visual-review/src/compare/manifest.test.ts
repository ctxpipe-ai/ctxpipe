import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  baselinePath,
  diff,
  manifestJsonSchema,
  toStoryInput,
  writeManifest,
  writeStoryImages,
  type Manifest,
  type ManifestStory,
} from "../index.ts"
import { screenshot } from "./fixtures.ts"

const story: ManifestStory = {
  id: "connectors-connectorcard--connected",
  title: "Connectors/ConnectorCard",
  componentFile:
    "apps/ui/src/features/connectors/components/ConnectorCard.stories.tsx",
  scope: "component",
  viewport: "desktop",
  snapshot: null,
  baseline:
    "apps/ui/src/features/connectors/components/screenshots/ConnectorCard.Connected.desktop.screenshot.png",
  status: "changed",
  maxDiffPixels: 10,
  size: { width: 1440, height: 900 },
  diffPixels: 1440,
  regions: [
    {
      box: { x: 144, y: 450, width: 288, height: 90 },
      changeType: "color-change",
      position: "left",
      confidence: 0.9,
      pixels: 1440,
      stats: {
        shape: "solid-region",
        shapeStats: { fillRatio: 1 },
        colorDelta: { meanDelta: 0.3 },
        gradient: { edgeCorrelation: 1 },
        chroma: { chromaCos: -0.77 },
        signals: { denseFill: true, confidence: 1 },
      },
    },
  ],
  severity: "low",
  summary: "Colors changed: 1 region (left).",
  signature: "color-change@left:288x90",
  omittedRegions: 2,
  images: {
    regions: "connectors-connectorcard--connected/regions.png",
    locator: "connectors-connectorcard--connected/locator.png",
    before: "connectors-connectorcard--connected/before.png",
    after: "connectors-connectorcard--connected/after.png",
    diff: "connectors-connectorcard--connected/diff.png",
  },
}

const manifest: Manifest = {
  version: 1,
  run: {
    imageDigest: "sha256:0123",
    playwrightVersion: "1.58.0",
    viewports: {
      desktop: { width: 1440, height: 900 },
      mobile: { width: 390, height: 844 },
    },
    threshold: 0.1,
    commit: "abc123",
    baseRef: "origin/main",
  },
  stories: [story],
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "visual-manifest-"))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("manifest v1", () => {
  test("a written manifest reads back the same", async () => {
    const path = join(dir, "manifest.json")

    await writeManifest(path, manifest)

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(manifest)
  })

  test("a story with an unknown status is rejected", async () => {
    const bad = {
      ...manifest,
      stories: [{ ...story, status: "flaky" }],
    } as unknown as Manifest

    await expect(
      writeManifest(join(dir, "manifest.json"), bad),
    ).rejects.toThrow()
  })

  test("the JSON schema lists every story status", () => {
    const text = JSON.stringify(manifestJsonSchema)
    for (const status of [
      "unchanged",
      "changed",
      "new",
      "removed",
      "unstable",
      "play-failed",
      "size-changed",
    ]) {
      expect(text).toContain(`"${status}"`)
    }
  })
})

describe("baselinePath", () => {
  test("puts the baseline in a screenshots folder beside the story file", () => {
    expect(
      baselinePath({
        storyFile:
          "apps/ui/src/features/connectors/components/ConnectorCard.stories.tsx",
        storyName: "Connected",
        viewport: "desktop",
      }),
    ).toBe(
      "apps/ui/src/features/connectors/components/screenshots/ConnectorCard.Connected.desktop.screenshot.png",
    )
  })

  test("adds a named snapshot to the story name", () => {
    expect(
      baselinePath({
        storyFile: "src/ConnectorCard.stories.tsx",
        storyName: "Connected",
        snapshot: "menu-open",
        viewport: "mobile",
      }),
    ).toBe(
      "src/screenshots/ConnectorCard.Connected@menu-open.mobile.screenshot.png",
    )
  })
})

describe("toStoryInput", () => {
  test("gives the critic region boxes in fractions of the after image", () => {
    const input = toStoryInput(manifest, story, {
      root: "/repo/.ci-results/visual",
      brief: "Make the connected badge red.",
    })

    expect(input).toEqual({
      storyId: "connectors-connectorcard--connected",
      scope: "component",
      viewport: { width: 1440, height: 900 },
      regions: [
        {
          box: { x: 0.1, y: 0.5, width: 0.2, height: 0.1 },
          changeType: "color-change",
          position: "left",
          confidence: 0.9,
        },
      ],
      omittedRegions: 2,
      signature: "color-change@left:288x90",
      images: [
        {
          role: "regions",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/regions.png",
        },
        {
          role: "locator",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/locator.png",
        },
        {
          role: "before",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/before.png",
        },
        {
          role: "after",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/after.png",
        },
        {
          role: "diff",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/diff.png",
        },
      ],
      brief: "Make the connected badge red.",
    })
  })

  test.each([
    ["a ../ path", "../../secrets/key.png"],
    ["an absolute path", "/etc/hosts"],
  ])("rejects %s, which is outside the manifest folder", (_, path) => {
    expect(() =>
      toStoryInput(
        manifest,
        { ...story, images: { ...story.images, after: path } },
        { root: "/repo/.ci-results/visual" },
      ),
    ).toThrow(`Image path "${path}" is outside the manifest folder`)
  })

  test("the images that writeStoryImages wrote are the images of the critic", async () => {
    const before = screenshot(200, 120, [
      { box: { x: 120, y: 80, width: 60, height: 24 }, color: [37, 99, 235] },
    ])
    const after = screenshot(200, 120, [
      { box: { x: 120, y: 80, width: 60, height: 24 }, color: [220, 38, 38] },
    ])
    const comparison = await diff(before, after)
    if (comparison.status !== "changed") throw new Error(comparison.status)
    const { images } = await writeStoryImages(
      { root: dir, dir: story.id },
      before,
      after,
      comparison,
    )

    const input = toStoryInput(manifest, { ...story, images }, { root: dir })

    expect(input.images.map(({ role }) => role)).toEqual([
      "regions",
      "locator",
      "before",
      "after",
      "diff",
    ])
    for (const { path } of input.images) {
      expect(path.startsWith(join(dir, story.id))).toBe(true)
      expect((await stat(path)).isFile()).toBe(true)
    }
  })
})
