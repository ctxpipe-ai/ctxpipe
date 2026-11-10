// Every route has a page story, or an exemption with a reason
// (apps/ui/AGENTS.md, "Page stories").
//
// A page story has the `page` tag and a string `parameters.route` with the
// TanStack route id. Both can be in the `meta` of the story file, or in one
// story (a story's own route wins, and `"!page"` in its tags removes the tag
// that it gets from the `meta`). The route ids are the keys of `FileRoutesById`
// in `apps/ui/src/routeTree.gen.ts`.
//
// The check fails when:
//   - a route has no page story and no exemption;
//   - a page story has no route, or names a route that does not exist;
//   - an exemption has no reason, names a route that does not exist, or names
//     a route that also has a page story.
//
// A layout, a redirect relay or an API route has no page. Its exemption in
// `scripts/ci/page-story-exemptions.json` gives the reason. A page that is too
// costly to story today gets the reason `backfill: <why>`.
//
// Usage: node scripts/ci/check-page-stories.mjs [repo root]   (default: this repo)

import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { csfTools } from "../../apps/ui/.storybook/check-modules.mjs"
import { storiesOf } from "../../packages/visual-review/src/story-tags.ts"

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
)
const { loadCsf } = await csfTools()

function storyFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : storyFiles(path)
    return /\.stories\.tsx?$/.test(entry.name) ? [path] : []
  })
}

const ids = [
  ...readFileSync(join(root, "apps/ui/src/routeTree.gen.ts"), "utf8")
    .match(/interface FileRoutesById \{([^}]*)\}/)?.[1]
    .matchAll(/^\s*'?([^':\s]+)'?\s*:/gm),
].map((match) => match[1])
const exemptions = JSON.parse(
  readFileSync(join(root, "scripts/ci/page-story-exemptions.json"), "utf8"),
)
const errors = []
const covered = new Set()
for (const path of storyFiles(join(root, "apps/ui/src"))) {
  const file = relative(root, path)
  for (const story of storiesOf(loadCsf, file, readFileSync(path, "utf8"))) {
    if (!story.page) continue
    const where = `${file}: story "${story.name}"`
    if (!story.route)
      errors.push(
        `${where} has the page tag and no string literal parameters.route. Name the TanStack route id.`,
      )
    else if (!ids.includes(story.route))
      errors.push(
        `${where} names ${story.route}, which routeTree.gen.ts does not have.`,
      )
    else covered.add(story.route)
  }
}
for (const id of ids) {
  if (!covered.has(id) && !(id in exemptions))
    errors.push(
      `${id} has no page story. Add a story with tags: ["page"] and parameters.route: "${id}", or add an exemption with a reason to scripts/ci/page-story-exemptions.json.`,
    )
}
for (const [id, reason] of Object.entries(exemptions)) {
  if (!ids.includes(id))
    errors.push(
      `page-story-exemptions.json: the exemption names ${id}, which is not a route. Remove it.`,
    )
  else if (typeof reason !== "string" || !reason.trim())
    errors.push(
      `page-story-exemptions.json: the exemption for ${id} has no reason.`,
    )
  else if (covered.has(id))
    errors.push(
      `page-story-exemptions.json: ${id} has a page story and an exemption. Remove the exemption.`,
    )
}
for (const error of errors) console.error(error)
if (errors.length) process.exit(1)
console.log("Page story check passed.")
