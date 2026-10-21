import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { yamlEntry } from "../../../ingest-skills/apis/scripts/apis-lib.mjs"
import { classifyRoot } from "../../../ingest-skills/classify-kind/scripts/kind-rules.mjs"
import {
  headingText,
  MAX_LINE,
  parseDecision,
} from "../../../ingest-skills/decisions/scripts/decision-parse.mjs"
import { classifyTarget } from "../../../ingest-skills/dependencies/scripts/scan-lib.mjs"
import { readWorkflow } from "../../../ingest-skills/workflows/scripts/workflow-parse.mjs"

/**
 * Hostile input to the skill scripts: each reader cuts a long line or file
 * before a regular expression reads it, and the rewritten readers keep the
 * results of the old ones on normal input.
 */

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe("decision headings", () => {
  it.each([
    ["# Use Postgres", "Use Postgres"],
    ["   # Use Postgres ##  ", "Use Postgres"],
    ["# C# is used", "C# is used"],
    ["# Title#", "Title#"],
    ["## Not level one", null],
    ["#NoSpace", null],
    ["#    ", null],
  ])("reads %j", (line, title) => {
    expect(headingText(line)).toBe(title)
  })

  it("cuts a long heading line before it reads it", () => {
    const tail = "x".repeat(10)
    const decision = parseDecision(
      "docs/adr/0001-x.md",
      `# a${" ".repeat(100_000)}${tail}\n`,
    )
    // The line is cut at MAX_LINE characters, so the tail after the spaces is gone.
    expect(MAX_LINE).toBeLessThan(100_000)
    expect(decision.title).toBe("a")
  })
})

describe("OpenAPI YAML lines", () => {
  it.each([
    ["paths:", { indent: 0, key: "paths", value: "" }],
    ["  /users: # list", { indent: 2, key: "/users", value: "" }],
    ['    "get": x # y', { indent: 4, key: "get", value: "x" }],
    ["  title: Shop API", { indent: 2, key: "title", value: "Shop API" }],
    ["  url: http://a#b", { indent: 2, key: "url", value: "http://a#b" }],
    ["key:value", null],
    ["- item: x", null],
    ["# comment: x", null],
    ["", null],
  ])("reads %j", (line, entry) => {
    expect(yamlEntry(line)).toEqual(entry)
  })

  it("does not read a line above the line cap", () => {
    expect(yamlEntry(`a${" ".repeat(40_000)}x: y`)).toBeNull()
  })
})

describe("classify-kind manifests", () => {
  const repo = (files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), "kind-input-"))
    dirs.push(dir)
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "f",
          GIT_AUTHOR_EMAIL: "f@example.com",
          GIT_COMMITTER_NAME: "f",
          GIT_COMMITTER_EMAIL: "f@example.com",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
      })
    git("init", "-q", "-b", "main")
    for (const [path, text] of Object.entries(files))
      writeFileSync(join(dir, path), text)
    git("add", "-A")
    git("commit", "-q", "-m", "s")
    return dir
  }
  const kinds = (files: Record<string, string>) =>
    classifyRoot(repo(files), new Set(Object.keys(files)), ".").signals.map(
      (s: { kind: string; reason: string }) => s.reason,
    )

  it("finds a [[bin]] table only at a line start, not over line breaks", () => {
    const head = '[package]\nname = "tool"\n'
    expect(kinds({ "Cargo.toml": `${head}\n  [[bin]]\n` })).toContain(
      "The crate builds a binary",
    )
    expect(kinds({ "Cargo.toml": `${head}\n\n\n x[[bin]]\n` })).not.toContain(
      "The crate builds a binary",
    )
  })

  it("reads only the first 256 KiB of a manifest", () => {
    const far = `[package]\nname = "tool"\n${"\n".repeat(300 * 1024)}[[bin]]\n`
    expect(kinds({ "Cargo.toml": far })).not.toContain(
      "The crate builds a binary",
    )
  })
})

describe("dependency targets", () => {
  it.each([
    [
      '"https://user:s3cr3tPass@api.example.com/v1/charges"',
      "https://api.example.com/v1/charges",
    ],
    [
      '"https://api.example.com/v1/charges?key=s3cr3tPass&x=1"',
      "https://api.example.com/v1/charges",
    ],
    ['"amqp://svc:pw@queue.internal:5672"', "amqp://queue.internal:5672"],
    [
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the case is a JavaScript template in source text
      "`https://${user}:${pass}@api.example.com/users`",
      "https://api.example.com/users",
    ],
    ['"https://api.example.com/users"', "https://api.example.com/users"],
  ])("gives %s to the model as %s", (raw, text) => {
    expect(classifyTarget(raw)?.text).toBe(text)
  })
})

describe("hostile workflow files", () => {
  // Each file holds the word "leak" only where the reader must not read:
  // a value outside the 7 key paths, a block scalar, a comment, a second
  // document, or a form that the reader cannot follow. The reader gives a
  // skip, or a result with no "leak" in it.
  const JOB = "jobs:\n  a:\n    runs-on: x\n"
  const STEP = (lines: string) => `on: push\njobs:\n  a:\n    steps:\n${lines}`
  const deep = Array.from(
    { length: 70 },
    (_, i) => `${"  ".repeat(i + 2)}k${i}:\n`,
  ).join("")
  it.each([
    [
      "a multi-line plain scalar",
      STEP("      - run: echo\n          working-directory: leak/a\n"),
    ],
    [
      "a multi-line plain scalar in a list",
      `on:\n  push:\n    paths:\n      - apps/api\n        leak/b\n${JOB}`,
    ],
    [
      "a key with a space before the colon",
      STEP("      - run : |\n          working-directory: leak/a\n"),
    ],
    [
      "a quoted key",
      STEP('      - "run": |\n          working-directory: leak/a\n'),
    ],
    ["a duplicate key", `on: push\n${JOB}jobs:\n  leak:\n    runs-on: x\n`],
    [
      "a duplicate key in a job",
      STEP("      - working-directory: leak/a\n    steps:\n      - run: x\n"),
    ],
    [
      "comments",
      "on: push # jobs: leak\njobs: # leak: x\n  a: # working-directory: leak\n    runs-on: x\n#  leak:\n",
    ],
    [
      "a second document",
      `on: push\n${JOB}---\njobs:\n  leak:\n    runs-on: x\n`,
    ],
    ["a document end", `on: push\n${JOB}...\njobs:\n  leak: {}\n`],
    [
      "a directive",
      `%YAML 1.2\n---\non: push\njobs:\n  leak:\n    runs-on: x\n`,
    ],
    [
      "CRLF line ends",
      STEP("      - run: |\r\n          working-directory: leak\r\n").replace(
        /(?<!\r)\n/g,
        "\r\n",
      ),
    ],
    [
      "a lone carriage return",
      STEP("      - run: echo\r          working-directory: leak\n"),
    ],
    [
      "a byte order mark",
      `\uFEFF${STEP("      - run: |\n          jobs: leak\n")}`,
    ],
    [
      "a line separator",
      STEP("      - run: x\u2028        working-directory: leak\n"),
    ],
    [
      "a paragraph separator",
      STEP("      - run: x\u2029        working-directory: leak\n"),
    ],
    [
      "a next line character",
      STEP("      - run: x\u0085        working-directory: leak\n"),
    ],
    [
      "a no-break space as indent",
      "on: push\njobs:\n  a:\n\u00a0   working-directory: leak\n",
    ],
    ["a tab as indent", "on: push\njobs:\n  a:\n\tleak:\n\t\truns-on: x\n"],
    [
      "nesting deeper than 64 levels",
      `on: push\njobs:\n  a:\n${deep}${"  ".repeat(72)}working-directory: leak\n`,
    ],
    [
      "a block scalar with an indent indicator",
      STEP("      - run: |2\n            working-directory: leak/a\n"),
    ],
    [
      "a block scalar with an anchor",
      STEP("      - run: &a |\n          working-directory: leak/a\n"),
    ],
    [
      "a block scalar with a tag",
      STEP("      - run: !!str |\n          working-directory: leak/a\n"),
    ],
    [
      "a folded block scalar",
      STEP("      - run: >-\n          working-directory: leak/a\n"),
    ],
    [
      "a block scalar in a list",
      `on:\n  push:\n    paths:\n      - |\n        leak/a\n${JOB}`,
    ],
    [
      "jobs in a block scalar",
      `on: push\nenv:\n  X: |\n    jobs:\n      leak:\n        runs-on: x\n${JOB}`,
    ],
    [
      "jobs in a double-quoted value",
      `name: "x\njobs:\n  leak: y"\non: push\n${JOB}`,
    ],
    [
      "jobs in a single-quoted value",
      `name: 'x\n  jobs: leak'\non: push\n${JOB}`,
    ],
    [
      "a flow map",
      "on: push\njobs:\n  a:\n    defaults: {run: {working-directory: leak}}\n",
    ],
    ["a flow map on more lines", "on: push\njobs: {\n  leak: {}\n}\n"],
    [
      "a flow list on more lines",
      "on: [push,\n  leak]\njobs:\n  a:\n    runs-on: x\n",
    ],
    [
      "a merge key",
      "on: push\njobs:\n  a: &j\n    defaults:\n      run:\n        working-directory: leak\n  b:\n    <<: *j\n",
    ],
    [
      "an alias and a tag as values",
      STEP(
        "      - working-directory: *leak\n      - working-directory: !!str leak\n",
      ),
    ],
    [
      "a unicode key",
      `on: push\nj\u043ebs:\n  leak: {}\n${STEP("      - w\u00f6rking-directory: leak\n").slice(9)}`,
    ],
    ["a complex key", `? jobs\n: leak\non: push\n${JOB}`],
    [
      "a key at the wrong depth",
      STEP(
        "      - uses: x\n        with:\n          working-directory: leak\n        env:\n          working-directory: leak\n",
      ) +
        "    env:\n      defaults:\n        run:\n          working-directory: leak\n",
    ],
    ["a nested list", STEP("      - - working-directory: leak\n")],
    ["a long line", `${JOB}on: push\nname: ${"leak ".repeat(1000)}\n`],
    ["too many lines", `on: push\n${JOB}${"# x\n".repeat(30_000)}`],
  ])("reads no hostile text: %s", (_, text) => {
    const result = readWorkflow(text)
    if (!("skip" in result))
      expect(JSON.stringify(result).toLowerCase()).not.toContain("leak")
  })

  it("reads the key next to a block scalar at the column of the key", () => {
    expect(
      readWorkflow(
        STEP(
          "      -   run: |\n            working-directory: leak/a\n          working-directory: apps/api\n",
        ),
      ),
    ).toEqual({
      name: null,
      triggers: ["push"],
      jobs: ["a"],
      locations: [
        { where: "jobs.a.steps.working-directory", value: "apps/api" },
      ],
    })
  })
})
