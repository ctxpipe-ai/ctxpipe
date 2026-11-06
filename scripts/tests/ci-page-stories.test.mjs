import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const routeTree = (ids) => `export interface FileRoutesById {
  __root__: typeof rootRouteImport
${ids.map((id) => `  '${id}': typeof SomeRoute`).join("\n")}
}
export interface FileRouteTypes {
  fileRoutesById: FileRoutesById
}
`

const pageStory = (route, extra = "") => `
const meta = {
  title: "Pages/Example",
  tags: ["page"],
  parameters: { route: ${JSON.stringify(route)} },
}
export default meta
export const Loaded = { render: () => null }
${extra}
`

/** Runs the check on a fixture repo: a route tree, story files, exemptions. */
function check({ routes, stories = {}, exemptions = {} }) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-page-stories-"))
  try {
    const files = {
      "apps/ui/src/routeTree.gen.ts": routeTree(routes),
      "scripts/ci/page-story-exemptions.json": JSON.stringify(exemptions),
      ...Object.fromEntries(
        Object.entries(stories).map(([name, text]) => [
          `apps/ui/src/${name}`,
          text,
        ]),
      ),
    }
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true })
      writeFileSync(join(root, name), text)
    }
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../ci/check-page-stories.mjs", import.meta.url)),
        root,
      ],
      { encoding: "utf8" },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const rootReason = { __root__: "layout: the document shell, no page" }

test("a route with a page story, and an exempt root, passes", () => {
  const result = check({
    routes: ["/connectors"],
    stories: { "routes/-connectors.stories.tsx": pageStory("/connectors") },
    exemptions: rootReason,
  })
  assert.equal(result.status, 0, result.stderr)
})

test("a new route with no page story and no exemption fails", () => {
  const result = check({
    routes: ["/connectors", "/billing"],
    stories: { "routes/-connectors.stories.tsx": pageStory("/connectors") },
    exemptions: rootReason,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\/billing has no page story/)
})

test("an exempt route with a reason passes", () => {
  const result = check({
    routes: ["/relay"],
    exemptions: {
      ...rootReason,
      "/relay": "redirect relay: no page of its own",
    },
  })
  assert.equal(result.status, 0, result.stderr)
})

test("an exemption with no reason fails", () => {
  const result = check({
    routes: ["/relay"],
    exemptions: { ...rootReason, "/relay": "  " },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /exemption for \/relay has no reason/)
})

test("an exemption for a route that does not exist fails", () => {
  const result = check({
    routes: [],
    exemptions: { ...rootReason, "/gone": "removed route" },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /exemption names \/gone, which is not a route/)
})

test("an exemption for a route that has a page story fails", () => {
  const result = check({
    routes: ["/connectors"],
    stories: { "routes/-connectors.stories.tsx": pageStory("/connectors") },
    exemptions: { ...rootReason, "/connectors": "no page" },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\/connectors has a page story and an exemption/)
})

test("a page story that names a route that does not exist fails", () => {
  const result = check({
    routes: [],
    stories: { "routes/-old.stories.tsx": pageStory("/old") },
    exemptions: rootReason,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /-old\.stories\.tsx.*names \/old/)
})

test("a page story with no route fails", () => {
  const result = check({
    routes: [],
    stories: {
      "routes/-lost.stories.tsx": `
export default { title: "Pages/Lost", tags: ["page"] }
export const Loaded = { render: () => null }
`,
    },
    exemptions: rootReason,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /story "Loaded" has the page tag/)
})

test("a story that names a route without the page tag fails", () => {
  const result = check({
    routes: ["/connectors"],
    stories: {
      "routes/-connectors.stories.tsx": `
export default { title: "Pages/Connectors", tags: ["page"], parameters: { route: "/connectors" } }
export const Loaded = { render: () => null }
export const Part = { tags: [], parameters: { route: "/connectors" } }
`,
      "components/-part.stories.tsx": `
export default { title: "Components/Part" }
export const Part = { parameters: { route: "/connectors" } }
`,
    },
    exemptions: rootReason,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /-part\.stories\.tsx.*story "Part" names a route/)
})

test("a story route overrides the route of its file", () => {
  const result = check({
    routes: ["/ws", "/ws/new"],
    stories: {
      "features/-ws.stories.tsx": pageStory(
        "/ws",
        `export const Create = { parameters: { route: "/ws/new" } }`,
      ),
    },
    exemptions: rootReason,
  })
  assert.equal(result.status, 0, result.stderr)
})

test("a page tag on one story covers its route", () => {
  const result = check({
    routes: ["/sign-in", "/device"],
    stories: {
      "routes/-auth.stories.tsx": `
export default { title: "Pages/Auth" }
export const SignIn = { tags: ["page"], parameters: { route: "/sign-in" } }
export const Device = { tags: ["page"], parameters: { route: "/device" } }
export const Part = { render: () => null }
`,
    },
    exemptions: rootReason,
  })
  assert.equal(result.status, 0, result.stderr)
})
