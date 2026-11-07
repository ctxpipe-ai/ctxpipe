import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join, posix } from "node:path"

import { z } from "zod"

import {
  changeTypes,
  positions,
  type StoryImage,
  type StoryInput,
} from "../story.ts"

const count = z.number().int().nonnegative()
const size = z.object({ width: count, height: count })
const viewport = z.enum(["desktop", "mobile"])
const roles = ["regions", "locator", "before", "after", "diff"] as const

const storySchema = z.object({
  /** The Storybook story id. */
  id: z.string(),
  title: z.string(),
  /** The story file, from the repository root. */
  componentFile: z.string(),
  /** `page` for a story with the `page` tag; else a part of the UI. */
  scope: z.enum(["page", "component"]),
  viewport,
  /** The named snapshot, or null for the screenshot after the play. */
  snapshot: z.string().nullable(),
  /** The committed baseline PNG, from the repository root. */
  baseline: z.string(),
  status: z.enum([
    "unchanged",
    "changed",
    "new",
    "removed",
    "unstable",
    "play-failed",
    "size-changed",
  ]),
  maxDiffPixels: count,
  /** The size of the new screenshot. Null when there is none. */
  size: size.nullable(),
  /** Null when no pixel diff ran. */
  diffPixels: count.nullable(),
  /** In pixels of the new screenshot, largest first. */
  regions: z.array(
    z.object({
      box: z.object({ x: count, y: count, width: count, height: count }),
      changeType: z.enum(changeTypes).nullable(),
      position: z.enum(positions),
      confidence: z.number().min(0).max(1),
      pixels: count,
      /** The interpreter statistics. Null for a fallback region. */
      stats: z
        .object({
          shape: z.string(),
          shapeStats: z.record(z.string(), z.number()),
          colorDelta: z.record(z.string(), z.number()),
          gradient: z.record(z.string(), z.number()),
          chroma: z.record(z.string(), z.number()),
          signals: z.record(z.string(), z.union([z.number(), z.boolean()])),
        })
        .nullable(),
    }),
  ),
  severity: z.enum(["none", "low", "medium", "high"]).nullable(),
  summary: z.string().nullable(),
  /** Change types, positions and sizes of the regions, to group stories. */
  signature: z.string().nullable(),
  /**
   * The count of regions with no row in `regions.png`: the last, smallest
   * regions of `regions`. They are in `diff.png` and `locator.png`.
   */
  omittedRegions: count,
  /** Image files, from the folder of the manifest. */
  images: z.partialRecord(z.enum(roles), z.string()),
})

const manifestSchema = z.object({
  version: z.literal(1),
  run: z.object({
    /** The digest of the capture container image. */
    imageDigest: z.string().nullable(),
    playwrightVersion: z.string(),
    viewports: z.object({ desktop: size, mobile: size }),
    /** The pixelmatch color threshold. */
    threshold: z.number().min(0).max(1),
    commit: z.string(),
    /** The ref of the baselines. Null for a run with no base. */
    baseRef: z.string().nullable(),
  }),
  stories: z.array(storySchema),
})

/** `.ci-results/visual/manifest.json`: one visual run and all its stories. */
export type Manifest = z.infer<typeof manifestSchema>
export type ManifestStory = z.infer<typeof storySchema>

/** The JSON Schema of manifest v1. */
export const manifestJsonSchema = z.toJSONSchema(manifestSchema)

/** Check the manifest against the schema, then write it. */
export async function writeManifest(
  path: string,
  manifest: Manifest,
): Promise<void> {
  const valid = manifestSchema.parse(manifest)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(valid, null, 2)}\n`)
}

/**
 * The committed baseline of a story screenshot:
 * `<story file dir>/screenshots/<storyfile>.<storyname>[@<snapshot>].<viewport>.screenshot.png`.
 */
export function baselinePath({
  storyFile,
  storyName,
  snapshot,
  viewport,
}: {
  /** The story file, from the repository root. */
  storyFile: string
  /** The export name of the story. */
  storyName: string
  snapshot?: string
  viewport: "desktop" | "mobile"
}): string {
  const stem = posix.basename(storyFile).replace(/\.stories\.tsx$/, "")
  const name = snapshot ? `${storyName}@${snapshot}` : storyName
  return posix.join(
    posix.dirname(storyFile),
    "screenshots",
    `${stem}.${name}.${viewport}.screenshot.png`,
  )
}

/**
 * The critic input of one manifest story. The critic takes region boxes in
 * fractions (0..1) of the after image; this is where the pixel boxes of the
 * manifest change to fractions. `root` is the folder of the manifest.
 */
export function toStoryInput(
  manifest: Manifest,
  story: ManifestStory,
  {
    root,
    brief,
    sourceDiff,
  }: { root: string; brief?: string; sourceDiff?: string },
): StoryInput {
  const { width, height } = story.size ?? manifest.run.viewports[story.viewport]
  const images: StoryImage[] = []
  for (const role of roles) {
    const path = story.images[role]
    if (path) images.push({ role, path: join(root, path) })
  }
  return {
    storyId: story.id,
    scope: story.scope,
    viewport: manifest.run.viewports[story.viewport],
    regions: story.regions.map(({ box, changeType, position, confidence }) => ({
      box: {
        x: box.x / width,
        y: box.y / height,
        width: box.width / width,
        height: box.height / height,
      },
      changeType,
      position,
      confidence,
    })),
    images,
    ...(brief === undefined ? {} : { brief }),
    ...(sourceDiff === undefined ? {} : { sourceDiff }),
  }
}
