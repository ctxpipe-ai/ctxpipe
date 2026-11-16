import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(
  new URL("../ci/check-storybook-globals.mjs", import.meta.url),
)

/** Runs the check on a fixture repo with these files under apps/ui/.storybook. */
function check(files) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-storybook-globals-"))
  try {
    for (const [name, text] of Object.entries(files)) {
      const file = join(root, "apps/ui/.storybook", name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    return spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const preview = ({
  initialize = "initialize({}, [unhandledSocketHandler])",
  parameters = "{ controls: {} }",
  decorators = '[optIn("app", withApp), optIn("queryClient", withQueryClient)]',
} = {}) => `
import { initialize, mswLoader } from "msw-storybook-addon"
import { optIn } from "./decorators/opt-in"
const unhandledSocketHandler = ws.link(/.*/)
${initialize}
const preview = {
  loaders: [mswLoader],
  decorators: ${decorators},
  parameters: ${parameters},
}
export default preview
`

test("opt-in decorators and only the socket enforcement handler pass", () => {
  const result = check({ "preview.tsx": preview() })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Storybook globals check passed/)
})

test("MSW handlers in the preview parameters fail", () => {
  const result = check({
    "preview.tsx": preview({
      parameters: "{ msw: { handlers: { defaults: [sessionHandler] } } }",
    }),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /preview parameters set MSW handlers/)
})

test("an initial handler other than the socket enforcement fails", () => {
  const result = check({
    "preview.tsx": preview({
      initialize:
        "initialize({}, [organizationFullWithOrgHandler, unhandledSocketHandler])",
    }),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /initialize\(\) gets initial handlers/)
})

test("a global decorator without optIn fails", () => {
  const result = check({
    "preview.tsx": preview({
      decorators:
        '[optIn("app", withApp), (Story) => <div className="min-h-screen"><Story /></div>, withQueryClient]',
    }),
  })
  assert.equal(result.status, 1)
  const lines = result.stderr.trim().split("\n")
  assert.equal(lines.length, 2, result.stderr)
  for (const line of lines) assert.match(line, /must be optIn\("<parameter>"/)
})

test("a file of .storybook that imports, makes or adds a handler fails", () => {
  const result = check({
    "preview.tsx": preview(),
    "decorators/with-session.tsx": `
import { signedInHandlers } from "@/mocks/handlers"
import { http, HttpResponse } from "msw"
import { getWorker } from "msw-storybook-addon"
export const loader = () => {
  getWorker().use(http.get("*/api/config", () => HttpResponse.json({})))
}
`,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /imports the shared mocks \(@\/mocks\/handlers\)/)
  assert.match(result.stderr, /makes an MSW handler \(http\.get\)/)
  assert.match(result.stderr, /adds a handler to the worker/)
})
