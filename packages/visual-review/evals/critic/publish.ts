// Publishes the case images of the bake-off (CTX-1201): each image of the
// case manifest is one asset of the public release `visual-bakeoff-images`,
// named <sha256>.png. An asset that is in the release already does not go up
// again. See README.md beside this file.
//
// Usage: pnpm visual:bakeoff:publish [--images <dir>] [--cases <path>]
//
// It needs the GitHub CLI, signed in with the right to write releases.

import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { parseArgs, promisify } from "node:util"

import { caseManifestSchema } from "./cases.ts"
import { imageFile, imageRelease, sha256Of } from "./images.ts"

/** Runs the GitHub CLI with `args` and gives its standard output. */
type Gh = (args: readonly string[]) => Promise<string>

const usage = `Usage: pnpm visual:bakeoff:publish [--images <dir>] [--cases <path>]

  --images  The folder of the case images, as <sha256>.png (the images
            folder of pnpm visual:bakeoff:build).
            Default: .ci-results/visual-bakeoff/images
  --cases   The case manifest. Default: cases.json beside this file.`

/**
 * Upload each image of the manifest that the release does not have. Creates
 * the release (a pre-release on main) when it does not exist. Returns the
 * exit code: 2 for a usage error, or an image that is missing or does not
 * have its SHA-256. Then nothing goes up.
 */
export async function publish(
  args: readonly string[],
  print: (text: string) => void,
  gh: Gh,
): Promise<number> {
  let options
  try {
    ;({ values: options } = parseArgs({
      args: [...args],
      strict: true,
      options: {
        images: {
          type: "string",
          default: ".ci-results/visual-bakeoff/images",
        },
        cases: { type: "string" },
      },
    }))
  } catch (error) {
    print(`${(error as Error).message}\n\n${usage}`)
    return 2
  }
  const manifest = caseManifestSchema.parse(
    JSON.parse(
      await readFile(
        resolve(options.cases ?? join(import.meta.dirname, "cases.json")),
        "utf8",
      ),
    ),
  )
  const hashes = new Set(
    manifest.cases.flatMap(({ images }) => Object.values(images)),
  )
  const paths = new Map<string, string>()
  for (const sha256 of hashes) {
    const path = join(resolve(options.images), imageFile(sha256))
    const bytes = await readFile(path).catch(() => undefined)
    if (!bytes || sha256Of(bytes) !== sha256) {
      print(
        `${path} is missing or does not have its SHA-256. Run pnpm visual:bakeoff:build first. Nothing went up.`,
      )
      return 2
    }
    paths.set(sha256, path)
  }

  const { repo, tag } = imageRelease
  const names = await gh([
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "assets",
    "--jq",
    ".assets[].name",
  ]).catch(async (error: Error) => {
    if (!/release not found/i.test(error.message)) throw error
    await gh([
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--target",
      "main",
      "--prerelease",
      "--title",
      "Visual critic bake-off images",
      "--notes",
      "Images of the visual-critic bake-off dataset; screenshots of Storybook stories with mock data. Each asset is one image of packages/visual-review/evals/critic/cases.json, named by its SHA-256.",
    ])
    return ""
  })
  const present = new Set(names.split("\n").filter(Boolean))
  const missing = [...paths]
    .filter(([sha256]) => !present.has(imageFile(sha256)))
    .map(([, path]) => path)
  // Some files for each call, so that one command line stays short.
  for (let start = 0; start < missing.length; start += 25)
    await gh([
      "release",
      "upload",
      tag,
      "--repo",
      repo,
      ...missing.slice(start, start + 25),
    ])
  print(
    `${missing.length} images uploaded, ${hashes.size - missing.length} already in ${repo} release ${tag}.`,
  )
  return 0
}

if (import.meta.main) {
  const run = promisify(execFile)
  process.exitCode = await publish(
    process.argv.slice(2),
    (text) => process.stdout.write(`${text}\n`),
    async (args) =>
      (await run("gh", [...args], { maxBuffer: 16 * 1024 * 1024 })).stdout,
  )
}
