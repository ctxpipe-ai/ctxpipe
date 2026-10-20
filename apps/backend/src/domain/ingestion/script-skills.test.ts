import { execFileSync, spawnSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parse, stringify } from "yaml"
import { buildContextIndexEntries } from "./context-index.js"
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

  it("writes at most 30 files in a step and continues on the next page", async () => {
    const services: Record<string, string> = {}
    const source: Record<string, string> = {
      "package.json": pkg("shop", { private: true }),
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    }
    const map: Record<string, string[]> = {}
    for (let i = 0; i < 35; i++) {
      source[`apps/s${i}/package.json`] = pkg(`s${i}`, {
        dependencies: { zod: "^3.0.0" },
      })
      const file = `knowledge/services/s${i}.md`
      services[file] = front(
        { kind: "Service", name: `S${i}`, sources: [SOURCE_PATH] },
        `# S${i}\n`,
      )
      map[`apps/s${i}`] = [file]
    }
    const s = step(source, services)
    s.mapFiles(map)
    const first = s.run("libraries")
    expect(first.ops).toHaveLength(30)
    expect(first.more).toBe(true)
    const page = await s.validate("libraries")
    expect(page.rejections).toEqual([])
    s.advance(page.tree)
    const second = s.run("libraries")
    expect(second.more).toBe(false)
    expect(second.ops).toHaveLength(6)
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
    ])("skips the file with a reason when a plain claim target has %s", (_name, to) => {
      const s = teamStep(["claims:", ...claim(to)])
      const out = s.run("ownership")
      expect(out.skipped).toContainEqual({
        path: TEAM,
        reason: "The file has claims that the script cannot read",
      })
      expect(out.ops).toEqual([])
    })

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

/** A package file that classify-kind wrote and the host stamped. */
const packageFile = (
  name: string,
  root: string,
  extra: { sources?: string[]; summary?: string; body?: string } = {},
) =>
  front(
    {
      kind: "Service",
      name,
      summary: extra.summary ?? "A service in the example-org/shop repository.",
      generated_by: "ctxpipe-extract",
      sources: extra.sources ?? [SOURCE_PATH],
      root,
      source_sha: "0".repeat(40),
      skill: "classify-kind",
      bundle: "ingest-0000000000000000",
    },
    extra.body ??
      `# ${name}\n\nA script classified it as a service.\n\n## Related\n\n- \`example-org/shop\` has it at \`${root}\` (\`${root}/package.json\`)\n`,
  )

const fence = "```"

const API_README = [
  '<p align="center"><img src="logo.png" alt="logo"></p>',
  "",
  "# API",
  "",
  "[![CI](https://github.com/example-org/shop/actions/workflows/ci.yml/badge.svg)](https://github.com/example-org/shop/actions) [![npm](https://img.shields.io/npm/v/api.svg)](https://www.npmjs.com/package/api)",
  "",
  "The API serves the shop catalog and orders over HTTP.",
  "See the [guide](./docs/guide.md), the [hosting notes](https://hosting.example.com/notes), and `<Cart />`.",
  "",
  "![diagram](./docs/diagram.png)",
  "",
  "<!-- maintainers: keep this short -->",
  "",
  "## Usage",
  "",
  `${fence}sh`,
  "pnpm --filter api dev   # http://localhost:3000",
  fence,
  "",
  "Read <https://other.example.org/x>, [the root](../../README.md#setup), and [setup](#setup).",
  "",
  "[ref]: https://other.example.org/ref",
  "",
].join("\n")

const frontOf = (text: string) =>
  parse(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "") as Record<
    string,
    unknown
  >

describe("readmes skill", () => {
  it("quotes a package README into an Overview section and replaces the stub summary", async () => {
    const s = step(
      { ...PNPM_SHOP, "apps/api/README.md": API_README },
      {
        "knowledge/services/api.md": packageFile("api", "apps/api"),
        "knowledge/services/web.md": packageFile("web", "apps/web"),
      },
    )
    s.mapFiles({
      "apps/api": ["knowledge/services/api.md"],
      "apps/web": ["knowledge/services/web.md"],
    })
    const out = s.run("readmes")
    // apps/web has no README, so its file does not change.
    expect(out.ops).toEqual([
      { op: "update", path: "knowledge/services/api.md" },
    ])

    const result = await s.validate("readmes")
    expect(result.rejections).toEqual([])
    const api = s.show(result.tree, "knowledge/services/api.md")
    expect(frontOf(api).summary).toBe(
      "The API serves the shop catalog and orders over HTTP. See the guide, the hosting notes, and `<Cart />`.",
    )
    expect(api).toContain(
      [
        "# api",
        "",
        "A script classified it as a service.",
        "",
        "## Overview",
        "",
        "> The API serves the shop catalog and orders over HTTP.",
        "> See the guide, the hosting notes, and `<Cart />`.",
        ">",
        "> ## Usage",
        "",
        "Source: `apps/api/README.md`",
        "",
        `${fence}sh`,
        "pnpm --filter api dev   # http://localhost:3000",
        fence,
        "",
        "Source: `apps/api/README.md`",
        "",
        "> Read, the root, and setup.",
        "",
        "Source: `apps/api/README.md`",
        "",
        "## Related",
        "",
      ].join("\n"),
    )
    // Badges, images, HTML, and links to other hosts do not carry over.
    expect(api).not.toMatch(
      /shields|npmjs|diagram|logo|maintainers|other\.example|hosting\.example/,
    )
  })

  it("updates the section when the README changes, and changes nothing when it does not", async () => {
    const first = step(
      { ...PNPM_SHOP, "apps/api/README.md": "# API\n\nServes orders.\n" },
      { "knowledge/services/api.md": packageFile("api", "apps/api") },
    )
    first.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
    first.run("readmes")
    const written = first.show(
      (await first.validate("readmes")).tree,
      "knowledge/services/api.md",
    )
    expect(frontOf(written).summary).toBe("Serves orders.")

    // The next run: the root steps changed nothing, so the root map names
    // no file. The script finds the file by its host root.
    const changed = step(
      {
        ...PNPM_SHOP,
        "apps/api/README.md": "# API\n\nServes orders and refunds.\n",
      },
      { "knowledge/services/api.md": written },
    )
    expect(changed.run("readmes").ops).toEqual([
      { op: "update", path: "knowledge/services/api.md" },
    ])
    const result = await changed.validate("readmes")
    expect(result.rejections).toEqual([])
    const api = changed.show(result.tree, "knowledge/services/api.md")
    expect(frontOf(api).summary).toBe("Serves orders and refunds.")
    expect(api.match(/^## Overview$/gm)).toHaveLength(1)
    expect(api).toContain("> Serves orders and refunds.\n")
    expect(api).not.toContain("> Serves orders.\n")
    expect(api.trimEnd().endsWith("(`apps/api/package.json`)")).toBe(true)

    const same = step(
      {
        ...PNPM_SHOP,
        "apps/api/README.md": "# API\n\nServes orders and refunds.\n",
      },
      { "knowledge/services/api.md": api },
    )
    expect(same.run("readmes")).toEqual({ ops: [], skipped: [], more: false })
  })

  it("keeps a summary that is not a stub, and skips a shared file and an Overview that it did not write", async () => {
    const s = step(
      {
        ...PNPM_SHOP,
        "apps/api/README.md": "# API\n\nServes orders.\n",
        "apps/web/README.md": "# Web\n\nThe shop front.\n",
        "README.md": "# Shop\n\nThe shop monorepo.\n",
      },
      {
        "knowledge/services/api.md": packageFile("api", "apps/api", {
          summary: "The order API.",
          body: "# api\n\n## Overview\n\nA person wrote this.\n",
        }),
        "knowledge/services/web.md": packageFile("web", "apps/web", {
          sources: [SOURCE_PATH, "sources/github/example-org/other.md"],
        }),
        "knowledge/codebases/shop.md": front(
          {
            kind: "Repository",
            name: "example-org/shop",
            summary: "The source repository example-org/shop.",
            generated_by: "ctxpipe-extract",
            sources: [SOURCE_PATH],
            root: ".",
          },
          "# example-org/shop\n\nA script wrote this file.\n",
        ),
      },
    )
    s.mapFiles({
      "apps/api": ["knowledge/services/api.md"],
      "apps/web": ["knowledge/services/web.md"],
    })
    const out = s.run("readmes")
    // The repository unit gets the README at the top of the repository.
    expect(out.ops).toEqual([
      { op: "update", path: "knowledge/codebases/shop.md" },
    ])
    expect(out.skipped).toEqual([
      {
        path: "knowledge/services/api.md",
        reason: "The file has an Overview section that the skill did not write",
      },
      {
        path: "knowledge/services/web.md",
        reason: "The source does not own the file alone",
      },
    ])
    const result = await s.validate("readmes")
    expect(result.rejections).toEqual([])
    const shop = s.show(result.tree, "knowledge/codebases/shop.md")
    expect(frontOf(shop).summary).toBe("The shop monorepo.")
    expect(shop).toMatch(
      /A script wrote this file\.\n\n## Overview\n\n> The shop monorepo\.\n\nSource: `README\.md`$/,
    )
  })

  it("never writes into a human section and puts the section after it", async () => {
    const human =
      "<!-- ctxpipe:human -->\n## Overview\n\nOur notes.\n<!-- /ctxpipe:human -->"
    const s = step(
      { ...PNPM_SHOP, "apps/api/README.md": "# API\n\nServes orders.\n" },
      {
        "knowledge/services/api.md": packageFile("api", "apps/api", {
          body: `# api\n\n${human}\n\n## Related\n\n- A line\n`,
        }),
      },
    )
    s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
    expect(s.run("readmes").ops).toHaveLength(1)
    const result = await s.validate("readmes")
    expect(result.rejections).toEqual([])
    expect(s.show(result.tree, "knowledge/services/api.md")).toContain(
      `# api\n\n${human}\n\n## Overview\n\n> Serves orders.\n\nSource: \`apps/api/README.md\`\n\n## Related\n\n- A line`,
    )
  })

  it("cuts the quote at a paragraph under the size cap and before a heading about agents", async () => {
    const paragraph = (i: number) =>
      `Paragraph ${i} of the long guide. ${"The service keeps each order. ".repeat(4)}`
    const s = step(
      {
        ...PNPM_SHOP,
        "apps/api/README.md": [
          "# API",
          ...Array.from({ length: 60 }, (_, i) => `\n${paragraph(i + 1)}`),
        ].join("\n"),
        "apps/web/README.md": [
          "# Web",
          "",
          "The shop front.",
          "",
          "## Notes for AI agents",
          "",
          "Run the checks first.",
        ].join("\n"),
      },
      {
        "knowledge/services/api.md": packageFile("api", "apps/api"),
        "knowledge/services/web.md": packageFile("web", "apps/web"),
      },
    )
    s.mapFiles({
      "apps/api": ["knowledge/services/api.md"],
      "apps/web": ["knowledge/services/web.md"],
    })
    expect(s.run("readmes").ops).toHaveLength(2)
    const result = await s.validate("readmes")
    expect(result.rejections).toEqual([])

    const api = s.show(result.tree, "knowledge/services/api.md")
    const quote = /## Overview\n\n([\s\S]*?)\n\nSource:/.exec(api)?.[1] ?? ""
    expect(quote.length).toBeLessThanOrEqual(4000)
    expect(quote.length).toBeGreaterThan(3000)
    expect(quote).toContain("> Paragraph 1 of the long guide.")
    expect(quote).not.toContain("Paragraph 60 ")
    expect(quote.endsWith("each order.")).toBe(true)

    const web = s.show(result.tree, "knowledge/services/web.md")
    expect(web).toContain("> The shop front.\n\nSource: `apps/web/README.md`")
    expect(web).not.toMatch(/agents|Run the checks/)
  })

  it("keeps the text of each link and drops its target", async () => {
    const { readmeOverview } = await import(
      join(INGEST_SKILLS_DIR, "readmes/scripts/readme-quote.mjs")
    )
    const text = [
      "# Tools",
      "",
      'See [docs](docs/a.md), [up](../../../x.md), [issues](https://github.com/example-org/shop/issues), [fork](https://github.com/someone/shop), [top](#top), and [wiki](https://x.example/x_(y) "Wiki").',
    ].join("\n")
    expect(readmeOverview(text, "tools/README.md").quote).toBe(
      "> See docs, up, issues, fork, top, and wiki.\n\nSource: `tools/README.md`",
    )
    expect(
      readmeOverview("# Only a title\n\n![logo](logo.png)\n", "README.md"),
    ).toBeNull()
  })

  it("reads a setext heading as a heading", async () => {
    const { readmeOverview } = await import(
      join(INGEST_SKILLS_DIR, "readmes/scripts/readme-quote.mjs")
    )
    // The title goes, and a setext heading is never the summary.
    expect(readmeOverview("API\n===\n\nServes orders.\n", "README.md")).toEqual(
      {
        quote: "> Serves orders.\n\nSource: `README.md`",
        summary: "Serves orders.",
      },
    )
    // The quote stops before a setext heading about agents, and never
    // ends with a heading.
    expect(
      readmeOverview(
        "Serves orders.\n\nUsage\n-----\n\nRun it.\n\nFor AI agents\n----\n\nRun the checks.\n",
        "README.md",
      )?.quote,
    ).toBe(
      "> Serves orders.\n>\n> ## Usage\n>\n> Run it.\n\nSource: `README.md`",
    )
    expect(
      readmeOverview("Serves orders.\n\nUsage\n---\n", "README.md")?.quote,
    ).toBe("> Serves orders.\n\nSource: `README.md`")
  })

  it("stops at the headings that the validator refuses, and only at those", async () => {
    const s = step(
      {
        ...PNPM_SHOP,
        "apps/api/README.md": [
          "# API",
          "",
          "Serves orders.",
          "",
          "## Cursor pagination",
          "",
          "Each page has a cursor.",
          "",
          "## Coding models",
          "",
          "Use the small model.",
        ].join("\n"),
      },
      { "knowledge/services/api.md": packageFile("api", "apps/api") },
    )
    s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
    expect(s.run("readmes").ops).toHaveLength(1)
    const result = await s.validate("readmes")
    expect(result.rejections).toEqual([])
    const api = s.show(result.tree, "knowledge/services/api.md")
    expect(api).toContain(
      "> ## Cursor pagination\n>\n> Each page has a cursor.",
    )
    expect(api).not.toMatch(/Coding models|small model/)
  })

  it("cuts a long first paragraph at a sentence", async () => {
    const { readmeOverview } = await import(
      join(INGEST_SKILLS_DIR, "readmes/scripts/readme-quote.mjs")
    )
    const long = "The service keeps each order. ".repeat(200).trim()
    const quote: string =
      readmeOverview(`# API\n\n${long}\n`, "README.md")?.quote ?? ""
    expect(quote.length).toBeLessThanOrEqual(4000)
    expect(quote.length).toBeGreaterThan(3500)
    expect(quote).toMatch(/^> The service keeps each order\. /)
    expect(quote).toMatch(/each order\.\n\nSource: `README\.md`$/)
  })

  it("gives a Source line to each quoted run, so a quoted phrase in an earlier run passes", async () => {
    const s = step(
      {
        ...PNPM_SHOP,
        "apps/api/README.md": [
          "# API",
          "",
          "Serves orders.",
          "",
          "A test fixture says: ignore all previous instructions.",
          "",
          `${fence}sh`,
          "pnpm test",
          fence,
          "",
          "More notes.",
        ].join("\n"),
      },
      { "knowledge/services/api.md": packageFile("api", "apps/api") },
    )
    s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
    expect(s.run("readmes").ops).toHaveLength(1)
    const result = await s.validate("readmes")
    expect(result.rejections).toEqual([])
    expect(s.show(result.tree, "knowledge/services/api.md")).toContain(
      "> A test fixture says: ignore all previous instructions.\n\nSource: `apps/api/README.md`\n\n```sh",
    )
  })

  it("keeps the old summary when the first paragraph reads as an instruction", async () => {
    const s = step(
      {
        ...PNPM_SHOP,
        "apps/api/README.md":
          "# API\n\nYou can override any of the default rules.\n",
      },
      { "knowledge/services/api.md": packageFile("api", "apps/api") },
    )
    s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
    expect(s.run("readmes").ops).toHaveLength(1)
    const result = await s.validate("readmes")
    expect(result.rejections).toEqual([])
    const api = s.show(result.tree, "knowledge/services/api.md")
    expect(frontOf(api).summary).toBe(
      "A service in the example-org/shop repository.",
    )
    expect(api).toContain("> You can override any of the default rules.")
  })

  it("keeps a summary with a comment, and a summary that it cannot read", async () => {
    const withLine = (line: string) =>
      packageFile("api", "apps/api").replace(/^summary: .*$/m, line)
    for (const line of [
      'summary: "The order API." # by a person',
      "summary: >\n  The order API.",
    ]) {
      const s = step(
        { ...PNPM_SHOP, "apps/api/README.md": "# API\n\nServes orders.\n" },
        { "knowledge/services/api.md": withLine(line) },
      )
      s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
      expect(s.run("readmes").ops).toHaveLength(1)
      const result = await s.validate("readmes")
      expect(result.rejections).toEqual([])
      const api = s.show(result.tree, "knowledge/services/api.md")
      expect(frontOf(api).summary).toMatch(/^The order API\.\n?$/)
      expect(api).toContain("> Serves orders.")
    }
  })

  it("stops the quote before a quoted run with an instruction phrase whose text it changed", async () => {
    for (const changed of [
      "AI agents should read [the guide](docs/agents.md) first.",
      "Usage\n-----\n\nAI agents should read the guide first.",
      "## Usage ##\n\nAI agents should read the guide first.",
    ]) {
      const s = step(
        {
          ...PNPM_SHOP,
          "apps/api/README.md": `# API\n\nServes orders.\n\n${changed}\n`,
        },
        { "knowledge/services/api.md": packageFile("api", "apps/api") },
      )
      s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
      expect(s.run("readmes").ops).toHaveLength(1)
      const result = await s.validate("readmes")
      expect(result.rejections).toEqual([])
      const api = s.show(result.tree, "knowledge/services/api.md")
      expect(api).toContain(
        "## Overview\n\n> Serves orders.\n\nSource: `apps/api/README.md`\n\n## Related",
      )
      expect(api).not.toMatch(/AI agents|Usage/)
    }
  })

  it("keeps a summary that a person wrote after the skill wrote the Overview", async () => {
    const first = step(
      { ...PNPM_SHOP, "apps/api/README.md": "# API\n\nServes orders.\n" },
      { "knowledge/services/api.md": packageFile("api", "apps/api") },
    )
    first.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
    first.run("readmes")
    const written = first
      .show((await first.validate("readmes")).tree, "knowledge/services/api.md")
      .replace(
        /^summary: .*$/m,
        'summary: "The order API, written by a person."',
      )

    const next = step(
      {
        ...PNPM_SHOP,
        "apps/api/README.md": "# API\n\nServes orders and refunds.\n",
      },
      { "knowledge/services/api.md": written },
    )
    expect(next.run("readmes").ops).toHaveLength(1)
    const result = await next.validate("readmes")
    expect(result.rejections).toEqual([])
    const api = next.show(result.tree, "knowledge/services/api.md")
    expect(frontOf(api).summary).toBe("The order API, written by a person.")
    expect(api).toContain("> Serves orders and refunds.\n")
  })

  it("stops before a heading that the validator refuses after it decodes a character reference", async () => {
    for (const heading of ["## For &#65;I agents", "## Coding&nbsp;models"]) {
      const s = step(
        {
          ...PNPM_SHOP,
          "apps/api/README.md": `# API\n\nServes orders.\n\n${heading}\n\nRun the checks.\n`,
        },
        { "knowledge/services/api.md": packageFile("api", "apps/api") },
      )
      s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
      expect(s.run("readmes").ops).toHaveLength(1)
      const result = await s.validate("readmes")
      expect(result.rejections).toEqual([])
      const api = s.show(result.tree, "knowledge/services/api.md")
      expect(api).toContain("> Serves orders.\n\nSource: `apps/api/README.md`")
      expect(api).not.toContain("Run the checks")
    }
  })

  it("updates its own summary again after a README version that gives no summary", async () => {
    for (const middle of [
      "```\nnpm i\n```",
      "AI agents should read the guide.\n\nServes refunds.",
    ]) {
      let file = packageFile("api", "apps/api")
      for (const text of ["Serves orders.", middle, "Serves carts."]) {
        const s = step(
          { ...PNPM_SHOP, "apps/api/README.md": `# API\n\n${text}\n` },
          { "knowledge/services/api.md": file },
        )
        s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
        s.run("readmes")
        const result = await s.validate("readmes")
        expect(result.rejections).toEqual([])
        file = s.show(result.tree, "knowledge/services/api.md")
      }
      expect(frontOf(file).summary).toBe("Serves carts.")
    }
  })

  it("reads no README that is a symbolic link", () => {
    const s = step(PNPM_SHOP, {
      "knowledge/services/api.md": packageFile("api", "apps/api"),
    })
    symlinkSync("../../package.json", join(s.sourceDir, "apps/api/README.md"))
    git(s.sourceDir, "add", "-A")
    git(s.sourceDir, "commit", "-q", "-m", "link")
    s.mapFiles({ "apps/api": ["knowledge/services/api.md"] })
    expect(s.run("readmes")).toEqual({ ops: [], skipped: [], more: false })
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
