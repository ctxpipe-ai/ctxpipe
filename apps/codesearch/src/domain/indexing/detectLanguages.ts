import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

export type ScipIndexerId =
  | "go"
  | "typescript"
  | "python"
  | "java"
  | "rust"
  | "clang"
  | "ruby"
  | "dotnet"
  | "dart"
  | "php"
  | "debian"

const INDEXER_ORDER: readonly ScipIndexerId[] = [
  "go",
  "typescript",
  "python",
  "java",
  "rust",
  "clang",
  "ruby",
  "dotnet",
  "dart",
  "php",
  "debian",
] as const

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "vendor",
  "target",
  "dist",
  "build",
  ".next",
  ".turbo",
  "__pycache__",
  ".venv",
  "venv",
  "Pods",
])

const MAX_ENTRIES = 20_000
const MAX_DEPTH = 8

const EXACT_FILE_MARKERS: ReadonlyArray<{
  name: string
  indexer: ScipIndexerId
}> = [
  { name: "go.mod", indexer: "go" },
  { name: "package.json", indexer: "typescript" },
  { name: "pyproject.toml", indexer: "python" },
  { name: "setup.py", indexer: "python" },
  { name: "requirements.txt", indexer: "python" },
  { name: "setup.cfg", indexer: "python" },
  { name: "pom.xml", indexer: "java" },
  { name: "build.gradle", indexer: "java" },
  { name: "build.gradle.kts", indexer: "java" },
  { name: "settings.gradle", indexer: "java" },
  { name: "settings.gradle.kts", indexer: "java" },
  { name: "Cargo.toml", indexer: "rust" },
  { name: "compile_commands.json", indexer: "clang" },
  { name: "CMakeLists.txt", indexer: "clang" },
  { name: "Gemfile", indexer: "ruby" },
  { name: "pubspec.yaml", indexer: "dart" },
  { name: "composer.json", indexer: "php" },
]

const EXTENSION_MARKERS: ReadonlyArray<{
  extension: string
  indexer: ScipIndexerId
}> = [
  { extension: ".c", indexer: "clang" },
  { extension: ".cpp", indexer: "clang" },
  { extension: ".cc", indexer: "clang" },
  { extension: ".cxx", indexer: "clang" },
  { extension: ".h", indexer: "clang" },
  { extension: ".hpp", indexer: "clang" },
  { extension: ".gemspec", indexer: "ruby" },
  { extension: ".csproj", indexer: "dotnet" },
  { extension: ".sln", indexer: "dotnet" },
  { extension: ".vbproj", indexer: "dotnet" },
  { extension: ".fsproj", indexer: "dotnet" },
  { extension: ".php", indexer: "php" },
  { extension: ".scala", indexer: "java" },
  { extension: ".kt", indexer: "java" },
  { extension: ".kts", indexer: "java" },
]

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  )
}

/**
 * Detect SCIP indexer families present under a checkout.
 * Walks the tree with bounded depth/entry caps; skips common junk dirs.
 * Unexpected I/O errors propagate; missing checkout returns [].
 */
export function detectLanguages(checkoutPath: string): ScipIndexerId[] {
  if (!existsSync(checkoutPath)) return []

  let rootStat: ReturnType<typeof statSync>
  try {
    rootStat = statSync(checkoutPath)
  } catch (error) {
    if (isEnoent(error)) return []
    throw error
  }
  if (!rootStat.isDirectory()) return []

  const found = new Set<ScipIndexerId>()
  let entriesScanned = 0

  const visit = (dir: string, depth: number): void => {
    if (entriesScanned >= MAX_ENTRIES || depth > MAX_DEPTH) return

    let entries: ReturnType<typeof readdirSync>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (isEnoent(error)) return
      throw error
    }

    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (entriesScanned >= MAX_ENTRIES) return
      entriesScanned += 1

      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        if (entry.name === "debian") {
          found.add("debian")
        }
        visit(join(dir, entry.name), depth + 1)
        continue
      }

      if (!entry.isFile()) continue

      const name = entry.name
      for (const marker of EXACT_FILE_MARKERS) {
        if (name === marker.name) found.add(marker.indexer)
      }
      for (const marker of EXTENSION_MARKERS) {
        if (name.endsWith(marker.extension)) found.add(marker.indexer)
      }
    }
  }

  visit(checkoutPath, 0)

  return INDEXER_ORDER.filter((id) => found.has(id))
}
