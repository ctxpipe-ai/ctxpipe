import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterAll, describe, expect, it } from "vitest"

import { INGEST_SKILLS_DIR } from "./skill-bundle.js"

/*
 * The discover-roots script runs on real git checkouts. The layouts copy the
 * workspace manifests of public monorepos: vitejs/vite (pnpm), tokio-rs/tokio
 * and rust-lang/rust (Cargo), golang/tools and kubernetes/kubernetes (Go),
 * and astral-sh/uv style uv workspaces.
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
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
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
    candidates: Array<{ path: string; manifests: string[] }>
  }>
  skipped: Array<{ manifest: string | null; reason: string }>
}

function discover(dir: string): Result {
  const run = spawnSync(
    process.execPath,
    [join(INGEST_SKILLS_DIR, "discover-roots/scripts/discover-roots.mjs"), dir],
    { encoding: "utf8", timeout: 20_000 },
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
      skipped: [],
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
      skipped: [],
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

  it("follows Cargo path dependencies of members, in the workspace folder (rust-lang/rust layout)", () => {
    const dir = repo({
      "Cargo.toml": [
        "[workspace]",
        'members = ["compiler/rustc"]',
        'exclude = ["compiler/rustc_codegen_gcc"]',
        "",
        "[workspace.dependencies]",
        'rustc_lexer = { path = "compiler/rustc_lexer" }',
        "",
        "[patch.crates-io]",
        'patched = { path = "compiler/patched" }',
      ].join("\n"),
      "compiler/rustc/Cargo.toml": [
        "[package]",
        'name = "rustc-main"',
        "",
        "[[bin]]",
        'name = "rustc"',
        'path = "src/main.rs"',
        "",
        "[dependencies]",
        'rustc_driver = { path = "../rustc_driver" }',
        'rustc_codegen_gcc = { path = "../rustc_codegen_gcc" }',
        'gcc_build = { path = "../rustc_codegen_gcc/build_system" }',
        'outside = { path = "../../../outside" }',
        'no_crate = { path = "../no_crate" }',
        "",
        "[target.'cfg(windows)'.build-dependencies]",
        "rustc_windows_rc = { path = '../rustc_windows_rc' }",
      ].join("\n"),
      "compiler/rustc_driver/Cargo.toml": [
        "[package]",
        'name = "rustc_driver"',
        "",
        "[dependencies.rustc_span]",
        'path = "../rustc_span"',
        "",
        "[dev-dependencies]",
        "rustc_lexer.workspace = true",
      ].join("\n"),
      "compiler/rustc_span/Cargo.toml":
        '[package]\nname = "rustc_span"\n\n[dependencies]\nrustc_driver = { path = "../rustc_driver" }\n',
      "compiler/rustc_lexer/Cargo.toml": '[package]\nname = "rustc_lexer"\n',
      "compiler/rustc_windows_rc/Cargo.toml":
        '[package]\nname = "rustc_windows_rc"\n',
      "compiler/rustc_codegen_gcc/Cargo.toml":
        '[package]\nname = "rustc_codegen_gcc"\n',
      // Cargo excludes each folder below an excluded folder too.
      "compiler/rustc_codegen_gcc/build_system/Cargo.toml":
        '[package]\nname = "gcc_build"\n',
      "compiler/patched/Cargo.toml": '[package]\nname = "patched"\n',
      "compiler/no_crate/README.md": "# Not a crate\n",
      "compiler/unused/Cargo.toml": '[package]\nname = "unused"\n',
    })
    expect(discover(dir)).toEqual({
      roots: [
        {
          path: "compiler/rustc",
          manifests: ["Cargo.toml"],
          evidence: ["Cargo.toml"],
        },
        {
          path: "compiler/rustc_driver",
          manifests: ["Cargo.toml"],
          evidence: ["compiler/rustc/Cargo.toml"],
        },
        {
          path: "compiler/rustc_lexer",
          manifests: ["Cargo.toml"],
          evidence: ["Cargo.toml"],
        },
        {
          path: "compiler/rustc_span",
          manifests: ["Cargo.toml"],
          evidence: ["compiler/rustc_driver/Cargo.toml"],
        },
        {
          path: "compiler/rustc_windows_rc",
          manifests: ["Cargo.toml"],
          evidence: ["compiler/rustc/Cargo.toml"],
        },
      ],
      ambiguous: [],
      skipped: [],
    })
  })

  it("finds nested Cargo workspaces and their path dependencies, not in test folders", () => {
    const dir = repo({
      "Cargo.toml": '[workspace]\nmembers = ["src/tools/x"]\n',
      "src/tools/x/Cargo.toml": '[package]\nname = "x"\n',
      // A virtual workspace: its members and their path dependencies are roots.
      "library/Cargo.toml": '[workspace]\nmembers = ["std"]\n',
      "library/std/Cargo.toml":
        '[package]\nname = "std"\n\n[dependencies]\ncore = { path = "../core" }\n',
      "library/core/Cargo.toml": '[package]\nname = "core"\n',
      // A workspace with a root package and a member glob.
      "src/tools/rust-analyzer/Cargo.toml": [
        "[package]",
        'name = "rust-analyzer-root"',
        "",
        "[workspace]",
        'members = ["crates/*", "./xtask/"]',
        'exclude = ["crates/old"]',
      ].join("\n"),
      "src/tools/rust-analyzer/crates/ide/Cargo.toml":
        '[package]\nname = "ide"\n',
      "src/tools/rust-analyzer/crates/old/Cargo.toml":
        '[package]\nname = "old"\n',
      "src/tools/rust-analyzer/xtask/Cargo.toml": '[package]\nname = "xtask"\n',
      // Workspaces in test folders are fixtures.
      "tests/run-make/ws/Cargo.toml": '[workspace]\nmembers = ["a"]\n',
      "tests/run-make/ws/a/Cargo.toml": '[package]\nname = "a"\n',
      "src/tools/miri/test-cargo-miri/Cargo.toml":
        '[package]\nname = "cargo-miri-test"\n\n[workspace]\nmembers = ["subcrate"]\n',
      "src/tools/miri/test-cargo-miri/subcrate/Cargo.toml":
        '[package]\nname = "subcrate"\n',
    })
    expect(discover(dir)).toEqual({
      roots: [
        {
          path: "library/core",
          manifests: ["Cargo.toml"],
          evidence: ["library/std/Cargo.toml"],
        },
        {
          path: "library/std",
          manifests: ["Cargo.toml"],
          evidence: ["library/Cargo.toml"],
        },
        {
          path: "src/tools/rust-analyzer",
          manifests: ["Cargo.toml"],
          evidence: ["src/tools/rust-analyzer/Cargo.toml"],
        },
        {
          path: "src/tools/rust-analyzer/crates/ide",
          manifests: ["Cargo.toml"],
          evidence: ["src/tools/rust-analyzer/Cargo.toml"],
        },
        {
          path: "src/tools/rust-analyzer/xtask",
          manifests: ["Cargo.toml"],
          evidence: ["src/tools/rust-analyzer/Cargo.toml"],
        },
        {
          path: "src/tools/x",
          manifests: ["Cargo.toml"],
          evidence: ["Cargo.toml"],
        },
      ],
      ambiguous: [],
      skipped: [],
    })
  })

  it("keeps the single-root fallback when only a nested folder has a Cargo workspace", () => {
    const dir = repo({
      "package.json": pkg("site"),
      "tools/Cargo.toml": '[workspace]\nmembers = ["gen"]\n',
      "tools/gen/Cargo.toml": '[package]\nname = "gen"\n',
      "web/package.json": pkg("web"),
    })
    expect(discover(dir)).toEqual({
      roots: [
        { path: ".", manifests: ["package.json"], evidence: ["."] },
        {
          path: "tools/gen",
          manifests: ["Cargo.toml"],
          evidence: ["tools/Cargo.toml"],
        },
      ],
      ambiguous: [
        {
          manifest: null,
          reason: "No workspace manifest names these folders",
          // `tools` is a workspace with no package, and `tools/gen` is a root.
          candidates: [{ path: "web", manifests: ["package.json"] }],
        },
      ],
      skipped: [],
    })
  })

  it("follows the path dependencies of a root Cargo package with no workspace", () => {
    const dir = repo({
      "Cargo.toml":
        '[package]\nname = "cli"\n\n[dependencies]\nhelper = { path = "helper" }\n',
      "helper/Cargo.toml": '[package]\nname = "helper"\n',
      "docs/package.json": pkg("docs"),
    })
    expect(discover(dir)).toEqual({
      roots: [
        { path: ".", manifests: ["Cargo.toml"], evidence: ["."] },
        {
          path: "helper",
          manifests: ["Cargo.toml"],
          evidence: ["Cargo.toml"],
        },
      ],
      ambiguous: [
        {
          manifest: null,
          reason: "No workspace manifest names these folders",
          candidates: [{ path: "docs", manifests: ["package.json"] }],
        },
      ],
      skipped: [],
    })
  })

  it("finds a Go main package in a module as a root (kubernetes/kubernetes layout)", () => {
    const license =
      "/*\nCopyright 2014 The Kubernetes Authors.\n\npackage notmain\n*/\n\n"
    const dir = repo({
      "go.work": "go 1.24\n\nuse (\n\t.\n\t./staging/src/k8s.io/api\n)\n",
      "go.mod": "module k8s.io/kubernetes\n",
      "staging/src/k8s.io/api/go.mod": "module k8s.io/api\n",
      "cmd/kubelet/kubelet.go": `${license}// Package main is the kubelet.\npackage main\n\nfunc main() {}\n`,
      "cmd/kubelet/app/server.go": `${license}package app\n`,
      // The first file is a generator that a build constraint ignores.
      "cmd/kubectl/a_gen.go": "//go:build ignore\n\npackage main\n",
      "cmd/kubectl/kubectl.go": "package main // the CLI\n",
      // An ignored file of another package does not hide the main package.
      "cmd/kubeadm/a_gen.go": "//go:build ignore\n\npackage generator\n",
      "cmd/kubeadm/kubeadm.go": "package main\n",
      "hack/gen/gen.go":
        "//go:build ignore\n// +build ignore\n\npackage main\n",
      // A constraint that some build can satisfy keeps the file.
      "cmd/kubectl-convert/main.go": "//go:build !(ignore)\n\npackage main\n",
      "cmd/kube-proxy/main.go": "//go:build linux || ignore\n\npackage main\n",
      "cmd/kube-scheduler/main.go": "// +build !ignore\n\npackage main\n",
      // No build can satisfy these constraints.
      "cmd/gen-a/main.go": "//go:build linux && ignore\n\npackage main\n",
      "cmd/gen-b/main.go": "// +build ignore,linux\n\npackage main\n",
      "pkg/util/util.go": "package util\n",
      "pkg/tool/main_test.go": "package main\n",
      "test/e2e/main.go": "package main\n",
      "cmd/e2e-tests/main.go": "package main\n",
      "pkg/generated/openapi/cmd/models-schema/main.go": "package main\n",
      "staging/src/k8s.io/kms/internal/plugins/_mock/plugin.go":
        "package main\n",
      // The go tool does not build a file whose name starts with `_` or `.`.
      "cmd/old/_main.go": "package main\n",
      "cmd/old/.main.go": "package main\n",
      "vendor/github.com/x/cmd/x/main.go": "package main\n",
      "staging/src/k8s.io/api/cmd/apigen/main.go": "package main\n",
    })
    expect(discover(dir)).toEqual({
      roots: [
        { path: ".", manifests: ["go.mod"], evidence: ["go.work"] },
        {
          path: "cmd/kube-proxy",
          manifests: [],
          evidence: ["cmd/kube-proxy/main.go"],
        },
        {
          path: "cmd/kube-scheduler",
          manifests: [],
          evidence: ["cmd/kube-scheduler/main.go"],
        },
        {
          path: "cmd/kubeadm",
          manifests: [],
          evidence: ["cmd/kubeadm/kubeadm.go"],
        },
        {
          path: "cmd/kubectl",
          manifests: [],
          evidence: ["cmd/kubectl/kubectl.go"],
        },
        {
          path: "cmd/kubectl-convert",
          manifests: [],
          evidence: ["cmd/kubectl-convert/main.go"],
        },
        {
          path: "cmd/kubelet",
          manifests: [],
          evidence: ["cmd/kubelet/kubelet.go"],
        },
        {
          path: "staging/src/k8s.io/api",
          manifests: ["go.mod"],
          evidence: ["go.work"],
        },
        {
          path: "staging/src/k8s.io/api/cmd/apigen",
          manifests: [],
          evidence: ["staging/src/k8s.io/api/cmd/apigen/main.go"],
        },
      ],
      ambiguous: [],
      skipped: [],
    })

    // With no go.mod, a Go file is not in a module, so it gives no root.
    const noModule = repo({
      "package.json": pkg("site"),
      "scripts/tool/main.go": "package main\n",
    })
    expect(discover(noModule).roots.map((r) => r.path)).toEqual(["."])
  })

  it("gives more than 2000 roots, with no count limit", () => {
    const files: Record<string, string> = {
      "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    }
    for (let i = 0; i < 2100; i++)
      files[`crates/c${String(i).padStart(4, "0")}/Cargo.toml`] =
        `[package]\nname = "c${i}"\n`
    const result = discover(repo(files))
    expect(result.roots).toHaveLength(2100)
    expect(result.skipped).toEqual([])
  })

  it("keeps the result below its byte limit: candidates go first, then roots, with a skipped entry", async () => {
    const lib = await import(
      join(INGEST_SKILLS_DIR, "discover-roots/scripts/roots-lib.mjs")
    )
    const item = (path: string) => ({
      path,
      manifests: ["Cargo.toml"],
      evidence: ["Cargo.toml"],
    })
    const result = {
      roots: Array.from({ length: 20 }, (_, i) => item(`r/${i}`)),
      ambiguous: [
        {
          manifest: null,
          reason: "No workspace manifest names these folders",
          candidates: Array.from({ length: 20 }, (_, i) => ({
            path: `c/${i}`,
            manifests: ["package.json"],
          })),
        },
      ],
      skipped: [],
    }
    expect(lib.fitResult(result, 100_000)).toBe(result)

    const withRoots = lib.fitResult(result, 1000)
    // The skipped entry is in the limit too.
    expect(Buffer.byteLength(JSON.stringify(withRoots))).toBeLessThanOrEqual(
      1000,
    )
    expect(withRoots.ambiguous).toEqual([])
    expect(withRoots.roots.length).toBeGreaterThan(0)
    expect(withRoots.roots.length).toBeLessThan(20)
    expect(withRoots.roots).toEqual(
      result.roots.slice(0, withRoots.roots.length),
    )
    expect(withRoots.skipped).toEqual([
      {
        manifest: null,
        reason: `The result of the script must be at most 1000 bytes, so it gives only the first ${withRoots.roots.length} roots, 0 candidates, and 0 other skipped entries`,
      },
    ])

    // Skipped entries go before roots, so a long skipped list cannot push
    // the result over the limit.
    const noisy = {
      ...result,
      skipped: Array.from({ length: 200 }, (_, i) => ({
        manifest: "pnpm-workspace.yaml",
        reason: `The script skipped an entry: ${i}`,
      })),
    }
    const fitted = lib.fitResult(noisy, 2000)
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(2000)
    expect(fitted.roots.length).toBeGreaterThan(0)
    expect(fitted.skipped.length).toBeLessThan(200)
    expect(fitted.skipped.at(-1).reason).toContain("other skipped entries")

    const someCandidates = lib.fitResult(result, 2000)
    expect(someCandidates.roots).toHaveLength(20)
    expect(someCandidates.ambiguous[0].candidates.length).toBeLessThan(20)
    expect(someCandidates.skipped).toHaveLength(1)
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
      skipped: [],
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
      skipped: [],
    })
  })

  it("gives the repository root for a repository with no manifest", () => {
    const dir = repo({ "README.md": "# Notes\n" })
    expect(discover(dir)).toEqual({
      roots: [{ path: ".", manifests: [], evidence: ["."] }],
      ambiguous: [],
      skipped: [],
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
          candidates: [
            { path: "examples/basic", manifests: ["package.json"] },
            { path: "services/worker", manifests: ["go.mod"] },
          ],
        },
      ],
      skipped: [],
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
          candidates: [{ path: "apps/web", manifests: ["package.json"] }],
        },
        {
          manifest: "pnpm-workspace.yaml",
          reason: "The script found no package list in the file",
          candidates: [{ path: "apps/web", manifests: ["package.json"] }],
        },
      ],
      skipped: [],
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
        reason: "These entries name no folder with package.json: tools/missing",
        candidates: [{ path: "tools/missing", manifests: [] }],
      },
    ])
    // An entry with no candidate needs no model run.
    expect(result.skipped).toEqual([
      {
        manifest: "package.json",
        reason: "These entries name no folder with package.json: plugins/*",
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

  it("matches a slow glob from a hostile manifest in well under one second", () => {
    const deep = `${"a/".repeat(40)}x`
    const dir = repo({
      "package.json": pkg("root", {
        private: true,
        workspaces: [`${"**/".repeat(4)}leaf`, `${"*/".repeat(30)}y`],
      }),
      [`${deep}/package.json`]: pkg("deep"),
      [`${"a/".repeat(20)}leaf/package.json`]: pkg("leaf"),
    })
    const result = discover(dir)
    expect(result.roots.map((r) => r.path)).toEqual([`${"a/".repeat(20)}leaf`])
  })

  it("skips an unbalanced brace and a too long or extra entry, and keeps the other entries", () => {
    const many = Array.from({ length: 600 }, (_, i) => `extra/p${i}`)
    const dir = repo({
      "package.json": pkg("root", {
        private: true,
        workspaces: [
          "packages/{a",
          "tools/b}",
          `${"x".repeat(250)}/*`,
          "{apps,libs}/*",
          ...many,
        ],
      }),
      "apps/web/package.json": pkg("web"),
      "libs/ui/package.json": pkg("ui"),
      "packages/a/package.json": pkg("a"),
    })
    const result = discover(dir)
    expect(result.roots.map((r) => r.path)).toEqual(["apps/web", "libs/ui"])
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        {
          manifest: "package.json",
          reason: "The script skipped an entry: it has an unbalanced brace",
        },
        {
          manifest: "package.json",
          reason:
            "The script skipped an entry: it is longer than 200 characters",
        },
        {
          manifest: "package.json",
          reason: "The script read only the first 500 entries of the file",
        },
      ]),
    )
    expect(
      result.skipped.filter((s) => s.reason.includes("unbalanced")),
    ).toHaveLength(2)
  })

  it("does not give a folder whose name has a newline or a backtick", () => {
    const dir = repo({
      "package.json": pkg("root", { private: true, workspaces: ["apps/*"] }),
      "apps/web/package.json": pkg("web"),
      "apps/bad\n`x/package.json": pkg("bad"),
    })
    const result = discover(dir)
    expect(result.roots.map((r) => r.path)).toEqual(["apps/web"])
    expect(JSON.stringify(result)).not.toContain("bad")
    expect(result.skipped).toEqual([
      {
        manifest: null,
        reason:
          "A folder with a package manifest has a name that the script does not quote",
      },
    ])
  })

  it("does not give a folder whose name has a C1 control or an invisible direction character", () => {
    const bad = [
      ...Array.from({ length: 0x20 }, (_, i) => 0x80 + i),
      0x2028,
      0x2029,
      0x061c,
      ...[0x200b, 0x200c, 0x200d],
      0x200e,
      0x200f,
      ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e],
      ...[0x2066, 0x2067, 0x2068, 0x2069],
    ].map((code) => String.fromCodePoint(code))
    const dir = repo({
      "package.json": pkg("root", { private: true, workspaces: ["apps/*"] }),
      "apps/web/package.json": pkg("web"),
      "apps/caf\u00e9/package.json": pkg("cafe"),
      ...Object.fromEntries(
        bad.map((c, i) => [`apps/x${i}${c}y/package.json`, pkg(`bad${i}`)]),
      ),
    })
    const result = discover(dir)
    expect(result.roots.map((r) => r.path)).toEqual([
      "apps/caf\u00e9",
      "apps/web",
    ])
    expect(result.skipped).toEqual([
      {
        manifest: null,
        reason:
          "A folder with a package manifest has a name that the script does not quote",
      },
    ])
  })

  describe("work limits", () => {
    /** 1000 package folders below one chain of `depth` folders. */
    const wide = (depth: number, glob: string) => {
      const chain = Array.from({ length: depth }, () => "a").join("/")
      const files: Record<string, string> = {
        "package.json": pkg("root", { private: true }),
        "apps/web/package.json": pkg("web"),
        "pnpm-workspace.yaml": [
          "packages:",
          "  - 'apps/*'",
          ...Array.from({ length: 499 }, () => `  - '${glob}'`),
        ].join("\n"),
      }
      for (let i = 0; i < 1000; i++)
        files[`${chain}/s${i}/package.json`] = pkg(`p${i}`)
      return repo(files)
    }
    // 4 `**` and 32 segments in 194 characters; the last segment (128) never matches.
    const heavy = `${"**/".repeat(4)}${"*/".repeat(27)}${"*".repeat(127)}z`

    it("finishes 500 long globs on 1000 folders, 150 levels deep", () => {
      expect(heavy).toHaveLength(194)
      const dir = wide(140, heavy)
      const result = discover(dir)
      expect(result.roots.map((r) => r.path)).toEqual(["apps/web"])
      expect(result.skipped.map((s) => s.reason)).toContain(
        "The script did not read a folder that is more than 64 levels deep",
      )
    })

    /** 2000 depth-1 folders with 254-character names, and 499 globs of 64 brace alternatives. */
    const longNames = (glob: string) => {
      const files: Record<string, string> = {
        "package.json": pkg("root", { private: true }),
        "apps/web/package.json": pkg("web"),
        "pnpm-workspace.yaml": [
          "packages:",
          "  - 'apps/*'",
          ...Array.from({ length: 499 }, () => `  - '${glob}'`),
        ].join("\n"),
      }
      for (let i = 0; i < 2000; i++)
        files[`${"a".repeat(250)}${String(i).padStart(4, "0")}/package.json`] =
          pkg(`p${i}`)
      return repo(files)
    }
    const alternatives = `{${",".repeat(63)}}`

    it("skips a glob segment that is longer than 128 characters", () => {
      const glob = `${alternatives}*${"a".repeat(132)}b`
      const dir = longNames(glob)
      const result = discover(dir)
      expect(result.skipped.map((s) => s.reason)).toContain(
        "The script skipped an entry: it has a segment longer than 128 characters",
      )
    })

    it("charges the character compares of a segment to the shared match budget", () => {
      const dir = longNames(`${alternatives}*${"a".repeat(120)}b`)
      const result = discover(dir)
      expect(result.skipped.map((s) => s.reason)).toContain(
        "The script skipped an entry: the match budget of the script ran out, so it read no more entries",
      )
    })

    it("counts the compares of a segment and stops at the budget", async () => {
      const lib = await import(
        join(INGEST_SKILLS_DIR, "discover-roots/scripts/roots-lib.mjs")
      )
      const names = Array.from(
        { length: 2000 },
        (_, i) => `${"a".repeat(250)}${String(i).padStart(4, "0")}`,
      )
      const matcher = lib.globMatcher(`*${"a".repeat(120)}b`)
      expect(matcher).not.toHaveProperty("skip")
      expect(lib.matchStepsUsed()).toBe(0)
      for (const name of names) {
        if (!lib.matchBudgetLeft()) break
        expect(matcher.matches(name)).toBe(false)
      }
      expect(lib.matchBudgetLeft()).toBe(false)
      // The budget is 2 million steps; one run can pass it by at most one segment table.
      expect(lib.matchStepsUsed()).toBeLessThan(2_000_001 + 2000)
      // A segment of 255 characters is the longest one that the matcher compares.
      expect(lib.globMatcher("*").matches("a".repeat(256))).toBe(false)
    })

    it("charges the trailing stars of a segment to the match budget", async () => {
      // A query string gives this test a fresh module, with its own budget.
      const lib = await import(
        `${join(INGEST_SKILLS_DIR, "discover-roots/scripts/roots-lib.mjs")}?trailing-stars`
      )
      const matcher = lib.globMatcher(`a${"*".repeat(120)}`)
      const before = lib.matchStepsUsed()
      expect(matcher.matches("a")).toBe(true)
      expect(lib.matchStepsUsed() - before).toBeGreaterThanOrEqual(120)
    })

    it("shares one match budget between the globs, and says what it skipped", () => {
      const dir = wide(55, heavy)
      const result = discover(dir)
      expect(result.roots.map((r) => r.path)).toEqual(["apps/web"])
      expect(result.skipped.map((s) => s.reason)).toContain(
        "The script skipped an entry: the match budget of the script ran out, so it read no more entries",
      )
    })
  })

  it("counts the double stars of a glob after it expands its braces", () => {
    const dir = repo({
      "package.json": pkg("root", { private: true }),
      "pnpm-workspace.yaml": [
        "packages:",
        `  - '${"{**,a}/".repeat(5)}x'`,
        "  - 'apps/*'",
      ].join("\n"),
      "apps/web/package.json": pkg("web"),
    })
    const result = discover(dir)
    expect(result.roots.map((r) => r.path)).toEqual(["apps/web"])
    expect(result.skipped.map((s) => s.reason)).toContain(
      "The script skipped an entry: it has more than 4 `**` segments",
    )
  })

  it("skips a glob with more than 32 segments or more than 4 double stars", () => {
    const dir = repo({
      "package.json": pkg("root", { private: true }),
      "pnpm-workspace.yaml": [
        "packages:",
        `  - '${Array.from({ length: 33 }, () => "a").join("/")}'`,
        "  - '**/**/x/**/y/**/z/**'",
        "  - 'apps/*'",
      ].join("\n"),
      "apps/web/package.json": pkg("web"),
    })
    const result = discover(dir)
    expect(result.roots.map((r) => r.path)).toEqual(["apps/web"])
    expect(result.skipped.map((s) => s.reason)).toEqual(
      expect.arrayContaining([
        "The script skipped an entry: it has more than 32 segments",
        "The script skipped an entry: it has more than 4 `**` segments",
      ]),
    )
  })

  it("finds Rush projects in rush.json, a JSON file with comments", () => {
    const dir = repo({
      "rush.json": [
        "// Rush configuration",
        "{",
        '  "$schema": "https://developer.microsoft.com/json-schemas/rush/v5/rush.schema.json",',
        '  "projects": [',
        '    { "packageName": "web", "projectFolder": "apps/web" }, /* the app */',
        '    { "packageName": "lib", "projectFolder": "./libraries/lib/" },',
        "  ],",
        "}",
      ].join("\n"),
      "apps/web/package.json": pkg("web"),
      "libraries/lib/package.json": pkg("lib"),
      "common/scripts/package.json": pkg("scripts"),
    })
    const result = discover(dir)
    expect(result.roots).toEqual([
      {
        path: "apps/web",
        manifests: ["package.json"],
        evidence: ["rush.json"],
      },
      {
        path: "libraries/lib",
        manifests: ["package.json"],
        evidence: ["rush.json"],
      },
    ])
  })

  it("marks a rush.json with no projects as ambiguous", () => {
    const dir = repo({
      "rush.json": '{ "rushVersion": "5.0.0" }',
      "apps/web/package.json": pkg("web"),
    })
    expect(discover(dir).ambiguous).toEqual([
      {
        manifest: "rush.json",
        reason: "The script found no project list in the file",
        candidates: [{ path: "apps/web", manifests: ["package.json"] }],
      },
    ])
  })

  it("finds Deno workspace members in deno.json and deno.jsonc", () => {
    const json = repo({
      "deno.json": JSON.stringify({ workspace: ["./add", "./sub/"] }),
      "add/deno.json": JSON.stringify({ name: "@scope/add" }),
      "sub/package.json": pkg("sub"),
    })
    expect(discover(json).roots).toEqual([
      { path: "add", manifests: ["deno.json"], evidence: ["deno.json"] },
      { path: "sub", manifests: ["package.json"], evidence: ["deno.json"] },
    ])
    const jsonc = repo({
      "deno.jsonc":
        '{\n  // members\n  "workspace": { "members": ["pkgs/*"] },\n}\n',
      "pkgs/core/deno.jsonc": "{}\n",
    })
    expect(discover(jsonc).roots).toEqual([
      {
        path: "pkgs/core",
        manifests: ["deno.jsonc"],
        evidence: ["deno.jsonc"],
      },
    ])
  })
})

describe("the test fixture rule (CTX-1531)", () => {
  const fixturePaths = [
    "staging/cli/artifacts",
    "pkg/testdata",
    "pkg/test-data",
    "pkg/test_data",
    "web/__fixtures__",
    "web/Fixtures",
    "web/fixture",
    "e2e/test-fixtures",
  ]

  it("discover-roots takes no package in a test fixture folder as a root", () => {
    const files: Record<string, string> = {
      "package.json": pkg("top", { workspaces: ["packages/*", "**"] }),
      "packages/app/package.json": pkg("app"),
    }
    for (const path of fixturePaths)
      files[`${path}/package.json`] = pkg(`copy-${path.replace(/\W/g, "-")}`)
    const result = discover(repo(files))
    const found = [
      ...result.roots.map((root) => root.path),
      ...result.ambiguous.flatMap((entry) =>
        entry.candidates.map((candidate) => candidate.path),
      ),
    ]
    expect(found).toContain("packages/app")
    for (const path of fixturePaths) expect(found).not.toContain(path)
  })

  it("each skill that reads source files leaves out the same folders", async () => {
    const skill = (path: string) => import(join(INGEST_SKILLS_DIR, path))
    const { documentClass } = await skill(
      "instruction-areas/scripts/documents.mjs",
    )
    const { excludedPath } = await skill(
      "instruction-areas/scripts/patterns.mjs",
    )
    const { decisionForm } = await skill("decisions/scripts/decision-parse.mjs")
    const none = () => false
    // The real paths pass, so each check below shows the fixture rule.
    expect(documentClass("pkg/AGENTS.md", new Set())).not.toBeNull()
    expect(excludedPath("pkg/server.ts")).toBe(false)
    expect(decisionForm("docs/adr/0001-use-go.md", none)).not.toBeNull()
    for (const path of fixturePaths) {
      expect(documentClass(`${path}/AGENTS.md`, new Set())).toBeNull()
      expect(excludedPath(`${path}/server.ts`)).toBe(true)
      expect(decisionForm(`${path}/docs/adr/0001-use-go.md`, none)).toBeNull()
    }
  })
})
