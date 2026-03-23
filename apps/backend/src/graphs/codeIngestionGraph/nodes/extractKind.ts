import {
  fetchFiles,
  listFilesRecursive,
} from "../../../domain/codeIngestion/codesearchClient.js"
import type {
  CodeIngestionState,
  ExtractedClaim,
  ExtractedObject,
} from "../schemas.js"

type Kind = "App" | "Service" | "Library"

// Order matters: first match wins. App-specific configs before generic ones.
const CONFIG_PRIORITY: Array<{ file: string; defaultKind: Kind }> = [
  { file: "manifest.json", defaultKind: "App" }, // Browser extension
  { file: "tauri.conf.json", defaultKind: "App" },
  { file: "tauri.config.json", defaultKind: "App" },
  { file: "capacitor.config.json", defaultKind: "App" },
  { file: "capacitor.config.ts", defaultKind: "App" },
  { file: "app.json", defaultKind: "App" }, // Expo
  { file: "app.config.json", defaultKind: "App" },
  { file: "app.config.js", defaultKind: "App" },
  { file: "AndroidManifest.xml", defaultKind: "App" },
  { file: "package.json", defaultKind: "Service" }, // Classified by content
  { file: "Cargo.toml", defaultKind: "Service" },
  { file: "pyproject.toml", defaultKind: "Library" },
  { file: "pubspec.yaml", defaultKind: "Library" }, // Classified by content
  { file: "go.mod", defaultKind: "Library" },
  { file: "pom.xml", defaultKind: "Library" },
  { file: "build.gradle", defaultKind: "Library" },
  { file: "build.gradle.kts", defaultKind: "Library" },
]

function findConfigInRoot(
  files: string[],
  root: string,
): { path: string; defaultKind: Kind } | null {
  const prefix = root === "./" ? "" : `${root}/`
  for (const { file, defaultKind } of CONFIG_PRIORITY) {
    const candidatePath = prefix ? `${prefix}${file}` : file
    if (!files.includes(candidatePath)) continue
    // Config must be directly under root (no extra path segments)
    const rel =
      root === "./" ? candidatePath : candidatePath.slice(prefix.length)
    if (!rel.includes("/") || rel === file) {
      return { path: candidatePath, defaultKind }
    }
  }
  return null
}

function classifyFromPackageJson(content: string): Kind {
  try {
    const pkg = JSON.parse(content) as {
      scripts?: Record<string, string>
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const deps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    }
    const appDeps = ["electron", "react-native", "expo"]
    if (Object.keys(deps).some((k) => appDeps.includes(k))) return "App"
    const scripts = pkg.scripts ?? {}
    const startScripts = ["start", "dev", "serve"]
    if (startScripts.some((s) => scripts[s])) return "Service"
  } catch {
    // ignore parse errors
  }
  return "Library"
}

function classifyFromCargoToml(content: string): Kind {
  if (content.includes("[[bin]]")) return "Service"
  return "Library"
}

function classifyFromPubspecYaml(content: string): Kind {
  if (content.includes("flutter:")) return "App"
  return "Library"
}

function classifyFromConfig(
  content: string,
  filename: string,
  defaultKind: Kind,
): Kind {
  if (filename.endsWith("package.json")) return classifyFromPackageJson(content)
  if (filename.endsWith("Cargo.toml")) return classifyFromCargoToml(content)
  if (filename.endsWith("pubspec.yaml")) return classifyFromPubspecYaml(content)
  return defaultKind
}

function deduplicationKeyPrefix(kind: Kind): string {
  switch (kind) {
    case "App":
      return "app:"
    case "Service":
      return "svc:"
    case "Library":
      return "lib:"
  }
}

function rootToName(root: string): string {
  if (root === "./") return "root"
  return root.split("/").pop() ?? root
}

export async function extractKind(
  state: CodeIngestionState,
): Promise<Partial<CodeIngestionState>> {
  const { repositoryId, orgId, roots = ["./"] } = state
  const objects: ExtractedObject[] = []
  const claims: ExtractedClaim[] = []

  const allPaths = await listFilesRecursive(repositoryId, orgId)
  const contents =
    allPaths.length > 0 ? await fetchFiles(repositoryId, orgId, allPaths) : {}

  for (const root of roots) {
    const found = findConfigInRoot(allPaths, root)
    if (!found) continue

    const { path: configPath, defaultKind } = found
    const content = contents[configPath] ?? ""
    const kind = classifyFromConfig(content, configPath, defaultKind)
    const name = rootToName(root)
    const prefix = deduplicationKeyPrefix(kind)
    const deduplicationKey = `${prefix}${repositoryId}:${root}`

    objects.push({
      kind,
      deduplicationKey,
      name,
      summary: `${kind} at ${root}`,
    })

    claims.push({
      subjectRef: deduplicationKey,
      subjectKind: kind,
      objectRef: repositoryId,
      objectKind: "Repository",
      predicate: "IMPLEMENTED_IN",
      sourceId: `extractKind:${repositoryId}:${root}:${state.targetHash}`,
      sourceType: "git",
      extractionMethod: "deterministic",
      confidence: 0.9,
      provenance: { root, configPath },
    })
  }

  return {
    extractedObjects: objects,
    extractedClaims: claims,
  }
}
