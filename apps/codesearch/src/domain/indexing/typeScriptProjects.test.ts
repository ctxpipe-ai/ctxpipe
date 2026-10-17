import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { readlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  prepareTypeScriptWorkspace,
  scanTypeScriptWorkspace,
} from "./typeScriptProjects.js"

const temporaryDirectories: string[] = []

function checkout(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "typescript-projects-"))
  temporaryDirectories.push(root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

describe("scanTypeScriptWorkspace", () => {
  it("lists every project deepest first with the projects nested under it", async () => {
    const root = checkout({
      "tsconfig.json": "{}",
      "package.json": '{"name":"app"}',
      "test/tsconfig.json": "{}",
      "examples/basic/jsconfig.json": "{}",
      "examples/basic/tsconfig.json": "{}",
      "web/jsconfig.json": "{}",
      "node_modules/dep/tsconfig.json": "{}",
    })

    expect(await scanTypeScriptWorkspace(root)).toEqual({
      projects: [
        { dir: "examples/basic", config: "tsconfig.json", nested: [] },
        { dir: "test", config: "tsconfig.json", nested: [] },
        { dir: "web", config: "jsconfig.json", nested: [] },
        {
          dir: "",
          config: "tsconfig.json",
          nested: ["test", "web", "examples/basic"],
        },
      ],
      packages: [],
      monorepo: false,
    })
  })

  it("lists named workspace packages of a monorepo, not the root package", async () => {
    const root = checkout({
      "package.json": '{"name":"mono","workspaces":["packages/*"]}',
      "packages/core/package.json": '{"name":"@mono/core"}',
      "packages/core/tsconfig.json": "{}",
    })

    const workspace = await scanTypeScriptWorkspace(root)
    expect(workspace.monorepo).toBe(true)
    expect(workspace.packages).toEqual([
      { name: "@mono/core", dir: "packages/core" },
    ])
  })
})

describe("prepareTypeScriptWorkspace", () => {
  it("links packages, adds a root package.json and derived configs, then cleans up", async () => {
    const root = checkout({
      "pnpm-workspace.yaml": "packages: ['packages/*']",
      // JSONC: comments and trailing commas are allowed in tsconfig files.
      "tsconfig.json":
        '{\n  // build output\n  "exclude": ["dist", "**/*.spec.ts",],\n}',
      "packages/core/package.json": '{"name":"@mono/core"}',
      "packages/core/tsconfig.json": "{}",
      "packages/web/jsconfig.json": "{}",
      "packages/web/e2e/tsconfig.json": "{}",
    })
    const workspace = await scanTypeScriptWorkspace(root)

    const { configPaths, cleanup } = await prepareTypeScriptWorkspace(
      root,
      workspace,
    )

    expect(await readlink(join(root, "node_modules/@mono/core"))).toBe(
      join(root, "packages/core"),
    )
    expect(existsSync(join(root, "package.json"))).toBe(true)
    expect(configPaths.get("packages/core")).toBe(
      join(root, "packages/core/tsconfig.json"),
    )
    expect(
      JSON.parse(readFileSync(configPaths.get("") as string, "utf8")),
    ).toEqual({
      extends: "./tsconfig.json",
      exclude: [
        "dist",
        "**/*.spec.ts",
        "packages/core",
        "packages/web",
        "packages/web/e2e",
      ],
    })
    expect(
      JSON.parse(
        readFileSync(configPaths.get("packages/web") as string, "utf8"),
      ),
    ).toMatchObject({
      extends: "./jsconfig.json",
      exclude: ["node_modules", "bower_components", "jspm_packages", "e2e"],
      compilerOptions: { allowJs: true },
    })

    await cleanup()
    for (const leftover of [
      "node_modules",
      "package.json",
      "tsconfig.ctxpipe-scip.json",
      "packages/web/tsconfig.ctxpipe-scip.json",
    ]) {
      expect(existsSync(join(root, leftover))).toBe(false)
    }
    expect(existsSync(join(root, "packages/core/package.json"))).toBe(true)
  })

  it("replaces a crashed run's links but leaves a real node_modules and package.json", async () => {
    const crashed = checkout({
      "package.json": '{"workspaces":["packages/*"]}',
      "packages/core/package.json": '{"name":"core"}',
      "packages/core/tsconfig.json": "{}",
      "node_modules/.ctxpipe-scip-links": "",
      "node_modules/stale/index.ts": "",
    })
    const prepared = await prepareTypeScriptWorkspace(
      crashed,
      await scanTypeScriptWorkspace(crashed),
    )
    expect(existsSync(join(crashed, "node_modules/stale"))).toBe(false)
    expect(existsSync(join(crashed, "node_modules/core"))).toBe(true)
    await prepared.cleanup()
    expect(existsSync(join(crashed, "package.json"))).toBe(true)

    const installed = checkout({
      "package.json": '{"workspaces":["packages/*"]}',
      "packages/core/package.json": '{"name":"core"}',
      "packages/core/tsconfig.json": "{}",
      "node_modules/real/index.js": "",
    })
    const untouched = await prepareTypeScriptWorkspace(
      installed,
      await scanTypeScriptWorkspace(installed),
    )
    await untouched.cleanup()
    expect(existsSync(join(installed, "node_modules/real/index.js"))).toBe(true)
    expect(existsSync(join(installed, "node_modules/core"))).toBe(false)
  })

  it.each([
    "package.json",
    "tsconfig.ctxpipe-scip.json",
    "tsconfig.ctxpipe-scip-standalone.json",
  ])("never writes through a symlink at %s", async (name) => {
    for (const targetExists of [true, false]) {
      const outside = checkout(targetExists ? { "data.txt": "outside\n" } : {})
      const target = join(outside, "data.txt")
      const root = checkout({
        "tsconfig.json": "{}",
        "packages/a/tsconfig.json": "{}",
      })
      symlinkSync(target, join(root, name))
      const prepared = await prepareTypeScriptWorkspace(
        root,
        await scanTypeScriptWorkspace(root),
      )
      await prepared.standaloneConfig("")

      if (targetExists) {
        expect(readFileSync(target, "utf8")).toBe("outside\n")
      } else {
        expect(existsSync(target)).toBe(false)
      }
      await prepared.cleanup()
      expect(existsSync(target)).toBe(targetExists)
    }
  })

  it("never creates node_modules through a symlink", async () => {
    const outside = checkout({})
    const root = checkout({
      "package.json": '{"workspaces":["packages/*"]}',
      "packages/core/package.json": '{"name":"core"}',
      "packages/core/tsconfig.json": "{}",
    })
    symlinkSync(join(outside, "missing"), join(root, "node_modules"))
    const prepared = await prepareTypeScriptWorkspace(
      root,
      await scanTypeScriptWorkspace(root),
    )
    await prepared.cleanup()
    expect(existsSync(join(outside, "missing"))).toBe(false)
  })

  it("keeps only files, include and references that stay inside the checkout", async () => {
    const root = checkout({
      "tsconfig.json": JSON.stringify({
        include: ["src/**/*", "/abs/**/*", "../outside/**/*"],
        files: ["main.ts", "/abs/data.ts", "../../data.ts"],
        references: [{ path: "./packages/a" }, { path: "../other" }],
      }),
      "packages/a/tsconfig.json": "{}",
      "packages/b/tsconfig.json": JSON.stringify({
        include: ["src", "../../../outside"],
      }),
    })
    const prepared = await prepareTypeScriptWorkspace(
      root,
      await scanTypeScriptWorkspace(root),
    )
    const read = (path: string | undefined) =>
      JSON.parse(readFileSync(path as string, "utf8"))

    expect(read(prepared.configPaths.get(""))).toMatchObject({
      include: ["src/**/*"],
      files: ["main.ts"],
      references: [{ path: "./packages/a" }],
    })
    expect(read(await prepared.standaloneConfig(""))).toMatchObject({
      include: ["src/**/*"],
      files: ["main.ts"],
      references: [{ path: "./packages/a" }],
    })
    expect(read(prepared.configPaths.get("packages/b"))).toMatchObject({
      extends: "./tsconfig.json",
      include: ["src"],
    })
    expect(prepared.configPaths.get("packages/a")).toBe(
      join(root, "packages/a/tsconfig.json"),
    )
    await prepared.cleanup()
  })
})
