import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(
  new URL("../ci/check-product-components.mjs", import.meta.url),
)

/**
 * Runs the check on a fixture repo with these files under apps/ui/src, and
 * the apps/ui entries of the real knip.json.
 */
function check(files) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-product-components-"))
  try {
    const write = (name, text) => {
      const file = join(root, name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    write("package.json", JSON.stringify({ name: "fixture", private: true }))
    write("pnpm-workspace.yaml", "packages:\n  - apps/*\n")
    write(
      "apps/ui/package.json",
      JSON.stringify({ name: "ui", private: true, type: "module" }),
    )
    write(
      "apps/ui/tsconfig.json",
      JSON.stringify({ compilerOptions: { jsx: "react-jsx" } }),
    )
    write(
      "knip.json",
      JSON.stringify({
        workspaces: {
          "apps/ui": {
            entry: [
              "src/router.tsx",
              "src/routes/**/*.{ts,tsx}",
              "src/**/*.stories.tsx",
              "src/**/*.test.{ts,tsx}",
              ".storybook/*.{ts,tsx}",
            ],
            project: ["src/**/*.{ts,tsx}", ".storybook/**/*.{ts,tsx}"],
          },
        },
      }),
    )
    for (const [name, text] of Object.entries(files)) {
      write(join("apps/ui/src", name), text)
    }
    return spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const product = {
  "router.tsx": `import { Page } from "./routes/page"\nexport const router = Page\n`,
  "routes/page.tsx": `import { Card } from "../components/Card"\nexport function Page() { return <Card /> }\n`,
  "components/Card.tsx": `
export function Card() { return <CardTitle /> }
export function CardTitle() { return <h2 /> }
export function cardClassName() { return "card" }
`,
  "components/Card.stories.tsx": `import { Card, CardTitle, cardClassName } from "./Card"\nexport const A = () => <Card className={cardClassName()}><CardTitle /></Card>\n`,
  "components/Card.test.tsx": `import { Card } from "./Card"\nexport const t = Card\n`,
  "components/cardStory.tsx": `export function StoryFrame() { return <div /> }\n`,
  "mocks/handlers.tsx": `export function MockPanel() { return <div /> }\n`,
}

test("components that the product renders pass; story support and non-component exports do not count", () => {
  const result = check(product)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /Product component check passed/)
})

test("a component file that only a story or a test imports fails", () => {
  const result = check({
    ...product,
    "components/Old.tsx": `export function Old() { return <div /> }\n`,
    "components/Old.stories.tsx": `import { Old } from "./Old"\nexport const A = () => <Old />\n`,
    "components/Older.tsx": `export function Older() { return <div /> }\n`,
    "components/Older.test.tsx": `import { Older } from "./Older"\nexport const t = Older\n`,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /components\/Old\.tsx \(no product import\)/)
  assert.match(result.stderr, /components\/Older\.tsx \(no product import\)/)
})

test("an exported component that only a story imports fails, also in a file that the product uses", () => {
  const result = check({
    ...product,
    "components/Card.tsx": `
export function Card() { return <h2 /> }
export function CardBadge() { return <span /> }
`,
    "components/Card.stories.tsx": `import { Card, CardBadge } from "./Card"\nexport const A = () => <Card><CardBadge /></Card>\n`,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /components\/Card\.tsx:3 CardBadge/)
  assert.doesNotMatch(result.stderr, /Card\.tsx:2 Card\b/)
})
