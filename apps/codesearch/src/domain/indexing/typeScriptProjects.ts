import { existsSync } from "node:fs"
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join, relative, resolve, sep } from "node:path"
import {
  replaceCheckoutFile,
  resolveContainedRealPath,
} from "../repositories/paths.js"
import { SKIP_DIRS } from "./detectLanguages.js"

export type TypeScriptProject = {
  /** Checkout-relative directory; `""` is the checkout root. */
  dir: string
  config: "tsconfig.json" | "jsconfig.json"
  /** Checkout-relative directories of projects nested under this one. */
  nested: string[]
}

export type TypeScriptWorkspace = {
  /** Every project, deepest first, so the checkout root runs last. */
  projects: TypeScriptProject[]
  /** Named `package.json` packages, linked when `monorepo`. */
  packages: Array<{ name: string; dir: string }>
  monorepo: boolean
}

/** Written when the checkout root has no package.json; see prepare below. */
const ROOT_PACKAGE_MARKER = '{"description":"ctxpipe scip-typescript root"}\n'
/** Marks a root node_modules this module created, so a crashed run's is replaced. */
const LINKED_MARKER = ".ctxpipe-scip-links"
const DERIVED_CONFIG = "tsconfig.ctxpipe-scip.json"
const STANDALONE_CONFIG = "tsconfig.ctxpipe-scip-standalone.json"

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(
      stripJsonComments(await readFile(path, "utf8")),
    )
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** tsconfig files are JSONC: drop comments and trailing commas outside strings. */
function stripJsonComments(text: string): string {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === "\\") i++
      }
      out += text.slice(start, i + 1)
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
    } else if (char === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2)
      if (i < 0) break
      i++
    } else {
      out += char
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1")
}

/**
 * Every TypeScript project in a checkout: each directory with a
 * `tsconfig.json` (or only a `jsconfig.json`), including the root. Projects
 * run deepest first and a parent excludes its nested projects' directories,
 * so each file is indexed once by its innermost project and a catch-all root
 * config only covers root-level files.
 */
export async function scanTypeScriptWorkspace(
  checkoutPath: string,
): Promise<TypeScriptWorkspace> {
  const configs = new Map<string, TypeScriptProject["config"]>()
  const packages: TypeScriptWorkspace["packages"] = []
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
      } else if (entry.isFile() && entry.name === "tsconfig.json") {
        configs.set(dir, "tsconfig.json")
      } else if (entry.isFile() && entry.name === "jsconfig.json") {
        if (!configs.has(dir)) configs.set(dir, "jsconfig.json")
      } else if (
        entry.isFile() &&
        entry.name === "package.json" &&
        dir !== ""
      ) {
        const manifest = await readJson(join(checkoutPath, path))
        if (typeof manifest?.name === "string" && manifest.name !== "") {
          packages.push({ name: manifest.name, dir })
        }
      }
    }
  }

  const realManifest = await resolveContainedRealPath(
    checkoutPath,
    "package.json",
  ).catch(() => null)
  const rootManifest = realManifest ? await readJson(realManifest) : null
  const monorepo =
    existsSync(join(checkoutPath, "pnpm-workspace.yaml")) ||
    existsSync(join(checkoutPath, "lerna.json")) ||
    rootManifest?.workspaces !== undefined
  const dirs = [...configs.keys()]
  const depth = (dir: string) => (dir === "" ? 0 : dir.split("/").length)
  const projects = dirs
    .map((dir) => ({
      dir,
      config: configs.get(dir) as TypeScriptProject["config"],
      nested: dirs.filter(
        (other) => other !== dir && (dir === "" || other.startsWith(`${dir}/`)),
      ),
    }))
    .sort((a, b) => depth(b.dir) - depth(a.dir) || a.dir.localeCompare(b.dir))
  return { projects, packages: monorepo ? packages : [], monorepo }
}

/**
 * Put the checkout in shape for `scip-typescript` without installing
 * anything, and return each project's config path plus the cleanup:
 *
 * - Monorepo packages are symlinked into a root `node_modules`, so configs
 *   that `extends` a sibling package (`@scope/tsconfig/…`) and cross-package
 *   imports resolve. A pre-existing real `node_modules` is left alone.
 * - A root `package.json` is ensured: scip-typescript names a file's package
 *   after the nearest one and otherwise walks up to `/`, which would put the
 *   absolute checkout path into symbols.
 * - A project with nested projects gets a derived config that extends its
 *   own and also excludes those directories.
 * - `standaloneConfig` writes, on demand, a copy of a project's own config
 *   without `extends`, for bases that only an install would provide
 *   (`@tsconfig/node16/…`): the project keeps its own include, exclude and
 *   compiler options and loses only the base's defaults.
 *
 * Leftovers from a crashed run carry markers and are replaced.
 */
export async function prepareTypeScriptWorkspace(
  checkoutPath: string,
  workspace: TypeScriptWorkspace,
): Promise<{
  configPaths: Map<string, string>
  standaloneConfig: (dir: string) => Promise<string>
  cleanup: () => Promise<void>
}> {
  const created: string[] = []
  const cleanup = async () => {
    await Promise.all(
      created.map((path) => rm(path, { recursive: true, force: true })),
    )
  }
  try {
    // Use lstat, so a symlink at node_modules is left alone and never used.
    const nodeModules = join(checkoutPath, "node_modules")
    let nodeModulesStat = await lstat(nodeModules).catch(() => null)
    if (
      nodeModulesStat?.isDirectory() &&
      existsSync(join(nodeModules, LINKED_MARKER))
    ) {
      await rm(nodeModules, { recursive: true, force: true })
      nodeModulesStat = null
    }
    if (workspace.packages.length > 0 && nodeModulesStat === null) {
      created.push(nodeModules)
      await mkdir(nodeModules, { recursive: true })
      await writeFile(join(nodeModules, LINKED_MARKER), "")
      const linked = new Set<string>()
      for (const { name, dir } of workspace.packages) {
        if (
          linked.has(name) ||
          name.split("/").some((part) => part === ".." || part === ".")
        )
          continue
        const link = join(nodeModules, name)
        await mkdir(dirname(link), { recursive: true })
        await symlink(join(checkoutPath, dir), link, "dir")
        linked.add(name)
      }
    }

    // Keep a package.json only when it is a file inside the checkout.
    // Replace anything else, such as a symlink that ends outside.
    const rootManifest = join(checkoutPath, "package.json")
    const realManifest = await resolveContainedRealPath(
      checkoutPath,
      "package.json",
    ).catch(() => null)
    const existing =
      realManifest && (await stat(realManifest)).isFile()
        ? await readFile(realManifest, "utf8")
        : null
    if (existing === null || existing === ROOT_PACKAGE_MARKER) {
      created.push(rootManifest)
      await replaceCheckoutFile(rootManifest, ROOT_PACKAGE_MARKER)
    }

    const configPaths = new Map<string, string>()
    for (const project of workspace.projects) {
      const projectDir = join(checkoutPath, project.dir)
      const ownConfig = join(projectDir, project.config)
      const { config, narrowed } = await derivedConfig(
        checkoutPath,
        project,
        false,
      )
      if (project.nested.length === 0 && !narrowed) {
        configPaths.set(project.dir, ownConfig)
        continue
      }
      const derived = join(projectDir, DERIVED_CONFIG)
      created.push(derived)
      await replaceCheckoutFile(derived, JSON.stringify(config))
      configPaths.set(project.dir, derived)
    }
    const standaloneConfig = async (dir: string) => {
      const project = workspace.projects.find((entry) => entry.dir === dir)
      if (!project) throw new Error(`Unknown TypeScript project: ${dir}`)
      const path = join(checkoutPath, dir, STANDALONE_CONFIG)
      created.push(path)
      const { config } = await derivedConfig(checkoutPath, project, true)
      await replaceCheckoutFile(path, JSON.stringify(config))
      return path
    }
    return { configPaths, standaloneConfig, cleanup }
  } catch (error) {
    await cleanup()
    throw error
  }
}

/**
 * The project's own `files`, `include` and `references`, without entries
 * that resolve outside the checkout. `narrowed` is true when an entry was
 * dropped. Entries inherited through `extends` are not checked.
 */
function entriesInsideCheckout(
  checkoutPath: string,
  projectDir: string,
  own: Record<string, unknown>,
): { entries: Record<string, unknown[]>; narrowed: boolean } {
  const root = resolve(checkoutPath)
  const inside = (path: unknown) => {
    if (typeof path !== "string") return false
    const full = resolve(projectDir, path)
    return full === root || full.startsWith(`${root}${sep}`)
  }
  const entries: Record<string, unknown[]> = {}
  let narrowed = false
  for (const key of ["files", "include", "references"]) {
    const list = own[key]
    if (!Array.isArray(list)) continue
    const kept = list.filter((item) =>
      key === "references"
        ? typeof item === "object" &&
          item !== null &&
          inside((item as { path?: unknown }).path)
        : inside(item),
    )
    if (kept.length !== list.length) narrowed = true
    entries[key] = kept
  }
  return { entries, narrowed }
}

async function derivedConfig(
  checkoutPath: string,
  project: TypeScriptProject,
  standalone: boolean,
): Promise<{ config: Record<string, unknown>; narrowed: boolean }> {
  const projectDir = join(checkoutPath, project.dir)
  const own = (await readJson(join(projectDir, project.config))) ?? {}
  const { entries, narrowed } = entriesInsideCheckout(
    checkoutPath,
    projectDir,
    own,
  )
  // `exclude` replaces the inherited one, so keep the project's own list.
  // Inherited excludes (via `extends`) and TypeScript's defaults are replaced
  // by the defaults below, which can only add files to the project.
  const ownExclude = Array.isArray(own.exclude)
    ? own.exclude.filter((item): item is string => typeof item === "string")
    : ["node_modules", "bower_components", "jspm_packages"]
  const exclude = [
    ...ownExclude,
    ...project.nested.map((dir) =>
      relative(projectDir, join(checkoutPath, dir)),
    ),
  ]
  // scip-typescript applies jsconfig defaults by file name only.
  const jsconfigOptions =
    project.config === "jsconfig.json"
      ? {
          allowJs: true,
          maxNodeModuleJsDepth: 2,
          allowSyntheticDefaultImports: true,
          skipLibCheck: true,
          noEmit: true,
        }
      : undefined
  if (standalone) {
    const { extends: _base, ...rest } = own
    return {
      config: {
        ...rest,
        ...entries,
        exclude,
        compilerOptions: {
          ...jsconfigOptions,
          ...(typeof own.compilerOptions === "object"
            ? own.compilerOptions
            : {}),
        },
      },
      narrowed,
    }
  }
  return {
    config: {
      extends: `./${project.config}`,
      ...entries,
      exclude,
      ...(jsconfigOptions ? { compilerOptions: jsconfigOptions } : {}),
    },
    narrowed,
  }
}
