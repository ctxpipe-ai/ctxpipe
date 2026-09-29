import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, symlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { SKIP_DIRS } from "./detectLanguages.js"

const TYPESCRIPT_CONFIGS = ["tsconfig.json", "jsconfig.json"]

export type TypeScriptWorkspace = {
  /** Checkout-relative project directories to pass to `scip-typescript`. */
  projects: string[]
  /** Named `package.json` packages; linked for monorepos only. */
  packages: Array<{ name: string; dir: string }>
}

async function isMonorepoRoot(checkoutPath: string): Promise<boolean> {
  if (
    existsSync(join(checkoutPath, "pnpm-workspace.yaml")) ||
    existsSync(join(checkoutPath, "lerna.json"))
  ) {
    return true
  }
  const manifest = await readPackageJson(join(checkoutPath, "package.json"))
  return manifest?.workspaces !== undefined
}

async function readPackageJson(
  path: string,
): Promise<{ name?: unknown; workspaces?: unknown } | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    return typeof parsed === "object" && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

/** Drops every directory that sits inside another one in the list. */
function outermost(dirs: string[]): string[] {
  const sorted = [...dirs].sort()
  const kept: string[] = []
  for (const dir of sorted) {
    if (!kept.some((parent) => dir.startsWith(`${parent}/`))) kept.push(dir)
  }
  return kept
}

/**
 * Choose the TypeScript projects for one checkout.
 *
 * A single-package repository with a root config is one project (`.`). A
 * monorepo root config (covering every package, or only an uninstalled
 * `node_modules` file) either runs out of heap or indexes nothing, so
 * monorepos — and repositories with nested configs only — index each
 * outermost nested project instead.
 */
export async function scanTypeScriptWorkspace(
  checkoutPath: string,
): Promise<TypeScriptWorkspace> {
  const configDirs: string[] = []
  const packages: Array<{ name: string; dir: string }> = []
  const queue = [""]
  while (queue.length > 0) {
    const dir = queue.shift() as string
    const entries = await readdir(join(checkoutPath, dir), {
      withFileTypes: true,
    })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
          queue.push(path)
        }
      } else if (entry.isFile() && TYPESCRIPT_CONFIGS.includes(entry.name)) {
        if (!configDirs.includes(dir)) configDirs.push(dir)
      } else if (entry.isFile() && entry.name === "package.json") {
        const manifest = await readPackageJson(join(checkoutPath, path))
        if (typeof manifest?.name === "string" && manifest.name !== "") {
          packages.push({ name: manifest.name, dir })
        }
      }
    }
  }

  const monorepo = await isMonorepoRoot(checkoutPath)
  const hasRootConfig = configDirs.includes("")
  if (hasRootConfig && !monorepo) return { projects: ["."], packages: [] }
  const nested = outermost(configDirs.filter((dir) => dir !== ""))
  return {
    projects: nested.length > 0 ? nested : ["."],
    packages: monorepo ? packages : [],
  }
}

/**
 * Link workspace packages into a temporary root `node_modules` so configs
 * that `extends` a sibling package (`@scope/tsconfig/…`) and
 * cross-package imports resolve without installing dependencies. Skipped
 * when the checkout already has a root `node_modules`. Returns the cleanup.
 */
export async function linkWorkspacePackages(
  checkoutPath: string,
  packages: TypeScriptWorkspace["packages"],
): Promise<() => Promise<void>> {
  const nodeModules = join(checkoutPath, "node_modules")
  if (packages.length === 0 || existsSync(nodeModules)) return async () => {}

  const linked = new Set<string>()
  for (const { name, dir } of packages) {
    if (linked.has(name) || name.includes("..")) continue
    const link = join(nodeModules, name)
    await mkdir(dirname(link), { recursive: true })
    await symlink(join(checkoutPath, dir), link, "dir")
    linked.add(name)
  }
  return () => rm(nodeModules, { recursive: true, force: true })
}
