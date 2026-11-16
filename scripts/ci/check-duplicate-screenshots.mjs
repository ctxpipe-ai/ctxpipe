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

import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { join, posix, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { csfTools } from "../../apps/ui/.storybook/check-modules.mjs"
import { visualOptions } from "../checks/visual.mjs"

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
)
const { loadCsf } = await csfTools()
// The PNG codec of the compare engine, from the package that depends on it.
const { decode } = createRequire(
  new URL("../../packages/visual-review/package.json", import.meta.url),
)("@blazediff/codec-png-native")

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
// The baselines of each set of pixels (the size and the color of each pixel,
// so another PNG encoding of the same pixels is the same). A set fails when
// two or more of its stories have no duplicate reason. Two baselines of one
// story (a named snapshot and the end state) are not a duplicate.
const bySame = new Map()
for (const { path, file, exportName } of found) {
  const { data, width, height } = decode(readFileSync(join(root, path)))
  const key = createHash("sha256")
    .update(`${width}x${height}:`)
    .update(data)
    .digest("hex")
  bySame.set(key, [
    ...(bySame.get(key) ?? []),
    { path, story: `${file}#${exportName}` },
  ])
}
const groups = [...bySame.values()]
  .filter(
    (group) =>
      new Set(
        group
          .filter(({ story }) => !options.get(story)?.duplicate)
          .map(({ story }) => story),
      ).size > 1,
  )
  .map((group) => group.map(({ path }) => path).sort())
for (const group of groups)
  console.error(
    `These screenshots of different stories have the same pixels:\n${group.map((path) => `  ${path}`).join("\n")}\nKeep one story for each UI state (Storybook skill, "One story for each state"). Delete a story that repeats another. Give a behavior test that ends in the same state parameters.visual.skip with a reason. Only when two stories must look the same, give the second one parameters.visual.duplicate with a reason.`,
  )
if (groups.length) process.exit(1)
console.log(
  `Duplicate screenshot check passed (${found.length} baselines of ${entries.length} stories).`,
)
