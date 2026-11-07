import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, test } from "vitest"

import {
  baselinePath,
  manifestJsonSchema,
  readManifest,
  storyDir,
  toStoryInput,
  writeManifest,
  type Manifest,
  type ManifestStory,
} from "../index.ts"

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
    },
  ],
  severity: "low",
  summary: "Colors changed: 1 region (left).",
  signature: "color-change@left:288x90",
  omittedRegions: 2,
  labeler: "interpreter",
  images: {
    regions: "connectors-connectorcard--connected/desktop/regions.png",
    locator: "connectors-connectorcard--connected/desktop/locator.png",
    before: "connectors-connectorcard--connected/desktop/before.png",
    after: "connectors-connectorcard--connected/desktop/after.png",
    diff: "connectors-connectorcard--connected/desktop/diff.png",
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

    expect(await readManifest(path)).toEqual(manifest)
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1)
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

describe("storyDir", () => {
  test("is the story id, then the viewport and the snapshot", () => {
    expect(storyDir({ storyId: "a--b", viewport: "desktop" })).toBe(
      "a--b/desktop",
    )
    expect(
      storyDir({ storyId: "a--b", viewport: "mobile", snapshot: "menu-open" }),
    ).toBe("a--b/mobile@menu-open")
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
      images: [
        {
          role: "regions",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/desktop/regions.png",
        },
        {
          role: "locator",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/desktop/locator.png",
        },
        {
          role: "before",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/desktop/before.png",
        },
        {
          role: "after",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/desktop/after.png",
        },
        {
          role: "diff",
          path: "/repo/.ci-results/visual/connectors-connectorcard--connected/desktop/diff.png",
        },
      ],
      brief: "Make the connected badge red.",
    })
  })
})
