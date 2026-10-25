import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { findSuspectedSecret } from "./secret-scan.js"

describe("findSuspectedSecret on the documents of this repository", () => {
  it("finds no secret in a tracked Markdown, YAML, JSON, or TOML file", () => {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
    }).trim()
    const paths = execFileSync(
      "git",
      ["ls-files", "-z", "*.md", "*.yaml", "*.yml", "*.json", "*.toml"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    )
      .split("\0")
      .filter(Boolean)
    expect(paths.length).toBeGreaterThan(100)
    const hits: string[] = []
    for (const path of paths) {
      const full = join(root, path)
      const stat = statSync(full, { throwIfNoEntry: false })
      if (!stat?.isFile() || stat.size > 1024 * 1024) continue
      const finding = findSuspectedSecret(readFileSync(full, "utf8"))
      if (finding) hits.push(`${path}: ${finding.reason}`)
    }
    expect(hits).toEqual([])
  })
})

describe("findSuspectedSecret on values that look like code or test data", () => {
  // The values are built at run time, so no literal secret is in the repository.
  const pw = ["Q9f3Kd8L", "mZ2xT7pW"].join("")
  const gh = `ghp_${"A1b2C3d4E5".repeat(4)}`
  const ghApp = `ghs_${"1234567"}_${"Ab3dE_f6Gh-9jKmN2pQ"}.${"rS5tU-v8Wx_y1Z"}`
  const aws = `AKIA${"Q9F3KD8LMZ2XT7PW"}`
  const found = (line: string) => findSuspectedSecret(`# N\n\n${line}\n`)
  it.each([
    ["a PHP variable", `$db_password = '${pw}';`],
    ["a PowerShell variable", `$apiKey = "${pw}4e"`],
    [
      "a URL with a template user",
      `postgres://\${DB_USER}:${pw}@db.example.com/app`,
    ],
    [
      "a test word and a random run",
      `SESSION_SECRET=prod-secret-8f3k2m9x7q4w1z5vn2`,
    ],
    [
      "a dev prefix and hex",
      `API_TOKEN=dev_${"9f86d081884c7d65"}${"9a2feaa0c55ad015"}`,
    ],
    ["a short password in a table", "| DB_PASSWORD | Hunter2Pass9 |"],
    ["a password and words after it", `password: ${pw.slice(0, 12)} (prod)`],
    [
      "a value with dots inside",
      `API_KEY=${pw.slice(0, 8)}...${pw.slice(8)}4e`,
    ],
    ["a call with a bare literal", `API_KEY=k(${pw}4e)`],
    ["a call with a quoted literal", `client_secret: fromEnv("${pw}4e")`],
    ["a list with one literal", `password: [${pw}]`],
    ["a GitHub token and a suffix", `${gh}-x`],
    ["a GitHub token and an underscore suffix", `${gh}_x`],
    ["a GitHub App token in the current form", `git clone with ${ghApp}`],
    ...["ghp", "gho", "ghu", "ghs", "ghr"].map((prefix): [string, string] => [
      `a ${prefix}_ token`,
      `see ${prefix}_${"A1b2C3d4E5".repeat(4)}`,
    ]),
    ["a github_pat_ token", `see github_pat_${"A1b2C3d4E5".repeat(9)}`],
    ["an AWS key id and a suffix", `${aws}-x`],
    ["a dictionary word and digits", "DB_PASSWORD=Password12345678"],
    ["a dictionary word and 4 digits", "API_TOKEN=secret123456"],
  ])("finds %s", (_, line) => {
    expect(found(line)).not.toBeNull()
  })

  it.each([
    ["a call with an env name", `client_secret: fromEnv("CLIENT_SECRET")`],
    ["a call with a path", `password: getSecret("prod/db/password")`],
    ["a call with a reference", "API_KEY=read(process.env.API_KEY)"],
    ["a call with a short name", `API_KEY=secretsManager("x")`],
    ["a call with a camel-case name", "token = useState(initialValue)"],
    ["a shortened value", "API_KEY=sk-or-v1-..."],
    ["a value shortened in the middle", "API_KEY=ghp_ab...wxyz"],
    [
      "a URL with template user and password",
      // oxlint-disable-next-line no-template-curly-in-string -- the case is a literal URL template
      "postgres://${DB_USER}:${DB_PASSWORD}@db/app",
    ],
    [
      "a test value of words",
      "AUTH_SECRET=ci-auth-secret-must-be-at-least-32-chars",
    ],
    ["a placeholder token with a suffix", `ghp_${"x".repeat(36)}-example`],
    ["words after a word", "research pass: ByteRover CLI 3"],
    ["a short GitHub prefix in prose", "The ghs_foo prefix marks a token."],
    [
      "a code identifier with a GitHub prefix",
      "const ghs_count_total_for_each_repository_owner = 0",
    ],
    ["a file name with a GitHub prefix", "see ghs_12_build.log"],
    ["a snake-case name with a number", "daily_highs_2_moving_average_window"],
    [
      "a bare prefix with a snake-case name",
      "ghs_2_repository_owner_total_count",
    ],
    ["a short word and digits", "DB_PASSWORD=password123"],
  ])("does not find %s", (_, line) => {
    expect(found(line)).toBeNull()
  })
})
