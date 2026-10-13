import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { INGEST_SKILLS_DIR } from "./skill-bundle.js"

/*
 * The discover-roots script runs on real git checkouts. The layouts copy the
 * workspace manifests of public monorepos: vitejs/vite (pnpm), tokio-rs/tokio
 * (Cargo), golang/tools (go.work), and astral-sh/uv style uv workspaces.
 */

const made: string[] = []

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "discover-roots-"))
  made.push(dir)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.com",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.com",
      },
    })
  git("init", "-q", "-b", "main")
  git("add", "-A")
  git("commit", "-q", "--allow-empty", "-m", "fixture")
  return dir
}

type Result = {
  roots: Array<{ path: string; manifests: string[]; evidence: string[] }>
  ambiguous: Array<{
    manifest: string | null
    reason: string
    candidates: string[]
  }>
}

function discover(dir: string): Result {
  const run = spawnSync(
    process.execPath,
    [join(INGEST_SKILLS_DIR, "discover-roots/scripts/discover-roots.mjs"), dir],
    { encoding: "utf8" },
  )
  expect(run.status, run.stderr).toBe(0)
  return JSON.parse(run.stdout)
}

const pkg = (name: string, extra: object = {}) =>
  JSON.stringify({ name, version: "1.0.0", ...extra })

describe("discover-roots script", () => {
  it("finds pnpm workspace packages from globs, with negation (vitejs/vite layout)", () => {
    const dir = repo({
      "package.json": pkg("vite-monorepo", { private: true }),
      "pnpm-workspace.yaml": [
        "packages:",
        "  - 'packages/*'",
        '  - "playground/**"',
        "  - '!**/__tests__/**'",
        "",
        "catalog:",
        "  rollup: ^4.0.0",
      ].join("\n"),
      "packages/vite/package.json": pkg("vite"),
      "packages/vite/src/node/index.ts": "export {}\n",
      "packages/create-vite/package.json": pkg("create-vite"),
      "packages/README.md": "# Packages\n",
      "playground/alias/package.json": pkg("@vitejs/test-alias"),
      "playground/ssr/nested/package.json": pkg("@vitejs/test-ssr-nested"),
      "playground/ssr/__tests__/fixture/package.json": pkg("fixture"),
      "docs/package.json": pkg("docs"),
    })
    expect(discover(dir)).toEqual({
      roots: [
        {
          path: "packages/create-vite",
          manifests: ["package.json"],
          evidence: ["pnpm-workspace.yaml"],
        },
        {
          path: "packages/vite",
          manifests: ["package.json"],
          evidence: ["pnpm-workspace.yaml"],
        },
        {
          path: "playground/alias",
          manifests: ["package.json"],
          evidence: ["pnpm-workspace.yaml"],
        },
        {
          path: "playground/ssr/nested",
          manifests: ["package.json"],
          evidence: ["pnpm-workspace.yaml"],
        },
      ],
      ambiguous: [],
    })
  })

  it("finds npm workspaces in package.json", () => {
    const dir = repo({
      "package.json": pkg("root", {
        private: true,
        workspaces: { packages: ["apps/*", "libs/shared"] },
      }),
      "apps/web/package.json": pkg("web"),
      "apps/api/package.json": pkg("api"),
      "libs/shared/package.json": pkg("shared"),
      "libs/unlisted/package.json": pkg("unlisted"),
    })
    expect(discover(dir).roots.map((r) => r.path)).toEqual([
      "apps/api",
      "apps/web",
      "libs/shared",
    ])
  })

  it("finds Cargo workspace members, skips excludes, and keeps a root package (tokio-rs/tokio layout)", () => {
    const dir = repo({
      "Cargo.toml": [
        "[workspace]",
        'resolver = "2"',
        "members = [",
        '  "tokio",',
        '  "tokio-macros", # proc macros',
        '  "crates/*",',
        "]",
        'exclude = ["crates/legacy"]',
        "",
        "[workspace.dependencies]",
        'serde = "1"',
      ].join("\n"),
      "tokio/Cargo.toml": '[package]\nname = "tokio"\n',
      "tokio-macros/Cargo.toml": '[package]\nname = "tokio-macros"\n',
      "crates/tokio-util/Cargo.toml": '[package]\nname = "tokio-util"\n',
      "crates/legacy/Cargo.toml": '[package]\nname = "legacy"\n',
      "benches/Cargo.toml": '[package]\nname = "benches"\n',
    })
    expect(discover(dir)).toEqual({
      roots: [
        {
          path: "crates/tokio-util",
          manifests: ["Cargo.toml"],
          evidence: ["Cargo.toml"],
        },
        { path: "tokio", manifests: ["Cargo.toml"], evidence: ["Cargo.toml"] },
        {
          path: "tokio-macros",
          manifests: ["Cargo.toml"],
          evidence: ["Cargo.toml"],
        },
      ],
      ambiguous: [],
    })

    const withRootCrate = repo({
      "Cargo.toml":
        '[package]\nname = "cli"\n\n[workspace]\nmembers = ["helper"]\n',
      "helper/Cargo.toml": '[package]\nname = "helper"\n',
    })
    expect(discover(withRootCrate).roots.map((r) => r.path)).toEqual([
      ".",
      "helper",
    ])
  })

  it("finds go.work modules, also the repository root (golang/tools layout)", () => {
    const dir = repo({
      "go.work": [
        "go 1.23",
        "",
        "use (",
        "\t.",
        "\t./gopls // the language server",
        ")",
        "use ./cmd/tool",
      ].join("\n"),
      "go.mod": "module golang.org/x/tools\n",
      "gopls/go.mod": "module golang.org/x/tools/gopls\n",
      "cmd/tool/go.mod": "module example.com/tool\n",
      "internal/testdata/go.mod": "module testdata\n",
    })
    expect(discover(dir)).toEqual({
      roots: [
        { path: ".", manifests: ["go.mod"], evidence: ["go.work"] },
        { path: "cmd/tool", manifests: ["go.mod"], evidence: ["go.work"] },
        { path: "gopls", manifests: ["go.mod"], evidence: ["go.work"] },
      ],
      ambiguous: [],
    })
  })

  it("finds uv workspace members in pyproject.toml", () => {
    const dir = repo({
      "pyproject.toml": [
        "[project]",
        'name = "root"',
        "",
        "[tool.uv.workspace]",
        'members = ["packages/*"]',
      ].join("\n"),
      "packages/core/pyproject.toml": '[project]\nname = "core"\n',
      "packages/cli/pyproject.toml": '[project]\nname = "cli"\n',
    })
    expect(discover(dir).roots.map((r) => r.path)).toEqual([
      "packages/cli",
      "packages/core",
    ])
  })

  it("finds Maven modules and Gradle includes", () => {
    const maven = repo({
      "pom.xml":
        "<project><modules><module>api</module><module>core/</module></modules></project>",
      "api/pom.xml": "<project/>",
      "core/pom.xml": "<project/>",
    })
    expect(discover(maven).roots.map((r) => r.path)).toEqual(["api", "core"])

    const gradle = repo({
      "settings.gradle.kts": 'include(":app", ":libs:network")\n',
      "app/build.gradle.kts": "plugins {}\n",
      "libs/network/build.gradle.kts": "plugins {}\n",
    })
    expect(discover(gradle).roots).toEqual([
      {
        path: "app",
        manifests: ["build.gradle.kts"],
        evidence: ["settings.gradle.kts"],
      },
      {
        path: "libs/network",
        manifests: ["build.gradle.kts"],
        evidence: ["settings.gradle.kts"],
      },
    ])
  })

  it("gives the repository root for a single-package repository", () => {
    const dir = repo({
      "package.json": pkg("single"),
      "src/index.ts": "export {}\n",
    })
    expect(discover(dir)).toEqual({
      roots: [{ path: ".", manifests: ["package.json"], evidence: ["."] }],
      ambiguous: [],
    })
  })

  it("gives the repository root for a repository with no manifest", () => {
    const dir = repo({ "README.md": "# Notes\n" })
    expect(discover(dir)).toEqual({
      roots: [{ path: ".", manifests: [], evidence: ["."] }],
      ambiguous: [],
    })
  })

  it("lists nested manifests that no workspace manifest names as ambiguous", () => {
    const dir = repo({
      "package.json": pkg("site"),
      "examples/basic/package.json": pkg("example-basic"),
      "services/worker/go.mod": "module example.com/worker\n",
      "test/fixtures/app/package.json": pkg("fixture"),
      "vendor/lib/go.mod": "module vendored\n",
      ".github/actions/setup/package.json": pkg("action"),
    })
    expect(discover(dir)).toEqual({
      roots: [{ path: ".", manifests: ["package.json"], evidence: ["."] }],
      ambiguous: [
        {
          manifest: null,
          reason: "No workspace manifest names these folders",
          candidates: ["examples/basic", "services/worker"],
        },
      ],
    })
  })

  it("marks a workspace manifest that it cannot read as ambiguous", () => {
    const dir = repo({
      "package.json": pkg("root", { private: true }),
      "pnpm-workspace.yaml": "packages: [apps/*]\n",
      "apps/web/package.json": pkg("web"),
      "nx.json": "{}\n",
    })
    expect(discover(dir)).toEqual({
      roots: [],
      ambiguous: [
        {
          manifest: "nx.json",
          reason: "nx.json has no project list that the script can read",
          candidates: ["apps/web"],
        },
        {
          manifest: "pnpm-workspace.yaml",
          reason: "The script found no package list in the file",
          candidates: ["apps/web"],
        },
      ],
    })
  })

  it("marks a listed path or glob that finds no package as ambiguous", () => {
    const dir = repo({
      "package.json": pkg("root", {
        private: true,
        workspaces: ["apps/*", "tools/missing", "plugins/*"],
      }),
      "apps/web/package.json": pkg("web"),
      "tools/missing/README.md": "# Not a package\n",
    })
    const result = discover(dir)
    expect(result.roots.map((r) => r.path)).toEqual(["apps/web"])
    expect(result.ambiguous).toEqual([
      {
        manifest: "package.json",
        reason: "These entries name no folder with package.json: plugins/*",
        candidates: [],
      },
      {
        manifest: "package.json",
        reason: "These entries name no folder with package.json: tools/missing",
        candidates: ["tools/missing"],
      },
    ])
  })

  it("reads a nested checkout path and ignores files outside git", () => {
    const dir = repo({
      "package.json": pkg("root", { private: true, workspaces: ["apps/*"] }),
      "apps/web/package.json": pkg("web"),
    })
    // An untracked package (for example from an install) is not a root.
    mkdirSync(join(dir, "apps/untracked"), { recursive: true })
    writeFileSync(join(dir, "apps/untracked/package.json"), pkg("untracked"))
    expect(discover(dir).roots.map((r) => r.path)).toEqual(["apps/web"])
  })
})
