import { execFileSync, spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { stringify } from "yaml"
import { buildContextIndexEntries } from "./context-index.js"
import { gitSourcePathExists, validatePatchStep } from "./patch-validator.js"
import { INGEST_SKILLS_DIR } from "./skill-bundle.js"

/*
 * The script-only skills (`libraries`, `ownership`) run on the host here,
 * on a real source checkout and a real context checkout. They write the
 * staged tree and patch.json, and the T06 validator checks the result.
 */

const SOURCE_URL = "https://github.com/example-org/shop"
const WORKSPACE_ID = "ws_fixture"
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
}

const made: string[] = []
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], {
    env: GIT_ENV,
    encoding: "utf8",
  }).trim()
}

function writeTree(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

function commit(dir: string, files: Record<string, string>) {
  writeTree(dir, files)
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "--allow-empty", "-m", "fixture")
  return git(dir, "rev-parse", "HEAD")
}

const front = (attributes: object, body: string) =>
  `---\n${stringify(attributes)}---\n${body}`

const kindOf = (text: string) => /^kind: (\S+)$/m.exec(text)?.[1] ?? null

/** A step: a source checkout, a context checkout at its base, the index, and step.json. */
function step(source: Record<string, string>, context: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "script-skills-"))
  made.push(root)
  const sourceDir = join(root, "source", "shop")
  mkdirSync(sourceDir, { recursive: true })
  git(sourceDir, "init", "-q", "-b", "main")
  const sourceSha = commit(sourceDir, source)
  const contextDir = join(root, "context", WORKSPACE_ID)
  mkdirSync(contextDir, { recursive: true })
  git(contextDir, "init", "-q", "-b", "main")
  const baseCommit = commit(contextDir, {
    "README.md": "# Context\n",
    ...context,
  })
  const raw = new Map(Object.entries(context))
  const entries = buildContextIndexEntries({
    units: Object.entries(context).map(([path, text]) => ({
      path,
      kind: kindOf(text),
      links: [],
    })),
    raw,
    sourceUrl: SOURCE_URL,
  })
  writeFileSync(
    join(root, "context", `${WORKSPACE_ID}.index.json`),
    JSON.stringify({ workspaceId: WORKSPACE_ID, entries }),
  )
  writeFileSync(
    join(root, "step.json"),
    JSON.stringify({ workspaceId: WORKSPACE_ID, baseCommit }),
  )
  mkdirSync(join(root, "out", "files"), { recursive: true })

  const run = (skill: string, ...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [
        join(INGEST_SKILLS_DIR, skill, "scripts", `${skill}.mjs`),
        "--root",
        root,
        "--source",
        sourceDir,
        "--source-url",
        SOURCE_URL,
        ...args,
      ],
      { encoding: "utf8" },
    )
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
    return JSON.parse(result.stdout) as {
      ops: Array<{ op: string; path: string }>
      skipped: Array<{ path: string | null; reason: string }>
    }
  }
  const patch = () =>
    JSON.parse(readFileSync(join(root, "out", "patch.json"), "utf8")) as {
      ops: Array<{ op: string; path: string }>
    }
  const validate = (skill: string) =>
    validatePatchStep({
      repoDir: contextDir,
      baseCommit,
      stagedDir: join(root, "out"),
      source: { url: SOURCE_URL, sha: sourceSha },
      skill,
      bundle: "ingest-0000000000000000",
      sourcePathExists: gitSourcePathExists(sourceDir, sourceSha),
      linkableRepositories: [SOURCE_URL],
    })
  const show = (tree: string, path: string) =>
    git(contextDir, "show", `${tree}:${path}`)
  return { root, sourceDir, contextDir, baseCommit, run, patch, validate, show }
}

const pkg = (name: string, extra: object = {}) =>
  JSON.stringify({ name, version: "1.0.0", ...extra }, null, 2)

const PNPM_SHOP = {
  "package.json": pkg("shop", { private: true }),
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
  "apps/api/package.json": pkg("api", {
    dependencies: {
      "drizzle-orm": "^0.44.0",
      hono: "^4.0.0",
      lodash: "^4.17.21",
      zod: "^3.23.0",
    },
    devDependencies: { vitest: "^3.0.0" },
  }),
  "apps/web/package.json": pkg("web", {
    dependencies: { next: "15.0.0", zod: "^3.23.0" },
  }),
}

describe("libraries skill", () => {
  it("writes one library file per architectural library that the validator accepts", async () => {
    const s = step(PNPM_SHOP, {})
    const out = s.run("libraries")
    expect(out.ops).toEqual([
      { op: "create", path: "knowledge/libraries/drizzle.md" },
      { op: "create", path: "knowledge/libraries/hono.md" },
      { op: "create", path: "knowledge/libraries/next-js.md" },
      { op: "create", path: "knowledge/libraries/zod.md" },
    ])
    expect(s.patch().ops).toEqual(out.ops)

    const result = await s.validate("libraries")
    expect(result.rejections).toEqual([])
    expect(result.status).toBe("complete")
    expect(result.accepted.map((op) => op.path)).toEqual(
      out.ops.map((op) => op.path),
    )
    const zod = s.show(result.tree, "knowledge/libraries/zod.md")
    expect(zod).toContain("kind: Library")
    expect(zod).toContain("name: Zod")
    expect(zod).toContain("generated_by: ctxpipe-extract")
    expect(zod).toContain(
      "- `example-org/shop` uses it in `apps/api` (`apps/api/package.json`: `zod`)",
    )
    expect(zod).toContain(
      "- `example-org/shop` uses it in `apps/web` (`apps/web/package.json`: `zod`)",
    )
    // A utility and a test tool are not architectural libraries.
    expect(out.ops.map((op) => op.path).join()).not.toMatch(/lodash|vitest/)
  })

  it("updates an existing file that describes the library and adds no duplicate", async () => {
    const human = front(
      { kind: "Library", name: "Zod", summary: "Schema validation." },
      "# Zod\n\nThe team uses Zod at each API boundary.\n",
    )
    const owned = front(
      {
        kind: "Library",
        name: "Hono",
        generated_by: "ctxpipe-extract",
        sources: [SOURCE_URL],
      },
      "# Hono\n\nWeb framework.\n\n## Related\n\n- `example-org/shop` uses it in `apps/api` (`apps/api/package.json`: `hono`)\n",
    )
    const s = step(PNPM_SHOP, {
      "knowledge/libraries/validation-zod.md": human,
      "knowledge/libraries/hono.md": owned,
    })
    const out = s.run("libraries")
    expect(out.ops).toEqual([
      { op: "create", path: "knowledge/libraries/drizzle.md" },
      { op: "create", path: "knowledge/libraries/next-js.md" },
      { op: "update", path: "knowledge/libraries/validation-zod.md" },
    ])

    const result = await s.validate("libraries")
    expect(result.rejections).toEqual([])
    const zod = s.show(result.tree, "knowledge/libraries/validation-zod.md")
    expect(zod.startsWith(human.trimEnd())).toBe(true)
    expect(zod).toMatch(
      /The team uses Zod at each API boundary\.\n\n## Related\n\n- `example-org\/shop` uses it in `apps\/api`/,
    )
  })

  it("reads Cargo and Go manifests and only the roots that the host gives", async () => {
    const s = step(
      {
        "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
        "crates/server/Cargo.toml": [
          "[package]",
          'name = "server"',
          "",
          "[dependencies]",
          'tokio = { version = "1", features = ["full"] }',
          'axum = "0.7"',
          'anyhow = "1"',
          "",
          "[dependencies.sqlx]",
          'version = "0.8"',
        ].join("\n"),
        "crates/other/Cargo.toml":
          '[package]\nname = "other"\n\n[dependencies]\nserde = "1"\n',
        "services/gateway/go.mod": [
          "module example.com/gateway",
          "",
          "require (",
          "\tgithub.com/gin-gonic/gin v1.10.0",
          "\tgorm.io/gorm v1.25.0 // indirect",
          ")",
          "require github.com/redis/go-redis/v9 v9.5.0",
        ].join("\n"),
      },
      {},
    )
    const roots = join(s.root, "roots.json")
    writeFileSync(
      roots,
      JSON.stringify({
        roots: [
          { path: "crates/server", manifests: ["Cargo.toml"], evidence: [] },
          { path: "services/gateway", manifests: ["go.mod"], evidence: [] },
        ],
        ambiguous: [],
      }),
    )
    const out = s.run("libraries", "--roots", roots)
    expect(out.ops.map((op) => op.path)).toEqual([
      "knowledge/libraries/axum.md",
      "knowledge/libraries/gin.md",
      "knowledge/libraries/redis.md",
      "knowledge/libraries/sqlx.md",
      "knowledge/libraries/tokio.md",
    ])
    const result = await s.validate("libraries")
    expect(result.rejections).toEqual([])
    expect(s.show(result.tree, "knowledge/libraries/redis.md")).toContain(
      "(`services/gateway/go.mod`: `github.com/redis/go-redis/v9`)",
    )
  })

  it("makes no op when the context already has each line", async () => {
    const s = step(
      {
        "package.json": pkg("single", { dependencies: { zod: "^3.0.0" } }),
      },
      {
        "knowledge/libraries/zod.md": front(
          { kind: "Library", name: "Zod" },
          "# Zod\n\n## Related\n\n- `example-org/shop` uses it in `.` (`package.json`: `zod`)\n",
        ),
      },
    )
    expect(s.run("libraries").ops).toEqual([])
    expect(s.patch().ops).toEqual([])
  })
})

const CODEOWNERS = [
  "# Default owners",
  "*                @example-org/platform",
  "/apps/api/       @example-org/payments @some-person dev@example.com",
  "docs/*.md        @example-org/docs",
  "",
].join("\n")

describe("ownership skill", () => {
  it("writes team files with OWNS claims to the files of owned roots", async () => {
    const api = front(
      {
        kind: "Service",
        name: "API",
        generated_by: "ctxpipe-extract",
        sources: [SOURCE_URL],
        claims: [
          {
            to: "../codebases/shop.md",
            predicate: "PART_OF",
            evidence: { path: "apps/api/package.json", kind: "script" },
            confidence: 0.7,
          },
        ],
      },
      "# API\n",
    )
    const s = step(
      { ...PNPM_SHOP, ".github/CODEOWNERS": CODEOWNERS },
      {
        "knowledge/services/api.md": api,
        "knowledge/codebases/shop.md": front(
          { kind: "Repository", name: "shop" },
          "# shop\n",
        ),
      },
    )
    const out = s.run("ownership")
    expect(out.ops).toEqual([
      { op: "create", path: "knowledge/teams/payments.md" },
      { op: "create", path: "knowledge/teams/platform.md" },
    ])

    const result = await s.validate("ownership")
    expect(result.rejections).toEqual([])
    const payments = s.show(result.tree, "knowledge/teams/payments.md")
    expect(payments).toContain("kind: Team")
    expect(payments).toContain("name: example-org/payments")
    expect(payments).toMatch(
      /- to: \.\.\/services\/api\.md\n\s+predicate: OWNS\n\s+evidence:\n\s+path: \.github\/CODEOWNERS\n\s+kind: script\n\s+confidence: 0\.7/,
    )
    expect(payments).toContain(
      "- Owns `apps/api` in `example-org/shop` (`.github/CODEOWNERS`: `/apps/api/`)",
    )
    // The last matching rule wins, so the default team does not own apps/api.
    const platform = s.show(result.tree, "knowledge/teams/platform.md")
    expect(platform).toContain(
      "- Owns `apps/web` in `example-org/shop` (`.github/CODEOWNERS`: `*`)",
    )
    expect(platform).not.toContain("apps/api")
    expect(platform).not.toContain("claims")
  })

  it("adds claims and lines to an existing team file and adds no duplicate", async () => {
    const human = front(
      {
        kind: "Team",
        name: "example-org/payments",
        claims: [
          {
            to: "../codebases/shop.md",
            predicate: "OWNS",
            evidence: { path: "README.md", kind: "model" },
          },
        ],
      },
      "# Payments team\n\nOn call each week.\n",
    )
    const s = step(
      {
        ...PNPM_SHOP,
        "README.md": "# Shop\n",
        CODEOWNERS: "/apps/ @example-org/payments\n",
      },
      {
        "knowledge/teams/payments-team.md": human,
        "knowledge/codebases/shop.md": front(
          { kind: "Repository", name: "shop" },
          "# shop\n",
        ),
        "knowledge/apps/web.md": front(
          {
            kind: "App",
            name: "Web",
            claims: [
              {
                to: "../codebases/shop.md",
                predicate: "PART_OF",
                evidence: { path: "apps/web/package.json", kind: "script" },
              },
            ],
          },
          "# Web\n",
        ),
      },
    )
    const out = s.run("ownership")
    expect(out.ops).toEqual([
      { op: "update", path: "knowledge/teams/payments-team.md" },
    ])
    const result = await s.validate("ownership")
    expect(result.rejections).toEqual([])
    const team = s.show(result.tree, "knowledge/teams/payments-team.md")
    expect(team).toContain("predicate: OWNS")
    expect(team).toMatch(/to: \.\.\/apps\/web\.md/)
    expect(team).toContain(
      "On call each week.\n\n## Related\n\n- Owns `apps/api`",
    )
    expect(team).toContain(
      "- Owns `apps/web` in `example-org/shop` (`CODEOWNERS`: `/apps/`)",
    )
  })

  it("makes no op without a CODEOWNERS file", () => {
    const s = step(PNPM_SHOP, {})
    expect(s.run("ownership")).toEqual({ ops: [], skipped: [] })
    expect(s.patch().ops).toEqual([])
  })

  it("skips a rule whose pattern or owner it cannot quote safely", () => {
    const s = step(
      {
        ...PNPM_SHOP,
        ".github/CODEOWNERS":
          "/apps/web/<b>   @example-org/web\n/apps/api/ @example-org/team<script>\n",
      },
      {},
    )
    const out = s.run("ownership")
    expect(out.ops).toEqual([])
    expect(out.skipped).toEqual([
      {
        path: ".github/CODEOWNERS",
        reason: "Line 1 has a pattern that the script does not quote",
      },
      {
        path: ".github/CODEOWNERS",
        reason: "Line 2 has an owner that the script does not quote",
      },
    ])
  })
})
