import type { ScipIndexerId } from "./detectLanguages.js"

const PATH_EXTENSION_INDEXERS: Readonly<
  Record<string, readonly ScipIndexerId[]>
> = {
  ".c": ["clang"],
  ".cc": ["clang"],
  ".cpp": ["clang"],
  ".cs": ["dotnet"],
  ".csproj": ["dotnet"],
  ".cts": ["typescript"],
  ".cxx": ["clang"],
  ".dart": ["dart"],
  ".fs": ["dotnet"],
  ".fsproj": ["dotnet"],
  ".go": ["go"],
  ".gemspec": ["ruby"],
  ".h": ["clang"],
  ".hpp": ["clang"],
  ".java": ["java"],
  ".js": ["typescript"],
  ".jsx": ["typescript"],
  ".kt": ["java"],
  ".kts": ["java"],
  ".mjs": ["typescript"],
  ".mts": ["typescript"],
  ".php": ["php"],
  ".py": ["python"],
  ".pyi": ["python"],
  ".rake": ["ruby"],
  ".rb": ["ruby"],
  ".rs": ["rust"],
  ".scala": ["java"],
  ".sln": ["dotnet"],
  ".ts": ["typescript"],
  ".tsx": ["typescript"],
  ".vb": ["dotnet"],
  ".vbproj": ["dotnet"],
}

const EXACT_PATH_INDEXERS: Readonly<Record<string, readonly ScipIndexerId[]>> =
  {
    "build.gradle": ["java"],
    "build.gradle.kts": ["java"],
    "cargo.lock": ["rust"],
    "cargo.toml": ["rust"],
    "cmakelists.txt": ["clang"],
    "compile_commands.json": ["clang"],
    "composer.json": ["php"],
    "composer.lock": ["php"],
    gemfile: ["ruby"],
    "gemfile.lock": ["ruby"],
    "go.mod": ["go"],
    "go.sum": ["go"],
    "go.work": ["go"],
    "jsconfig.json": ["typescript"],
    "package-lock.json": ["typescript"],
    "package.json": ["typescript"],
    "pnpm-lock.yaml": ["typescript"],
    "pom.xml": ["java"],
    "pubspec.lock": ["dart"],
    "pubspec.yaml": ["dart"],
    "pyproject.toml": ["python"],
    "requirements.txt": ["python"],
    "setup.cfg": ["python"],
    "setup.py": ["python"],
    "settings.gradle": ["java"],
    "settings.gradle.kts": ["java"],
    "tsconfig.json": ["typescript"],
    "yarn.lock": ["typescript"],
  }

function indexersForPath(path: string): readonly ScipIndexerId[] | undefined {
  const normalized = path.replaceAll("\\", "/").toLocaleLowerCase()
  const segments = normalized.split("/").filter(Boolean)
  if (segments.includes("debian")) return ["debian"]

  const fileName = segments.at(-1)
  if (!fileName) return undefined
  const exact = EXACT_PATH_INDEXERS[fileName]
  if (exact) return exact

  const extensionStart = fileName.lastIndexOf(".")
  if (extensionStart < 0) return undefined
  return PATH_EXTENSION_INDEXERS[fileName.slice(extensionStart)]
}

/**
 * Select detected SCIP indexers touched by a partial-ingest path set.
 * Unknown paths conservatively select every detected indexer.
 */
export function selectTouchedScipIndexers(
  detected: readonly ScipIndexerId[],
  paths: readonly string[],
): ScipIndexerId[] {
  const touched = new Set<ScipIndexerId>()
  const detectedSet = new Set(detected)

  for (const path of paths) {
    const indexers = indexersForPath(path)
    if (!indexers) return [...detected]
    for (const indexer of indexers) {
      if (detectedSet.has(indexer)) touched.add(indexer)
    }
  }

  return detected.filter((indexer) => touched.has(indexer))
}
