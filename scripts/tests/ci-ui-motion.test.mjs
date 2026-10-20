import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

function check(files) {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-ui-motion-"))
  try {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(directory, name), text)
    }
    return spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../ci/check-ui-motion.mjs", import.meta.url)),
        directory,
      ],
      { encoding: "utf8" },
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test("small-element motion at 150 ms or less passes", () => {
  const result = check({
    "a.tsx": `const c = "transition-colors duration-100 hover:bg-zinc-800"\nconst d = "duration-150"\n`,
    "a.css": ".x {\n  transition: opacity 100ms ease-out;\n}\n",
  })
  assert.equal(result.status, 0, result.stderr)
})

test("a Tailwind duration above 150 ms fails", () => {
  const result = check({
    "a.tsx": `const c = "transition-opacity duration-200"\n`,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /a\.tsx:1: duration-200 is above 150 ms/)
})

test("transition-all fails", () => {
  const result = check({ "a.tsx": `const c = "rounded-full transition-all"\n` })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /transition-all/)
})

test("a CSS animation above 150 ms fails, and a named loader class passes", () => {
  const result = check({
    "a.css": [
      ".pane {",
      "  animation: rise 560ms ease-out both;",
      "}",
      ".ctx-status-pulse {",
      "  animation: pulse 1.2s ease-in-out infinite;",
      "}",
      "",
    ].join("\n"),
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /a\.css:2: 560ms in animation is above 150 ms/)
  assert.doesNotMatch(result.stderr, /1\.2s/)
})

const slowCases = {
  "an arbitrary Tailwind duration": [
    "a.tsx",
    `const c = "transition-opacity duration-[400ms]"\n`,
  ],
  "an arbitrary transition property": [
    "a.tsx",
    `const c = "[transition:opacity_400ms]"\n`,
  ],
  "a Tailwind delay": ["a.tsx", `const c = "transition-opacity delay-500"\n`],
  "an inline style transition": [
    "a.tsx",
    `const e = <div style={{ transition: "opacity 400ms" }} />\n`,
  ],
  "a one-line CSS rule": ["a.css", ".b { animation: x 300ms; }\n"],
  "a multi-line CSS transition": [
    "a.css",
    ".b {\n  transition:\n    opacity 400ms;\n}\n",
  ],
  "a looping animation outside a loader class": [
    "a.css",
    ".b { animation: x 300ms infinite; }\n",
  ],
  "an arbitrary animation outside a loader class": [
    "a.tsx",
    `const c = "animate-[shimmer_1.5s_ease-in-out_infinite]"\n`,
  ],
  "a slow theme default": [
    "a.css",
    "@theme {\n  --default-transition-duration: 300ms;\n}\n",
  ],
  "a slow Tailwind class in @apply": [
    "a.css",
    ".b {\n  @apply transition-opacity duration-300;\n}\n",
  ],
}

for (const [name, [file, text]] of Object.entries(slowCases)) {
  test(`${name} fails`, () => {
    const result = check({ [file]: text })
    assert.equal(result.status, 1, `${name} passed:\n${text}`)
    assert.match(result.stderr, /above 150 ms/)
    assert.match(result.stderr, /1 slow motion finding/)
  })
}

test("a loader class string can loop longer than 150 ms", () => {
  const result = check({
    "a.tsx": `const c = "ctx-loading-motion before:animate-[shimmer_1.5s_ease-in-out_infinite]"\n`,
  })
  assert.equal(result.status, 0, result.stderr)
})

test("motion-allow on the line before exempts one line", () => {
  const result = check({
    "a.css":
      ".x {\n  /* motion-allow: autofill hack */\n  transition: background-color 9999s;\n}\n",
  })
  assert.equal(result.status, 0, result.stderr)
})
