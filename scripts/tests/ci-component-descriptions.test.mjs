import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(
  new URL("../ci/check-component-descriptions.mjs", import.meta.url),
)

/** Runs the check on a fixture repo with these files under apps/ui/src. */
function check(files, allowlist = {}) {
  const root = mkdtempSync(join(tmpdir(), "ctxpipe-component-descriptions-"))
  try {
    for (const [name, text] of Object.entries(files)) {
      const file = join(root, "apps/ui/src", name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text)
    }
    const list = join(root, "scripts/ci/component-descriptions-allowlist.json")
    mkdirSync(dirname(list), { recursive: true })
    writeFileSync(list, JSON.stringify(allowlist))
    return spawnSync(process.execPath, [script, root], { encoding: "utf8" })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("each form of an exported component with a description passes; other exports do not count", () => {
  const result = check({
    "components/ui/Card.tsx": `
/** A tile on a page that holds one subject. */
export function Card() { return <div /> }

/**
 * The title of a card.
 * @param props the props
 */
export const CardTitle = (props: { title: string }) => <h2>{props.title}</h2>

/** A field that takes a ref. */
export const Field = forwardRef(function Field(props, ref) { return <input ref={ref} /> })

/** The body of a card. */
function CardBody() { return <div /> }
export { CardBody }

/** The page of the route. */
export default function Page() { return <main /> }

/** A row in parentheses. */
export const Row = (() => <div />) satisfies React.FC

/** A row that a wrapper call holds by name. */
export const MemoRow = memo(Body)
function Body() { return <div /> }

export function cardClassName() { return "card" }
export const SIZE = "sm"
export type CardProps = { title: string }
export { Other } from "./Other"
function Local() { return <span /> }
`,
    "components/ui/Card.stories.tsx": `export function Story() { return <div /> }`,
    "components/ui/Card.test.tsx": `export function Helper() { return <div /> }`,
    "lib/format.ts": `export function Format() { return "" }`,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /Component description check passed \(7 components\)/,
  )
})

test("a component with no description, or with only tags or a line comment, fails when the list does not have it", () => {
  const result = check({
    "features/Row.tsx": `
export function Row() { return <div /> }

/** @deprecated */
export const OldRow = () => <div />

// A line comment is not a JSDoc.
function TreeRow() { return <div /> }
export { TreeRow }

export const WrappedRow = (() => <div />) as React.FC
function Inner() { return <div /> }
export const MemoRow = memo(Inner)
`,
  })
  assert.equal(result.status, 1)
  for (const name of ["Row", "OldRow", "TreeRow", "WrappedRow", "MemoRow"])
    assert.match(
      result.stderr,
      new RegExp(
        `apps/ui/src/features/Row\\.tsx:\\d+: the component \`${name}\` has no description`,
      ),
    )
})

test("a listed component with no description passes", () => {
  const result = check(
    { "features/Row.tsx": `export function Row() { return <div /> }` },
    { "apps/ui/src/features/Row.tsx": ["Row"] },
  )
  assert.equal(result.status, 0, result.stderr)
})

test("the list only shrinks: a listed component that has a description or is gone fails", () => {
  const result = check(
    {
      "features/Row.tsx": `/** One row of the list. */
export function Row() { return <div /> }`,
    },
    {
      "apps/ui/src/features/Row.tsx": ["Row"],
      "apps/ui/src/features/Gone.tsx": ["Gone"],
    },
  )
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /apps\/ui\/src\/features\/Row\.tsx no longer has the component `Row` without a description\. Remove it from the list\./,
  )
  assert.match(
    result.stderr,
    /apps\/ui\/src\/features\/Gone\.tsx no longer has the component `Gone`/,
  )
})
