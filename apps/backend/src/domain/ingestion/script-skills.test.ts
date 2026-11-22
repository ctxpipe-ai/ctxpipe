import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"
import { parse, stringify } from "yaml"

import { EMPTY_TREE } from "../../test/ingest-step-index.js"
import {
  buildContextIndexEntries,
  contextIndexAtStepBase,
} from "./context-index.js"
import { withExistingRootFiles } from "./ingestion-plan.js"
import { gitSource, validatePatchStep } from "./patch-validator.js"
import { INGEST_SKILLS_DIR } from "./skill-bundle.js"

/*
 * The script-only skills (`libraries`, `ownership`) run on the host here,
 * on a real source checkout and a real context checkout. They write the
 * staged tree and patch.json, and the T06 validator checks the result.
 */

const SOURCE_URL = "https://github.com/example-org/shop"
// The source file of SOURCE_URL in the Workspace: the value of `sources`.
const SOURCE_PATH = "sources/github/example-org/shop.md"
const WORKSPACE_ID = "ws_fixture"
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
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

type RootEntry = {
  path: string
  manifests: string[]
  evidence: string[]
  files: string[]
}

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
    sourcePath: SOURCE_PATH,
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

  // The host's root-to-file map: the discover-roots roots, with no file yet.
  const rootsFile = join(root, "roots.json")
  const discovered = spawnSync(
    process.execPath,
    [
      join(INGEST_SKILLS_DIR, "discover-roots/scripts/discover-roots.mjs"),
      sourceDir,
    ],
    { encoding: "utf8", env: GIT_ENV },
  )
  const writeRoots = (roots: RootEntry[]) =>
    writeFileSync(rootsFile, JSON.stringify({ roots }))
  writeRoots(
    (JSON.parse(discovered.stdout).roots as RootEntry[]).map((r) => ({
      ...r,
      files: [],
    })),
  )
  const mapFiles = (map: Record<string, string[]>) => {
    const roots = JSON.parse(readFileSync(rootsFile, "utf8"))
      .roots as RootEntry[]
    writeRoots(roots.map((r) => ({ ...r, files: map[r.path] ?? r.files })))
  }
  /**
   * The host map at the base: the files of `mapFiles`, and the existing files
   * of each root (ADR-052 section 6, revision 2026-10-29).
   */
  const hostMap = async () => {
    const { rootFiles } = await contextIndexAtStepBase({
      workspaceId: WORKSPACE_ID,
      projection: [],
      pinnedRevision: EMPTY_TREE,
      base,
      sourcePath: SOURCE_PATH,
      repoDir: contextDir,
    })
    const roots = JSON.parse(readFileSync(rootsFile, "utf8"))
      .roots as RootEntry[]
    writeRoots(withExistingRootFiles({ roots }, rootFiles).roots)
  }
  let base = baseCommit
  /** Commit a validated tree as the next page's base and empty the step output. */
  const advance = (tree: string) => {
    base = git(contextDir, "commit-tree", tree, "-p", base, "-m", "page")
    writeFileSync(
      join(root, "step.json"),
      JSON.stringify({ workspaceId: WORKSPACE_ID, baseCommit: base }),
    )
    rmSync(join(root, "out"), { recursive: true, force: true })
    mkdirSync(join(root, "out", "files"), { recursive: true })
  }

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
        "--source-path",
        SOURCE_PATH,
        "--roots",
        rootsFile,
        ...args,
      ],
      { encoding: "utf8", env: GIT_ENV, timeout: 20_000 },
    )
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
    return JSON.parse(result.stdout) as {
      ops: Array<{ op: string; path: string }>
      skipped: Array<{ path: string | null; reason: string }>
      more: boolean
    }
  }
  const patch = () =>
    JSON.parse(readFileSync(join(root, "out", "patch.json"), "utf8")) as {
      ops: Array<{ op: string; path: string }>
    }
  const validate = (skill: string) =>
    validatePatchStep({
      repoDir: contextDir,
      baseCommit: base,
      stagedDir: join(root, "out"),
      source: { url: SOURCE_URL, sha: sourceSha },
      sourcePath: SOURCE_PATH,
      skill,
      bundle: "ingest-0000000000000000",
      ...gitSource(sourceDir, sourceSha),
      linkableRepositories: [SOURCE_URL],
    })
  const show = (tree: string, path: string) =>
    git(contextDir, "show", `${tree}:${path}`)
  return {
    root,
    sourceDir,
    contextDir,
    run,
    patch,
    validate,
    show,
    writeRoots,
    mapFiles,
    hostMap,
    advance,
  }
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
        sources: [SOURCE_PATH],
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
    s.writeRoots([
      {
        path: "crates/server",
        manifests: ["Cargo.toml"],
        evidence: [],
        files: [],
      },
      {
        path: "services/gateway",
        manifests: ["go.mod"],
        evidence: [],
        files: [],
      },
    ])
    const out = s.run("libraries")
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

  it("adds USES_LIBRARY claims only to mapped Service and Repository files of this source", async () => {
    const service = (name: string, sources: string[]) =>
      front({ kind: "Service", name, sources }, `# ${name}\n`)
    const s = step(PNPM_SHOP, {
      "knowledge/services/api.md": service("API", [SOURCE_PATH]),
      "knowledge/apps/web.md": front(
        { kind: "App", name: "Web", sources: [SOURCE_PATH] },
        "# Web\n",
      ),
      "knowledge/services/foreign.md": service("Foreign", [
        "https://github.com/example-org/other",
      ]),
    })
    s.mapFiles({
      "apps/api": [
        "knowledge/services/api.md",
        "knowledge/services/foreign.md",
      ],
      "apps/web": ["knowledge/apps/web.md"],
    })
    const out = s.run("libraries")
    expect(out.ops).toEqual([
      { op: "create", path: "knowledge/libraries/drizzle.md" },
      { op: "create", path: "knowledge/libraries/hono.md" },
      { op: "create", path: "knowledge/libraries/next-js.md" },
      { op: "create", path: "knowledge/libraries/zod.md" },
      { op: "update", path: "knowledge/services/api.md" },
    ])
    expect(out.skipped).toEqual([
      {
        path: "knowledge/services/foreign.md",
        reason:
          "The file of root apps/api is not a context file of this source",
      },
    ])
    const result = await s.validate("libraries")
    expect(result.rejections).toEqual([])
    const api = s.show(result.tree, "knowledge/services/api.md")
    for (const id of ["drizzle", "hono", "zod"])
      expect(api).toMatch(
        new RegExp(
          `- to: \\.\\./libraries/${id}\\.md\\n\\s+predicate: USES_LIBRARY\\n\\s+evidence:\\n\\s+path: apps/api/package\\.json`,
        ),
      )
  })

  // CTX-1083: on a later ingest no root step writes the Service file again.
  // The host map gives the root its file from the front matter `root`.
  it("adds USES_LIBRARY to the Service file that an earlier ingest wrote for the root", async () => {
    const earlier = (name: string, root: string) =>
      front(
        {
          kind: "Service",
          name,
          generated_by: "ctxpipe-extract",
          sources: [SOURCE_PATH],
          root,
        },
        `# ${name}\n`,
      )
    const s = step(PNPM_SHOP, {
      "knowledge/services/storefront.md": earlier("Storefront", "apps/api"),
      "knowledge/services/gone.md": earlier("Gone", "apps/gone"),
    })
    await s.hostMap()
    const out = s.run("libraries")
    expect(out.ops).toContainEqual({
      op: "update",
      path: "knowledge/services/storefront.md",
    })
    expect(out.ops.map((op) => op.path)).not.toContain(
      "knowledge/services/gone.md",
    )
    const result = await s.validate("libraries")
    expect(result.rejections).toEqual([])
    const api = s.show(result.tree, "knowledge/services/storefront.md")
    for (const id of ["drizzle", "hono", "zod"])
      expect(api).toMatch(
        new RegExp(
          `- to: \\.\\./libraries/${id}\\.md\\n\\s+predicate: USES_LIBRARY\\n\\s+evidence:\\n\\s+path: apps/api/package\\.json`,
        ),
      )
  })

  it("finds a knowledge/codebases/ file of kind Repository and adds USES_LIBRARY claims to it", async () => {
    const s = step(PNPM_SHOP, {
      "knowledge/codebases/shop.md": front(
        { kind: "Repository", name: "shop", sources: [SOURCE_PATH] },
        "# shop\n",
      ),
    })
    s.mapFiles({ "apps/api": ["knowledge/codebases/shop.md"] })
    const out = s.run("libraries")
    expect(out.ops).toContainEqual({
      op: "update",
      path: "knowledge/codebases/shop.md",
    })
    expect(out.skipped).toEqual([])
    const result = await s.validate("libraries")
    expect(result.rejections).toEqual([])
    const shop = s.show(result.tree, "knowledge/codebases/shop.md")
    expect(shop).toMatch(/predicate: USES_LIBRARY/)
  })

  it("ends a page at the 2 MiB of staged files, not at a file count, and continues on the next page (CTX-1482)", async () => {
    const services: Record<string, string> = {}
    // About 60 KiB for each file: 40 files are more than 2 MiB.
    const body = "The service handles orders.\n".repeat(2200)
    const source: Record<string, string> = {
      "package.json": pkg("shop", { private: true }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    }
    const map: Record<string, string[]> = {}
    for (let i = 0; i < 40; i++) {
      source[`apps/s${i}/package.json`] = pkg(`s${i}`, {
        dependencies: { zod: "^3.0.0" },
      })
      const file = `knowledge/services/s${i}.md`
      services[file] = front(
        { kind: "Service", name: `S${i}`, sources: [SOURCE_PATH] },
        `# S${i}\n\n${body}`,
      )
      map[`apps/s${i}`] = [file]
    }
    const s = step(source, services)
    s.mapFiles(map)
    // The finder: the 41 plans (one library file and 40 service files) are
    // the input of the cursor (CTX-1487). It writes nothing.
    expect(s.run("libraries", "--count")).toEqual({ count: 41 })
    expect(existsSync(join(s.root, "out", "patch.json"))).toBe(false)
    const first = s.run("libraries")
    expect(first.ops.length).toBeGreaterThan(30)
    expect(first.ops.length).toBeLessThan(41)
    expect(first.more).toBe(true)
    // The validator takes the whole page: no file passes the staged cap.
    const page = await s.validate("libraries")
    expect(page.rejections).toEqual([])
    expect(page.accepted).toHaveLength(first.ops.length)
    expect(page.cursorAt).toBe(first.ops.length)
    s.advance(page.tree)
    expect(s.run("libraries", "--count")).toEqual({ count: 41 })
    const second = s.run("libraries")
    expect(second.more).toBe(false)
    expect(second.ops).toHaveLength(41 - first.ops.length)
    // The cursor moved forward to the end of the input.
    expect((await s.validate("libraries")).cursorAt).toBe(41)
    expect([...first.ops, ...second.ops].map((op) => op.path).sort()).toEqual(
      ["knowledge/libraries/zod.md", ...Object.keys(services)].sort(),
    )
    expect((await s.validate("libraries")).rejections).toEqual([])
  }, 60_000)

  it("skips a root whose folder name has a newline or a backtick", () => {
    const s = step(
      {
        "package.json": pkg("shop", { private: true }),
        "apps/bad\n`x/package.json": pkg("bad", {
          dependencies: { zod: "^3.0.0" },
        }),
      },
      {},
    )
    s.writeRoots([
      {
        path: "apps/bad\n`x",
        manifests: ["package.json"],
        evidence: [],
        files: [],
      },
    ])
    expect(s.run("libraries")).toEqual({
      ops: [],
      skipped: [
        {
          path: null,
          reason: "A root path has characters that the script does not quote",
        },
      ],
      more: false,
    })
  })

  it("fails without the roots file", () => {
    const s = step(PNPM_SHOP, {})
    const result = spawnSync(
      process.execPath,
      [
        join(INGEST_SKILLS_DIR, "libraries/scripts/libraries.mjs"),
        "--root",
        s.root,
        "--source",
        s.sourceDir,
        "--source-url",
        SOURCE_URL,
        "--source-path",
        SOURCE_PATH,
      ],
      { encoding: "utf8", env: GIT_ENV },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Give --roots <roots file>")
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
        sources: [SOURCE_PATH],
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
    s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
    const out = s.run("ownership")
    expect(out.ops).toEqual([
      { op: "create", path: "knowledge/teams/example-org-payments.md" },
      { op: "create", path: "knowledge/teams/example-org-platform.md" },
    ])

    const result = await s.validate("ownership")
    expect(result.rejections).toEqual([])
    const payments = s.show(
      result.tree,
      "knowledge/teams/example-org-payments.md",
    )
    expect(payments).toContain("kind: Team")
    expect(payments).toContain("name: example-org/payments")
    expect(payments).toMatch(
      /- to: \.\.\/services\/api\.md\n\s+predicate: OWNS\n\s+evidence:\n\s+path: \.github\/CODEOWNERS\n\s+kind: script\n\s+confidence: 0\.7/,
    )
    expect(payments).toContain(
      "- Owns `apps/api` in `example-org/shop` (`.github/CODEOWNERS`: `/apps/api/`)",
    )
    // The last matching rule wins, so the default team does not own apps/api.
    const platform = s.show(
      result.tree,
      "knowledge/teams/example-org-platform.md",
    )
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
            sources: [SOURCE_PATH],
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
    s.mapFiles({ "apps/web": ["knowledge/apps/web.md"] })
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

  describe("OWNERS and OWNERS_ALIASES files (CTX-1513)", () => {
    const OWNED_SHOP = {
      ...PNPM_SHOP,
      OWNERS_ALIASES: [
        "aliases:",
        "  # The API team.",
        "  api-approvers:",
        "    - alice",
        "    - bob",
        "  api-reviewers:",
        "  - carol",
        "  web-approvers: [dave]",
        "  unused-alias:",
        "    - erin",
        "",
      ].join("\n"),
      OWNERS: [
        "# See the OWNERS docs at https://go.k8s.io/owners",
        "filters:",
        '  ".*":',
        "    approvers:",
        "      - root-person",
        '  "go\\\\.mod$":',
        "    approvers:",
        "      - web-approvers",
        "",
      ].join("\n"),
      "apps/OWNERS": "approvers:\n  - web-approvers # the web team\n",
      "apps/api/OWNERS": [
        "approvers:",
        "  - api-approvers",
        "  - alice",
        "reviewers:",
        "  - api-reviewers",
        "labels:",
        "  - sig/api",
        "",
      ].join("\n"),
      "apps/api/internal/OWNERS": "reviewers:\n  - api-reviewers\n",
      "vendor/example.com/lib/OWNERS": "approvers:\n  - unused-alias\n",
    }

    it("writes a team file for each alias that an OWNERS file names, with OWNS claims from the nearest OWNERS file with approvers", async () => {
      const service = (name: string) =>
        front(
          {
            kind: "Service",
            name,
            generated_by: "ctxpipe-extract",
            sources: [SOURCE_PATH],
          },
          `# ${name}\n`,
        )
      const s = step(OWNED_SHOP, {
        "knowledge/services/api.md": service("api"),
        "knowledge/services/web.md": service("web"),
      })
      s.mapFiles({
        "apps/api": ["knowledge/services/api.md"],
        "apps/web": ["knowledge/services/web.md"],
      })
      const out = s.run("ownership")
      expect(out.ops).toEqual([
        {
          op: "create",
          path: "knowledge/teams/example-org-shop-api-approvers.md",
        },
        {
          op: "create",
          path: "knowledge/teams/example-org-shop-api-reviewers.md",
        },
        {
          op: "create",
          path: "knowledge/teams/example-org-shop-web-approvers.md",
        },
      ])
      expect(out.skipped).toEqual([])

      const result = await s.validate("ownership")
      expect(result.rejections).toEqual([])
      const api = s.show(
        result.tree,
        "knowledge/teams/example-org-shop-api-approvers.md",
      )
      expect(api).toContain("kind: Team")
      expect(api).toContain("name: example-org/shop/api-approvers")
      expect(api).toContain("Members: `@alice`, `@bob`.")
      expect(api).toMatch(
        /- to: \.\.\/services\/api\.md\n\s+predicate: OWNS\n\s+evidence:\n\s+path: apps\/api\/OWNERS\n\s+kind: script/,
      )
      expect(api).toContain(
        "- Owns `apps/api` in `example-org/shop` (`apps/api/OWNERS`)",
      )
      expect(api).toContain(
        "- Approves `apps/api` in `example-org/shop` (`apps/api/OWNERS`)",
      )
      // A reviewer alias reviews folders, but it does not own a root.
      const reviewers = s.show(
        result.tree,
        "knowledge/teams/example-org-shop-api-reviewers.md",
      )
      expect(reviewers).toContain(
        "- Reviews `apps/api/internal` in `example-org/shop` (`apps/api/internal/OWNERS`)",
      )
      expect(reviewers).not.toContain("predicate: OWNS")
      // apps/web has no OWNERS file: the parent apps/OWNERS gives its owner.
      const web = s.show(
        result.tree,
        "knowledge/teams/example-org-shop-web-approvers.md",
      )
      expect(web).toContain(
        "- Owns `apps/web` in `example-org/shop` (`apps/OWNERS`)",
      )
      expect(web).toMatch(/- to: \.\.\/services\/web\.md\n\s+predicate: OWNS/)
      // The approvers of a parent OWNERS file also own the folders below it.
      expect(web).toContain(
        "- Owns `apps/api` in `example-org/shop` (`apps/OWNERS`)",
      )
      expect(web).toMatch(
        /- to: \.\.\/services\/api\.md\n\s+predicate: OWNS\n\s+evidence:\n\s+path: apps\/OWNERS/,
      )
      // A filter for some files only (go\.mod$) gives a line with its
      // pattern but owns no folder, and a vendored OWNERS file is another
      // project's file.
      expect(web).toContain(
        "- Approves the files that match `go\\.mod$` in the repository top in `example-org/shop` (`OWNERS`)",
      )
      expect(web).not.toContain("Owns the repository top")
      expect(out.ops.map((o) => o.path).join()).not.toContain("unused-alias")
    })

    it("writes a team file for an alias that only a file-name filter names, with the pattern and no OWNS claim", async () => {
      const s = step(
        {
          ...OWNED_SHOP,
          "docs/OWNERS":
            'filters:\n  "\\\\.md$":\n    reviewers:\n      - unused-alias\n',
        },
        {},
      )
      const out = s.run("ownership")
      expect(out.ops).toContainEqual({
        op: "create",
        path: "knowledge/teams/example-org-shop-unused-alias.md",
      })
      const result = await s.validate("ownership")
      expect(result.rejections).toEqual([])
      const docs = s.show(
        result.tree,
        "knowledge/teams/example-org-shop-unused-alias.md",
      )
      expect(docs).toContain(
        "- Reviews the files that match `\\.md$` in `docs` in `example-org/shop` (`docs/OWNERS`)",
      )
      expect(docs).not.toContain("predicate: OWNS")
    })

    const webService = {
      "knowledge/services/web.md": front(
        {
          kind: "Service",
          name: "web",
          generated_by: "ctxpipe-extract",
          sources: [SOURCE_PATH],
        },
        "# web\n",
      ),
    }
    const webTeam = (root: string) =>
      readFileSync(
        join(
          root,
          "out/files/knowledge/teams/example-org-shop-web-approvers.md",
        ),
        "utf8",
      )

    it("keeps the parent team of a root whose OWNERS file has only people as approvers", () => {
      const s = step(
        { ...OWNED_SHOP, "apps/web/OWNERS": "approvers:\n  - frank\n" },
        webService,
      )
      s.mapFiles({ "apps/web": ["knowledge/services/web.md"] })
      s.run("ownership")
      const web = webTeam(s.root)
      expect(web).toContain(
        "- Owns `apps/web` in `example-org/shop` (`apps/OWNERS`)",
      )
      expect(web).toMatch(
        /- to: "\.\.\/services\/web\.md"\n\s+predicate: "?OWNS/,
      )
    })

    it("gives no parent team to a root whose OWNERS file sets no_parent_owners", () => {
      const s = step(
        {
          ...OWNED_SHOP,
          "apps/web/OWNERS":
            "options:\n  no_parent_owners: true\napprovers:\n  - frank\n",
        },
        webService,
      )
      s.mapFiles({ "apps/web": ["knowledge/services/web.md"] })
      s.run("ownership")
      const web = webTeam(s.root)
      expect(web).not.toContain("Owns `apps/web`")
      expect(web).not.toContain("predicate: OWNS")
    })

    it("leaves out an OWNERS file in a test fixture folder and records the folder (CTX-1531)", () => {
      const s = step(
        {
          ...OWNED_SHOP,
          "pkg/owners/testdata/OWNERS": "approvers:\n  - unused-alias\n",
        },
        {},
      )
      const out = s.run("ownership")
      expect(out.skipped).toEqual([
        {
          path: "pkg/owners/testdata",
          reason:
            "A test fixture folder: the script did not read its 1 file, because they are test input",
        },
      ])
      expect(out.ops.map((o) => o.path).join()).not.toContain("unused-alias")
    })

    it("lists an OWNERS file larger than 1 MiB in skipped, not as an empty file", () => {
      const s = step(
        {
          ...OWNED_SHOP,
          "apps/web/OWNERS": `approvers:\n  - web-approvers\n${"# x\n".repeat(300_000)}`,
        },
        {},
      )
      const out = s.run("ownership")
      expect(out.skipped).toEqual([
        {
          path: "apps/web/OWNERS",
          reason: "The script cannot read the file: it is larger than 1 MiB",
        },
      ])
    })

    it("lists an OWNERS_ALIASES file larger than 1 MiB in skipped", () => {
      const s = step(
        {
          ...OWNED_SHOP,
          OWNERS_ALIASES: `aliases:\n  web-approvers: [dave]\n${"# x\n".repeat(300_000)}`,
        },
        {},
      )
      const out = s.run("ownership")
      expect(out.skipped).toContainEqual({
        path: "OWNERS_ALIASES",
        reason: "The script cannot read the file: it is larger than 1 MiB",
      })
      expect(out.ops.map((o) => o.path).join()).not.toContain("approvers")
    })

    it("lists an OWNERS file that it cannot read in skipped and reads the others", () => {
      const s = step(
        {
          ...OWNED_SHOP,
          "apps/web/OWNERS": "approvers: &anchor\n  - web-approvers\n",
        },
        {},
      )
      const out = s.run("ownership")
      expect(out.skipped).toEqual([
        {
          path: "apps/web/OWNERS",
          reason: "The script cannot read the YAML of the file",
        },
      ])
      expect(out.ops.length).toBe(3)
    })

    it("keeps the Related lines of a team that fit in 48 KiB and records the cut", () => {
      const folders = Object.fromEntries(
        // About 400 bytes for each line, so 160 lines do not fit.
        Array.from({ length: 160 }, (_, i) => [
          `apps/web/area-${String(i).padStart(4, "0")}-${"x".repeat(150)}/OWNERS`,
          "approvers:\n  - web-approvers\n",
        ]),
      )
      const s = step({ ...OWNED_SHOP, ...folders }, {})
      const out = s.run("ownership")
      expect(out.skipped).toEqual([
        {
          path: "knowledge/teams/example-org-shop-web-approvers.md",
          reason: expect.stringMatching(
            /^\d+ Related lines of the team did not fit in 48 KiB$/,
          ),
        },
      ])
      const web = readFileSync(
        join(
          s.root,
          "out/files/knowledge/teams/example-org-shop-web-approvers.md",
        ),
        "utf8",
      )
      expect(Buffer.byteLength(web)).toBeLessThan(64 * 1024)
      expect(web).toContain("area-0000-")
    })
  })

  it("makes no op without a CODEOWNERS file", () => {
    const s = step(PNPM_SHOP, {})
    expect(s.run("ownership")).toEqual({ ops: [], skipped: [], more: false })
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

  /** Team names in the Related lines of each team file that the step creates. */
  async function owners(
    source: Record<string, string>,
    roots: string[],
    context: Record<string, string> = {},
  ) {
    const s = step(source, context)
    s.writeRoots(
      roots.map((path) => ({ path, manifests: [], evidence: [], files: [] })),
    )
    const out = s.run("ownership")
    const result = await s.validate("ownership")
    expect(result.rejections).toEqual([])
    const owned: Record<string, string[]> = {}
    for (const op of out.ops)
      owned[op.path] = [
        ...s.show(result.tree, op.path).matchAll(/^- Owns `([^`]+)`/gm),
      ].map((m) => m[1] ?? "")
    return { out, owned }
  }

  it("does not let an earlier broader rule take the roots of a skipped rule", async () => {
    const { out, owned } = await owners(
      {
        "README.md": "# Shop\n",
        CODEOWNERS: [
          "*                 @example-org/platform",
          "/apps/api/        @example-org/team<script>",
          "/apps/web/<b>     @example-org/web",
          "",
        ].join("\n"),
      },
      ["apps/api", "apps/web/<b>", "apps/jobs"],
    )
    expect(owned).toEqual({
      "knowledge/teams/example-org-platform.md": ["apps/jobs"],
    })
    expect(out.skipped.map((s) => s.reason)).toEqual([
      "Line 2 has an owner that the script does not quote",
      "Line 3 has a pattern that the script does not quote",
    ])
  })

  it("treats a folder with a dot as a folder and anchors a pattern with a middle slash", async () => {
    const { owned } = await owners(
      {
        "README.md": "# Shop\n",
        CODEOWNERS: [
          "packages/socket.io/   @example-org/realtime",
          "apps/api              @example-org/payments",
          "docs/*.md             @example-org/docs",
          "",
        ].join("\n"),
      },
      ["packages/socket.io", "apps/api", "tools/apps/api", "docs/guide"],
    )
    expect(owned).toEqual({
      "knowledge/teams/example-org-payments.md": ["apps/api"],
      "knowledge/teams/example-org-realtime.md": ["packages/socket.io"],
    })
  })

  it("gives two teams with the same short name two files and never overwrites another team's file", async () => {
    const { out, owned } = await owners(
      {
        "README.md": "# Shop\n",
        CODEOWNERS: [
          "/apps/  @org-a/core",
          "/libs/  @org-b/core",
          "/tools/ @org-c/core",
          "",
        ].join("\n"),
      },
      ["apps/api", "libs/ui", "tools/cli"],
      {
        // A human file at the default path of @org-c/core names another team.
        "knowledge/teams/org-c-core.md": front(
          { kind: "Team", name: "Core platform" },
          "# Core platform\n",
        ),
      },
    )
    expect(owned).toEqual({
      "knowledge/teams/org-a-core.md": ["apps/api"],
      "knowledge/teams/org-b-core.md": ["libs/ui"],
    })
    expect(out.skipped).toEqual([
      {
        path: "knowledge/teams/org-c-core.md",
        reason: "A file with another name has this path",
      },
    ])
  })

  it("sees a claim to a path with a space, so a second run and a second page add no claim", async () => {
    const service = (name: string) =>
      front({ kind: "Service", name, sources: [SOURCE_PATH] }, `# ${name}\n`)
    const s = step(
      { ...PNPM_SHOP, CODEOWNERS: "/apps/ @example-org/payments\n" },
      {
        "knowledge/services/my api.md": service("My API"),
        "knowledge/services/web.md": service("Web"),
      },
    )
    s.mapFiles({
      "apps/api": ["knowledge/services/my api.md"],
      "apps/web": ["knowledge/services/web.md"],
    })
    const first = s.run("ownership")
    expect(first.ops).toEqual([
      { op: "create", path: "knowledge/teams/example-org-payments.md" },
    ])
    const page = await s.validate("ownership")
    expect(page.rejections).toEqual([])
    s.advance(page.tree)
    expect(s.run("ownership").ops).toEqual([])
    s.advance(page.tree)
    expect(s.run("ownership").ops).toEqual([])
    const team = s.show(page.tree, "knowledge/teams/example-org-payments.md")
    expect(team.match(/to: "?\.\.\/services\/my api\.md"?$/gm)).toHaveLength(1)
  })

  it("does not match a team file whose name only has the same letters as the team", async () => {
    const lookalike = front(
      { kind: "Team", name: "acmep/latform" },
      "# Lookalike\n",
    )
    const s = step(
      { ...PNPM_SHOP, CODEOWNERS: "* @acme/platform\n" },
      {
        "knowledge/teams/lookalike.md": lookalike,
        "knowledge/teams/acme-platform.md": front(
          { kind: "Team", name: "acmep/latform" },
          "# At the default path\n",
        ),
      },
    )
    const out = s.run("ownership")
    expect(out.ops).toEqual([])
    expect(out.skipped).toEqual([
      {
        path: "knowledge/teams/acme-platform.md",
        reason: "A file with another name has this path",
      },
    ])
  })

  it("matches an existing team file whose name is the team with the slash kept", async () => {
    const human = front({ kind: "Team", name: "Acme/Platform" }, "# Platform\n")
    const s = step(
      { ...PNPM_SHOP, CODEOWNERS: "* @acme/platform\n" },
      { "knowledge/teams/platform.md": human },
    )
    const out = s.run("ownership")
    expect(out.ops).toEqual([
      { op: "update", path: "knowledge/teams/platform.md" },
    ])
  })

  it("keeps a claim target with spaces that is longer than 80 characters, so a second run adds no claim", async () => {
    const longName = `my ${"long ".repeat(24)}api`
    const servicePath = `knowledge/services/${longName}.md`
    const s = step(
      { ...PNPM_SHOP, CODEOWNERS: "/apps/ @example-org/payments\n" },
      {
        [servicePath]: front(
          { kind: "Service", name: "Long API", sources: [SOURCE_PATH] },
          "# Long API\n",
        ),
      },
    )
    s.mapFiles({ "apps/api": [servicePath] })
    expect(s.run("ownership").ops).toEqual([
      { op: "create", path: "knowledge/teams/example-org-payments.md" },
    ])
    const page = await s.validate("ownership")
    expect(page.rejections).toEqual([])
    const team = s.show(page.tree, "knowledge/teams/example-org-payments.md")
    expect(team).toContain(`${longName}.md`)
    s.advance(page.tree)
    const second = s.run("ownership")
    expect(second.ops).toEqual([])
    expect(second.skipped).toEqual([])
  })

  it("does not count a folded claim target as claimed when its first line is a prefix, and skips the file with a reason", () => {
    const s = step(
      { ...PNPM_SHOP, CODEOWNERS: "/apps/ @example-org/payments\n" },
      {
        "knowledge/teams/payments-team.md": [
          "---",
          "kind: Team",
          "name: example-org/payments",
          "claims:",
          "  - to: ../apps/web.md",
          "      deeper",
          "    predicate: OWNS",
          "    evidence:",
          "      path: README.md",
          "      kind: model",
          "---",
          "# Payments team",
          "",
        ].join("\n"),
        "knowledge/apps/web.md": front(
          { kind: "App", name: "Web", sources: [SOURCE_PATH] },
          "# Web\n",
        ),
      },
    )
    s.mapFiles({ "apps/web": ["knowledge/apps/web.md"] })
    const out = s.run("ownership")
    expect(out.ops).toEqual([])
    expect(out.skipped).toContainEqual({
      path: "knowledge/teams/payments-team.md",
      reason: "The file has claims that the script cannot read",
    })
  })

  it("reads a double-quoted claim target with a YAML escape and a trailing comment", () => {
    const s = step(
      { ...PNPM_SHOP, CODEOWNERS: "/apps/ @example-org/payments\n" },
      {
        "knowledge/teams/payments-team.md": [
          "---",
          "kind: Team",
          "name: example-org/payments",
          "claims:",
          '  - to: "\\x2e\\x2e/apps/web.md" # the web app',
          "    predicate: OWNS",
          "    evidence:",
          "      path: README.md",
          "      kind: model",
          "---",
          "# Payments team",
          "",
        ].join("\n"),
        "knowledge/apps/web.md": front(
          { kind: "App", name: "Web", sources: [SOURCE_PATH] },
          "# Web\n",
        ),
      },
    )
    s.mapFiles({ "apps/web": ["knowledge/apps/web.md"] })
    const out = s.run("ownership")
    expect(out.skipped).toEqual([])
    // The claim is known, so the script adds no second claim: only Related lines change.
    expect(out.ops).toEqual([
      { op: "update", path: "knowledge/teams/payments-team.md" },
    ])
    const staged = readFileSync(
      join(s.root, "out", "files", "knowledge/teams/payments-team.md"),
      "utf8",
    )
    expect(staged.match(/predicate: OWNS/g)).toHaveLength(1)
  })

  describe("existing claims of a team file", () => {
    const TEAM = "knowledge/teams/payments-team.md"
    const teamStep = (frontLines: string[]) => {
      const s = step(
        { ...PNPM_SHOP, CODEOWNERS: "/apps/ @example-org/payments\n" },
        {
          [TEAM]: [
            "---",
            "kind: Team",
            "name: example-org/payments",
            ...frontLines,
            "---",
            "# Payments team",
            "",
          ].join("\n"),
          "knowledge/apps/web.md": front(
            { kind: "App", name: "Web", sources: [SOURCE_PATH] },
            "# Web\n",
          ),
        },
      )
      s.mapFiles({ "apps/web": ["knowledge/apps/web.md"] })
      return s
    }
    const claim = (to: string, predicate = "OWNS") => [
      `  - to: ${to}`,
      `    predicate: ${predicate}`,
      "    evidence:",
      "      path: README.md",
      "      kind: model",
    ]
    const stagedClaims = (s: ReturnType<typeof step>) => {
      const text = readFileSync(join(s.root, "out", "files", TEAM), "utf8")
      const yaml = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ""
      return (
        (parse(yaml) as { claims?: Array<{ to: string; predicate: string }> })
          .claims ?? []
      ).map((c) => `${c.to} ${c.predicate}`)
    }

    it("does not read a claim from the lines of a block scalar, and adds the real claim", () => {
      const s = teamStep([
        "summary: |-",
        "  Owner notes",
        "  to: ../apps/web.md",
        "  predicate: OWNS",
        "claims: []",
      ])
      const out = s.run("ownership")
      expect(out.skipped).toEqual([])
      expect(stagedClaims(s)).toEqual(["../apps/web.md OWNS"])
    })

    it("does not read a claim from a block scalar inside a claim item", () => {
      const s = teamStep([
        "claims:",
        "  - to: ../apps/other.md",
        "    predicate: OWNS",
        "    evidence:",
        "      path: |-",
        "        x",
        "        to: ../apps/web.md",
        "        predicate: OWNS",
        "      kind: model",
      ])
      const out = s.run("ownership")
      expect(out.skipped).toEqual([])
      expect(stagedClaims(s)).toEqual([
        "../apps/other.md OWNS",
        "../apps/web.md OWNS",
      ])
    })

    it("does not read a claim from a block scalar that holds a claims key", () => {
      const s = teamStep([
        "summary: |-",
        "  Notes",
        "  claims:",
        "    - to: ../apps/web.md",
        "      predicate: OWNS",
        "claims: []",
      ])
      s.run("ownership")
      expect(stagedClaims(s)).toEqual(["../apps/web.md OWNS"])
    })

    it.each([
      ["a trailing no-break space", "../apps/web.md\u00a0"],
      ["a trailing ideographic space", "../apps/web.md\u3000"],
      ["an ideographic space before a hash", "../apps/web.md\u3000#x"],
    ])(
      "skips the file with a reason when a plain claim target has %s",
      (_name, to) => {
        const s = teamStep(["claims:", ...claim(to)])
        const out = s.run("ownership")
        expect(out.skipped).toContainEqual({
          path: TEAM,
          reason: "The file has claims that the script cannot read",
        })
        expect(out.ops).toEqual([])
      },
    )

    it("reads no claim from a file with a line or paragraph separator, and pairs no target with a later predicate", async () => {
      const lib = await import(join(INGEST_SKILLS_DIR, "bin/knowledge-lib.mjs"))
      for (const separator of ["\u2028", "\u2029", "\u0085"]) {
        const text = [
          "claims:",
          ...claim("../apps/web.md", "USES_LIBRARY"),
          ...claim(`../apps/other.md${separator}`, "OWNS"),
        ].join("\n")
        expect(lib.existingClaims(text)).toBeNull()
      }
    })

    it("reads the claims of a YAML document as the YAML parser does", async () => {
      const lib = await import(join(INGEST_SKILLS_DIR, "bin/knowledge-lib.mjs"))
      const evidence = { path: "x", kind: "manifest" }
      const documents = [
        {
          kind: "Team",
          name: "t",
          summary: "A\nto: ../a.md\npredicate: OWNS",
          claims: [],
        },
        {
          kind: "Team",
          name: "to: ../a.md",
          claims: [{ to: "../z.md", predicate: "OWNS", evidence }],
        },
        {
          kind: "Team",
          name: "t",
          claims: [
            {
              to: "../z.md",
              predicate: "OWNS",
              evidence: {
                path: "x\nto: ../a.md\npredicate: USES_LIBRARY",
                kind: "manifest",
              },
            },
          ],
        },
        {
          kind: "Team",
          name: "t",
          claims: [
            { to: `../${"a b ".repeat(60)}.md`, predicate: "OWNS", evidence },
            { to: "../a.md #x", predicate: "USES_LIBRARY", evidence },
          ],
        },
      ]
      for (const document of documents) {
        const text = stringify(document, { lineWidth: 0 })
        const truth = new Set(
          (
            parse(text) as {
              claims: Array<{ to: string; predicate: string }>
            }
          ).claims.map((c) => `${c.to} ${c.predicate}`),
        )
        expect(lib.existingClaims(text)).toEqual(truth)
      }
    })

    it("refuses a front matter that the reader cannot follow", async () => {
      const lib = await import(join(INGEST_SKILLS_DIR, "bin/knowledge-lib.mjs"))
      const cases = [
        "claims:\n  - to: ../a.md\n    predicate: OWNS\n---\nclaims:\n  - to: ../z.md\n    predicate: OWNS",
        "claims:\n  - to: ../real.md\n    to: ../a.md\n    predicate: OWNS",
        "claims:\n  - to: ../a.md\n    predicate: OWNS\nclaims: []",
        "claims:\n\t- to: ../a.md\n    predicate: OWNS",
        "claims:\n  - to: ../a.md\n    predicate: &p OWNS",
        "claims:\n  - to: ../a.md\n    predicate: \"OWNS'",
        "claims:\n  - to: >-\n      ../a.md\n    predicate: OWNS",
        "claims: |\n  - to: ../a.md\n    predicate: OWNS",
        'summary: "A\nclaims:\n  - to: ../a.md\n  predicate: OWNS"',
        "claims:\n  - to: ../a.md\n    predicate: OWNS\n    evidence: [a,\n    to: ../z.md]",
      ]
      for (const text of cases) expect(lib.existingClaims(text)).toBeNull()
      expect(lib.existingClaims("claims: []")).toEqual(new Set())
      expect(lib.existingClaims("kind: Team")).toEqual(new Set())
    })

    it("reads no claim when a continuation line holds non-ASCII whitespace", async () => {
      const lib = await import(join(INGEST_SKILLS_DIR, "bin/knowledge-lib.mjs"))
      const whitespace = [
        " ",
        "　",
        " ",
        " ",
        "﻿",
        " ",
        " ",
        "\u000b",
        "\u000c",
        " ",
      ]
      for (const space of whitespace)
        for (const text of [
          `claims:\n  - to: knowledge/a.md\n      ${space}\n    predicate: OWNS\n`,
          `claims:\n  - to: knowledge/a.md\n      ${space}#x\n    predicate: OWNS\n`,
        ])
          expect(lib.existingClaims(text)).toBeNull()
    })

    it("reads a target with a long run of inner spaces", async () => {
      const lib = await import(join(INGEST_SKILLS_DIR, "bin/knowledge-lib.mjs"))
      const target = `a${" ".repeat(200_000)}b`
      const text = `claims:\n  - to: ${target}\n    predicate: OWNS\n`
      expect(lib.existingClaims(text)).toEqual(new Set([`${target} OWNS`]))
    })

    it("resets the target for each claim item", () => {
      const s = teamStep([
        "claims:",
        "  - to: ../apps/web.md",
        "    predicate: USES_LIBRARY",
        "    evidence:",
        "      path: README.md",
        "      kind: model",
        "  - evidence:",
        "      path: README.md",
        "      kind: model",
        "    predicate: OWNS",
      ])
      s.run("ownership")
      expect(stagedClaims(s)).toContain("../apps/web.md OWNS")
    })

    it("skips the file when a claim item holds a flow collection", () => {
      const s = teamStep([
        "claims:",
        "  - to: ../apps/web.md",
        "    predicate: OWNS",
        "    evidence: {path: README.md, kind: model}",
      ])
      expect(s.run("ownership").skipped).toContainEqual({
        path: TEAM,
        reason: "The file has claims that the script cannot read",
      })
    })

    it("reads claims that follow a block scalar key, with its own claim list", () => {
      const s = teamStep([
        "summary: |-",
        "  Owner notes",
        "claims:",
        ...claim("../apps/web.md"),
      ])
      const out = s.run("ownership")
      expect(out.skipped).toEqual([])
      expect(stagedClaims(s)).toEqual(["../apps/web.md OWNS"])
    })
  })

  it("finishes 2000 CODEOWNERS rules on 100 deep roots and says what it skipped", () => {
    const roots = Array.from(
      { length: 100 },
      (_, i) => `r${i}/${Array.from({ length: 58 }, () => "a").join("/")}`,
    )
    const s = step(
      {
        "README.md": "# Shop\n",
        CODEOWNERS: Array.from(
          { length: 2000 },
          (_, i) => `**/* @example-org/team${i}`,
        ).join("\n"),
      },
      {},
    )
    s.writeRoots(
      roots.map((path) => ({ path, manifests: [], evidence: [], files: [] })),
    )
    const out = s.run("ownership")
    expect(out.skipped.map((k) => k.reason)).toContain(
      "The match budget of the script ran out, so it found no owner for the remaining roots",
    )
  })

  describe("work limits per segment", () => {
    const longRoots = Array.from(
      { length: 2000 },
      (_, i) => `${"a".repeat(250)}${String(i).padStart(4, "0")}`,
    )
    const ownerRun = (pattern: string) => {
      const s = step(
        {
          "README.md": "# Shop\n",
          CODEOWNERS: Array.from(
            { length: 2000 },
            () => `${pattern} @example-org/slow`,
          ).join("\n"),
        },
        {},
      )
      s.writeRoots(
        longRoots.map((path) => ({
          path,
          manifests: [],
          evidence: [],
          files: [],
        })),
      )
      const out = s.run("ownership")
      return { out }
    }

    it("skips a pattern segment that is longer than 128 characters", () => {
      const { out } = ownerRun(`*${"a".repeat(132)}b`)
      expect(out.ops).toEqual([])
      expect(out.skipped.map((k) => k.reason)).toContain(
        "Line 1 has a pattern that the script cannot match: it has a segment longer than 128 characters",
      )
    })

    it("charges the character compares of a segment to the shared match budget", () => {
      const { out } = ownerRun(`*${"a".repeat(120)}b`)
      expect(out.ops).toEqual([])
      expect(out.skipped.map((k) => k.reason)).toContain(
        "The match budget of the script ran out, so it found no owner for the remaining roots",
      )
    })
  })

  it("skips a root that is more than 64 levels deep, and a pattern with too many segments", () => {
    const s = step(
      {
        "README.md": "# Shop\n",
        CODEOWNERS: `${"a/".repeat(33)}b @example-org/a\n* @example-org/platform\n`,
      },
      {},
    )
    s.writeRoots(
      [`${"d/".repeat(70)}x`, "apps/web"].map((path) => ({
        path,
        manifests: [],
        evidence: [],
        files: [],
      })),
    )
    const out = s.run("ownership")
    expect(out.skipped.map((k) => k.reason)).toEqual([
      "Line 1 has a pattern that the script cannot match: it has more than 32 segments",
      "The root is more than 64 levels deep, so the script found no owner for it",
    ])
  })

  it("matches a slow CODEOWNERS pattern, and skips an unsafe root", async () => {
    const deep = `${"a/".repeat(40)}x`
    const { out, owned } = await owners(
      {
        "README.md": "# Shop\n",
        CODEOWNERS: `${"**/".repeat(4)}leaf @example-org/deep\n* @example-org/platform\n`,
      },
      [deep, "apps/bad\n`x"],
    )
    expect(owned).toEqual({
      "knowledge/teams/example-org-platform.md": [deep],
    })
    expect(out.skipped).toEqual([
      {
        path: null,
        reason: "A root path has characters that the script does not quote",
      },
    ])
  })
})

describe("the repository name of a source URL", () => {
  it("reads a GitHub URL and a plain git URL with a group or with one segment (CTX-815)", async () => {
    const lib = await import(join(INGEST_SKILLS_DIR, "bin/knowledge-lib.mjs"))
    expect(lib.repositoryName("https://github.com/acme/web")).toBe("acme/web")
    expect(lib.repositoryName("https://git.example.org/acme/tools.git")).toBe(
      "acme/tools",
    )
    expect(
      lib.repositoryName("https://git.example.org/group/sub/tools.git"),
    ).toBe("sub/tools")
    expect(lib.repositoryName("https://git.example.org/tools.git")).toBe(
      "git.example.org/tools",
    )
    expect(lib.repositoryName("https://git.example.org/")).toBeNull()
  })
})

describe("feature-gates skill (CTX-1513)", () => {
  const GO_GATES = {
    "go.mod": "module example.org/shop\n\ngo 1.24\n",
    "main.go": "package main\n\nfunc main() {}\n",
    "pkg/features/features.go": [
      "package features",
      "",
      'import "k8s.io/component-base/featuregate"',
      "",
      "const (",
      "\t// owner: @alice, @bob",
      "\t// kep: https://kep.k8s.io/1234",
      "\t//",
      "\t// Lets the shop sell gift cards. Use <card> ids.",
      "\t// See https://kep.k8s.io/1234 and `https://example.org/x`.",
      '\tGiftCards featuregate.Feature = "GiftCards"',
      "",
      "\t// owner: @carol",
      '\tLegacyCheckout featuregate.Feature = "LegacyCheckout"',
      "",
      '\tOldCarts featuregate.Feature = "OldCarts"',
      ")",
      "",
      "var defaultGates = map[featuregate.Feature]featuregate.VersionedSpecs{",
      "\tGiftCards: {",
      '\t\t{Version: version.MustParse("1.30"), Default: false, PreRelease: featuregate.Alpha},',
      '\t\t{Version: version.MustParse("1.32"), Default: true, PreRelease: featuregate.Beta},',
      "\t},",
      "\tOldCarts: {Default: false, PreRelease: featuregate.Alpha},",
      "\tLegacyCheckout: {",
      '\t\t{Version: version.MustParse("1.0"), Default: true, PreRelease: featuregate.GA, LockToDefault: true},',
      "\t},",
      "}",
      "",
      "var dependencies = map[featuregate.Feature][]featuregate.Feature{",
      "\tGiftCards: {LegacyCheckout},",
      "}",
      "",
    ].join("\n"),
    "pkg/features/features_test.go":
      'package features\n\nconst TestOnly Feature = "TestOnly"\n',
    "vendor/example.com/x/features/f.go":
      'package f\n\nconst Vendored Feature = "Vendored"\n',
    "compiler/shop_feature/src/unstable.rs": [
      "declare_features! (",
      "    // A group comment.",
      "    /// Allows `async` gift cards.",
      '    (unstable, async_gift_cards, "1.80.0", Some(4321)),',
      '    (internal, shop_internals, "1.0.0", None),',
      ")",
      "",
    ].join("\n"),
  }
  const CONTEXT = {
    "knowledge/codebases/shop.md": front(
      {
        kind: "Repository",
        name: "shop",
        generated_by: "ctxpipe-extract",
        sources: [SOURCE_PATH],
      },
      "# shop\n",
    ),
    "knowledge/services/shop.md": front(
      {
        kind: "Service",
        name: "shop",
        generated_by: "ctxpipe-extract",
        sources: [SOURCE_PATH],
      },
      "# shop\n",
    ),
    "knowledge/decisions/kep-1234.md": front(
      { kind: "Decision", name: "KEP-1234: Gift cards" },
      "# KEP-1234: Gift cards\n",
    ),
    "github/issues/kubernetes/enhancements/1234.md": "# Gift cards\n",
    "github/issues/example-org/shop/4321.md": "# Tracking issue\n",
  }

  it("writes one FeatureGate file for each gate, with stage, default, owners, KEP links, and a PART_OF claim", async () => {
    const s = step(GO_GATES, CONTEXT)
    s.mapFiles({ ".": ["knowledge/services/shop.md"] })
    const out = s.run("feature-gates")
    expect(out.ops).toEqual([
      { op: "create", path: "knowledge/features/async-gift-cards.md" },
      { op: "create", path: "knowledge/features/gift-cards.md" },
      { op: "create", path: "knowledge/features/legacy-checkout.md" },
      { op: "create", path: "knowledge/features/old-carts.md" },
      { op: "create", path: "knowledge/features/shop-internals.md" },
    ])
    expect(out.skipped).toEqual([])

    const result = await s.validate("feature-gates")
    expect(result.rejections).toEqual([])
    const gift = s.show(result.tree, "knowledge/features/gift-cards.md")
    expect(gift).toContain("kind: FeatureGate")
    expect(gift).toContain("name: GiftCards")
    expect(gift).toContain(
      'summary: "Feature gate GiftCards of example-org/shop: beta since 1.32, on by default."',
    )
    expect(gift).toMatch(
      /- to: \.\.\/services\/shop\.md\n\s+predicate: PART_OF\n\s+evidence:\n\s+path: pkg\/features\/features\.go\n\s+kind: script/,
    )
    expect(gift).toContain("- Owners: `@alice`, `@bob`")
    expect(gift).toContain(
      "- KEP: KEP-1234 (`https://kep.k8s.io/1234`), [decision](../decisions/kep-1234.md), [issue](../../github/issues/kubernetes/enhancements/1234.md)",
    )
    expect(gift).toContain(
      "> Lets the shop sell gift cards.\n> Use \\<card\\> ids.\n> See `https://kep.k8s.io/1234` and `https://example.org/x`.",
    )
    expect(gift).toContain("Source: pkg/features/features.go")
    expect(gift).toContain("- 1.30: alpha, off by default")
    expect(gift).toContain(
      "- Declared in `pkg/features/features.go` of `example-org/shop` (line 11)",
    )
    const legacy = s.show(result.tree, "knowledge/features/legacy-checkout.md")
    expect(legacy).toContain("- Default: on, locked to the default")
    expect(legacy).toContain("- Stage: GA since 1.0")
    // The older form: one spec with no version.
    const old = s.show(result.tree, "knowledge/features/old-carts.md")
    expect(old).toContain("- Stage: alpha")
    expect(old).toContain("- Default: off")

    const rust = s.show(result.tree, "knowledge/features/async-gift-cards.md")
    expect(rust).toContain("a `#![feature(async_gift_cards)]` gate")
    expect(rust).toContain("- Stage: unstable since 1.80.0")
    expect(rust).toContain(
      "- Tracking issue: [#4321](../../github/issues/example-org/shop/4321.md)",
    )
    expect(rust).toContain("> Allows `async` gift cards.")
    expect(
      s.show(result.tree, "knowledge/features/shop-internals.md"),
    ).toContain("- Stage: internal since 1.0.0")
  })

  it("links a gate to the repository unit when its root has no package file, and a second run adds nothing", async () => {
    const {
      "github/issues/kubernetes/enhancements/1234.md": _issue,
      ...context
    } = CONTEXT
    const s = step(GO_GATES, context)
    const out = s.run("feature-gates")
    expect(out.ops.length).toBe(5)
    const result = await s.validate("feature-gates")
    expect(result.rejections).toEqual([])
    const gift = s.show(result.tree, "knowledge/features/gift-cards.md")
    expect(gift).toMatch(
      /- to: \.\.\/codebases\/shop\.md\n\s+predicate: PART_OF/,
    )
    expect(gift).not.toContain("enhancements/1234.md")
    s.advance(result.tree)
    expect(s.run("feature-gates").ops).toEqual([])
  })

  it("gives two gates of the same name in two packages a file each, and a second run changes nothing", async () => {
    const gate = (pkg: string) =>
      `package ${pkg}\n\nconst (\n\t// Lets the shop sell gift cards.\n\tGiftCards featuregate.Feature = "GiftCards"\n)\n`
    const s = step(
      {
        "go.mod": "module example.org/shop\n\ngo 1.24\n",
        "pkg/features/features.go": gate("features"),
        "staging/cards/features/features.go": gate("features"),
      },
      CONTEXT,
    )
    const out = s.run("feature-gates")
    expect(out.ops).toEqual([
      {
        op: "create",
        path: "knowledge/features/gift-cards-pkg-features.md",
      },
      {
        op: "create",
        path: "knowledge/features/gift-cards-staging-cards-features.md",
      },
    ])
    const result = await s.validate("feature-gates")
    expect(result.rejections).toEqual([])
    expect(
      s.show(
        result.tree,
        "knowledge/features/gift-cards-staging-cards-features.md",
      ),
    ).toContain("- Declared in `staging/cards/features/features.go`")
    s.advance(result.tree)
    expect(s.run("feature-gates")).toEqual({
      ops: [],
      skipped: [],
      more: false,
    })
  })

  const ownGate = (file: string, stage: string) =>
    front(
      {
        kind: "FeatureGate",
        name: "GiftCards",
        summary: `Feature gate GiftCards of example-org/shop: ${stage}.`,
        generated_by: "ctxpipe-extract",
        sources: [SOURCE_PATH],
      },
      `\n# GiftCards\n\n- Stage: ${stage}\n\n## Related\n\n- Declared in \`${file}\` of \`example-org/shop\` (line 3)\n`,
    )

  it("writes the current stage and default into a gate file that this source owns alone", async () => {
    const s = step(GO_GATES, {
      ...CONTEXT,
      "knowledge/features/gift-cards.md": ownGate(
        "pkg/features/features.go",
        "alpha",
      ),
    })
    s.mapFiles({ ".": ["knowledge/services/shop.md"] })
    const out = s.run("feature-gates")
    expect(out.ops).toContainEqual({
      op: "update",
      path: "knowledge/features/gift-cards.md",
    })
    const result = await s.validate("feature-gates")
    expect(result.rejections).toEqual([])
    const gift = s.show(result.tree, "knowledge/features/gift-cards.md")
    expect(gift).toContain("- Stage: beta since 1.32")
    expect(gift).not.toContain("- Stage: alpha\n")
    s.advance(result.tree)
    expect(s.run("feature-gates").ops).toEqual([])
  })

  it("leaves out a gate file in a test fixture folder and records the folder (CTX-1531)", () => {
    const s = step(
      {
        "go.mod": "module example.org/shop\n\ngo 1.24\n",
        "pkg/features/testdata/features.go":
          'package features\n\nconst (\n\tGiftCards featuregate.Feature = "GiftCards"\n)\n',
      },
      CONTEXT,
    )
    expect(s.run("feature-gates")).toEqual({
      ops: [],
      skipped: [
        {
          path: "pkg/features/testdata",
          reason:
            "A test fixture folder: the script did not read its 1 file, because they are test input",
        },
      ],
      more: false,
    })
  })

  it("lists a gate file larger than 1 MiB in skipped", () => {
    const s = step(
      {
        "go.mod": "module example.org/shop\n\ngo 1.24\n",
        "pkg/features/features.go": `package features\n\nconst (\n\tGiftCards featuregate.Feature = "GiftCards"\n)\n${"// x\n".repeat(300_000)}`,
      },
      CONTEXT,
    )
    expect(s.run("feature-gates")).toEqual({
      ops: [],
      skipped: [
        {
          path: "pkg/features/features.go",
          reason: "The script cannot read the file: it is larger than 1 MiB",
        },
      ],
      more: false,
    })
  })

  it("cuts a description at 2 KiB and records the cut in skipped", async () => {
    const long = "Lets the shop sell gift cards. ".repeat(100).trim()
    const s = step(
      {
        "go.mod": "module example.org/shop\n\ngo 1.24\n",
        "pkg/features/features.go": `package features\n\nconst (\n\t// ${long}\n\tGiftCards featuregate.Feature = "GiftCards"\n)\n`,
      },
      CONTEXT,
    )
    const out = s.run("feature-gates")
    expect(out.skipped).toEqual([
      {
        path: "pkg/features/features.go",
        reason: expect.stringMatching(
          /^The description of the feature gate on line 5 lost its last \d+ bytes at the 2 KiB limit$/,
        ),
      },
    ])
    const result = await s.validate("feature-gates")
    expect(result.rejections).toEqual([])
    const gift = s.show(result.tree, "knowledge/features/gift-cards.md")
    expect(gift).toContain("…")
    expect(gift).not.toContain(long)
  })

  it("keeps the file of a gate whose declaring file changed, as a Rust gate moves from unstable.rs to accepted.rs", async () => {
    const s = step(GO_GATES, {
      ...CONTEXT,
      "knowledge/features/gift-cards.md": ownGate(
        "pkg/features/old_features.go",
        "alpha",
      ),
    })
    s.mapFiles({ ".": ["knowledge/services/shop.md"] })
    const out = s.run("feature-gates")
    expect(out.ops).toContainEqual({
      op: "update",
      path: "knowledge/features/gift-cards.md",
    })
    expect(out.ops.map((o) => o.path)).not.toContain(
      "knowledge/features/shop-gift-cards.md",
    )
    const result = await s.validate("feature-gates")
    expect(result.rejections).toEqual([])
    const gift = s.show(result.tree, "knowledge/features/gift-cards.md")
    expect(gift).toContain("- Stage: beta since 1.32")
    expect(gift).toContain(
      "- Declared in `pkg/features/features.go` of `example-org/shop` (line 11)",
    )
    s.advance(result.tree)
    expect(s.run("feature-gates").ops).toEqual([])
  })

  it("keeps the file of each gate when a name that two packages declared is left in one", async () => {
    const s = step(
      {
        "go.mod": "module example.org/shop\n\ngo 1.24\n",
        "pkg/b/features/features.go":
          'package features\n\nconst (\n\tGiftCards featuregate.Feature = "GiftCards"\n)\n',
      },
      {
        ...CONTEXT,
        "knowledge/features/gift-cards-pkg-a-features.md": ownGate(
          "pkg/a/features/features.go",
          "alpha",
        ),
        "knowledge/features/gift-cards-pkg-b-features.md": ownGate(
          "pkg/b/features/features.go",
          "alpha",
        ),
      },
    )
    const out = s.run("feature-gates")
    expect(out.ops).toEqual([
      { op: "update", path: "knowledge/features/gift-cards-pkg-b-features.md" },
    ])
    expect((await s.validate("feature-gates")).rejections).toEqual([])
  })

  it("makes no op when the source has no feature gate", () => {
    const s = step(PNPM_SHOP, {})
    expect(s.run("feature-gates")).toEqual({
      ops: [],
      skipped: [],
      more: false,
    })
  })
})
