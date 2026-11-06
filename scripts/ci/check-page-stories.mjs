// Every route has a page story, or an exemption with a reason
// (apps/ui/AGENTS.md, "Page stories").
//
// A page story has the `page` tag and a string `parameters.route` with the
// TanStack route id. Both can be in the `meta` of the story file, or in one
// story (a story's own route wins). The route ids are the keys of
// `FileRoutesById` in `apps/ui/src/routeTree.gen.ts`.
//
// The check fails when:
//   - a route has no page story and no exemption;
//   - a page story has no route, or names a route that does not exist;
//   - a story names a route and has no `page` tag;
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

function storyFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory())
      return entry.name === "node_modules" ? [] : storyFiles(path)
    return /\.stories\.tsx?$/.test(entry.name) ? [path] : []
  })
}

/** The route ids: the keys of the `FileRoutesById` interface. */
function routeIds(routeTree) {
  const body = routeTree.match(/interface FileRoutesById \{([^}]*)\}/)?.[1]
  if (body === undefined) throw new Error("routeTree.gen.ts has no FileRoutesById")
  return [...body.matchAll(/^\s*'?([^':\s]+)'?\s*:/gm)].map((match) => match[1])
}

/** The strings of an array node, or `[]`. */
const stringsOf = (node) =>
  node?.type === "ArrayExpression"
    ? node.elements.flatMap((element) =>
        element?.type === "StringLiteral" ? [element.value] : [],
      )
    : []

/** The value node of `parameters.route` in an annotations object, or undefined. */
function routeOf(annotations) {
  const route = annotations?.parameters?.properties?.find(
    (property) =>
      property.type === "ObjectProperty" &&
      (property.key.name ?? property.key.value) === "route",
  )
  return route?.value
}

/** Each story of a story file: its export name, page tag and route. */
function storiesOf(file, loadCsf, code) {
  const csf = loadCsf(code, {
    fileName: file,
    makeTitle: (title) => title ?? file,
  }).parse()
  const meta = csf._metaAnnotations
  const metaTags = stringsOf(meta.tags)
  const metaRoute = routeOf(meta)
  return Object.keys(csf._stories).map((name) => {
    const annotations = csf._storyAnnotations[name]
    const route = routeOf(annotations) ?? metaRoute
    return {
      name,
      page: [...metaTags, ...stringsOf(annotations?.tags)].includes("page"),
      // The route, when it is a string literal.
      route: route?.type === "StringLiteral" ? route.value : null,
      declaresRoute: Boolean(route),
    }
  })
}

async function check(root) {
  const { loadCsf } = await csfTools()
  const ids = routeIds(
    readFileSync(join(root, "apps/ui/src/routeTree.gen.ts"), "utf8"),
  )
  const exemptions = JSON.parse(
    readFileSync(join(root, "scripts/ci/page-story-exemptions.json"), "utf8"),
  )
  const errors = []
  const covered = new Set()
  for (const path of storyFiles(join(root, "apps/ui/src"))) {
    const file = relative(root, path)
    for (const story of storiesOf(file, loadCsf, readFileSync(path, "utf8"))) {
      const where = `${file}: story "${story.name}"`
      if (story.page && !story.route)
        errors.push(
          `${where} has the page tag and no string literal parameters.route. Name the TanStack route id.`,
        )
      else if (story.page && !ids.includes(story.route))
        errors.push(
          `${where} names ${story.route}, which routeTree.gen.ts does not have.`,
        )
      else if (story.page) covered.add(story.route)
      else if (story.declaresRoute)
        errors.push(
          `${where} names a route and has no page tag. Add tags: ["page"] or remove the route.`,
        )
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
      errors.push(`page-story-exemptions.json: the exemption for ${id} has no reason.`)
    else if (covered.has(id))
      errors.push(
        `page-story-exemptions.json: ${id} has a page story and an exemption. Remove the exemption.`,
      )
  }
  return errors
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(
    process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
  )
  const errors = await check(root)
  for (const error of errors) console.error(error)
  if (errors.length) process.exit(1)
  console.log("Page story check passed.")
}
