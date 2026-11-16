// Each story shows its own UI state (the Storybook skill, "One story for each
// state"). This check fails when committed baselines of two different stories
// have the same pixels.
//
// A baseline is <dir>/screenshots/<story file stem>.<export>[@<snapshot>].<viewport>.screenshot.png
// beside the story file <dir>/<story file stem>.stories.tsx. A story with
// `parameters.visual.duplicate: "<reason>"` may have the same pixels as one
// other story. A baseline with no story file is an orphan; `pnpm visual:check`
// reports it, so this check does not read it.
//
// Usage: node scripts/ci/check-duplicate-screenshots.mjs [repo root]   (default: this repo)

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { csfTools } from "../../apps/ui/.storybook/check-modules.mjs"
import { duplicateBaselines } from "../../packages/visual-review/src/compare/duplicates.ts"
import { visualOptions } from "../checks/visual.mjs"

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
)
const { loadCsf } = await csfTools()

/** Each baseline under `dir` (from the repository root), with its story. */
function baselines(dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = posix.join(dir, entry.name)
      if (entry.isDirectory())
        return entry.name === "node_modules" ? [] : baselines(path)
      const name = /^(.+)\.([A-Za-z_$][\w$]*)(?:@[a-z0-9-]+)?\.(?:desktop|mobile)\.screenshot\.png$/.exec(
        entry.name,
      )
      if (!name || posix.basename(dir) !== "screenshots") return []
      const file = posix.join(posix.dirname(dir), `${name[1]}.stories.tsx`)
      if (!existsSync(join(root, file))) return []
      return [{ path, file, exportName: name[2] }]
    },
  )
}

const found = baselines("apps/ui/src")
// The screenshot options of each story, read as `pnpm visual:check` reads them.
const entries = [
  ...new Map(
    found.map(({ file, exportName }) => [
      `${file}#${exportName}`,
      {
        type: "story",
        id: `${file}#${exportName}`,
        importPath: `./${posix.relative("apps/ui", file)}`,
        exportName,
      },
    ]),
  ).values(),
]
const options = visualOptions(entries, loadCsf, (file) =>
  readFileSync(join(root, file), "utf8"),
)
const groups = duplicateBaselines(
  found.map(({ path, file, exportName }) => {
    const story = `${file}#${exportName}`
    return {
      path,
      story,
      png: readFileSync(join(root, path)),
      duplicate: options.get(story)?.duplicate,
    }
  }),
)
for (const group of groups)
  console.error(
    `These screenshots of different stories have the same pixels:\n${group.map((path) => `  ${path}`).join("\n")}\nKeep one story for each UI state (Storybook skill, "One story for each state"). Delete a story that repeats another. Give a behavior test that ends in the same state parameters.visual.skip with a reason. Only when two stories must look the same, give the second one parameters.visual.duplicate with a reason.`,
  )
if (groups.length) process.exit(1)
console.log(
  `Duplicate screenshot check passed (${found.length} baselines of ${entries.length} stories).`,
)
