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
      // oxlint-disable-next-line no-template-curly-in-string -- the case is a JavaScript template in source text
      "`https://${user}:${pass}@api.example.com/users`",
      "https://api.example.com/users",
    ],
    ['"https://api.example.com/users"', "https://api.example.com/users"],
  ])("gives %s to the model as %s", (raw, text) => {
    expect(classifyTarget(raw)?.text).toBe(text)
  })
})
