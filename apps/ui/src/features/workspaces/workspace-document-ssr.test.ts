import { existsSync, readFileSync } from "node:fs"
import { dirname, extname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const uiRoot = join(here, "../..")
const srcRoot = uiRoot

const workspaceDocumentEntries = [
  join(here, "WorkspacePane.tsx"),
  join(here, "WorkspaceSurface.tsx"),
  join(here, "ensure-route-data.ts"),
  join(uiRoot, "routes/$orgSlug.ws.$workspaceSlug.tsx"),
  join(uiRoot, "routes/$orgSlug.ws.$workspaceSlug.$conversationId.tsx"),
]

function staticValueImportSpecifiers(source: string): string[] {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
  const specifiers: string[] = []
  const importRe =
    /(?:^|[^.\w$])import\s+(?!type\b)(?:[\w*{}\s,]+from\s+)?["']([^"']+)["']/g
  const exportFromRe = /(?:^|[^.\w$])export\s+[\s\S]*?from\s+["']([^"']+)["']/g
  for (const re of [importRe, exportFromRe]) {
    let match = re.exec(stripped)
    while (match) {
      specifiers.push(match[1] ?? "")
      match = re.exec(stripped)
    }
  }
  return specifiers.filter(Boolean)
}

function pullsCosmographOnSsr(specifier: string): boolean {
  return (
    specifier.includes("cosmograph") ||
    specifier.endsWith("/WorkspaceGraphPane") ||
    specifier.includes("KnowledgeGraphExplorer") ||
    specifier.includes("KnowledgeGraphCosmographCanvas")
  )
}

function resolveLocalSpecifier(
  fromFile: string,
  specifier: string,
): string | null {
  if (specifier.startsWith("@/")) {
    return resolveExistingSource(join(srcRoot, specifier.slice(2)))
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return resolveExistingSource(join(dirname(fromFile), specifier))
  }
  return null
}

function resolveExistingSource(base: string): string | null {
  const candidates = extname(base)
    ? [base]
    : [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
      ]
  return candidates.find((path) => existsSync(path)) ?? null
}

function walkStaticLocalImports(entry: string): string[] {
  const hits: string[] = []
  const queue = [entry]
  const seen = new Set<string>()
  while (queue.length > 0) {
    const file = queue.pop()
    if (!file || seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, "utf8")
    for (const specifier of staticValueImportSpecifiers(source)) {
      if (pullsCosmographOnSsr(specifier)) {
        hits.push(`${file} -> ${specifier}`)
        continue
      }
      const next = resolveLocalSpecifier(file, specifier)
      if (next && !seen.has(next)) queue.push(next)
    }
  }
  return hits
}

describe("workspace document SSR module graph", () => {
  it("does not statically import Cosmograph or the graph pane", () => {
    const hits = workspaceDocumentEntries.flatMap((file) =>
      walkStaticLocalImports(file),
    )
    expect(hits).toEqual([])
  })

  it("loads the graph pane only through a client dynamic import", () => {
    const source = readFileSync(join(here, "WorkspacePane.tsx"), "utf8")
    expect(source).toMatch(/import\(\s*["']\.\/WorkspaceGraphPane["']\s*\)/)
    expect(source).toMatch(/ClientOnly/)
  })

  it("aliases Cosmograph CSS for Vite, esbuild optimizeDeps, SSR, and Nitro", () => {
    const source = readFileSync(join(uiRoot, "../vite.config.ts"), "utf8")
    expect(source).toContain('preset: "bun"')
    expect(source).toMatch(
      /optimizeDeps:[\s\S]*alias:[\s\S]*@\/cosmograph\/style\.module\.css/,
    )
    expect(source).toMatch(
      /ssr:[\s\S]*alias:[\s\S]*@\/cosmograph\/style\.module\.css/,
    )
    expect(source).toMatch(
      /nitroV2Plugin\(\{[\s\S]*alias:[\s\S]*@\/cosmograph\/style\.module\.css/,
    )
  })
})
