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

export function detectLanguages(checkoutPath: string): ScipIndexerId[] {
  const hasFile = (name: string): boolean => {
    const path = join(checkoutPath, name)
    if (!existsSync(path)) return false
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  }
  const hasDirectory = (name: string): boolean => {
    const path = join(checkoutPath, name)
    if (!existsSync(path)) return false
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }

  const shallowFiles: string[] = []
  const maxEntries = 2_000
  let entriesScanned = 0
  try {
    const entries = readdirSync(checkoutPath, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )

    for (const entry of entries) {
      if (entriesScanned >= maxEntries) break
      entriesScanned += 1
      if (entry.isFile()) shallowFiles.push(entry.name)
    }

    for (const entry of entries) {
      if (
        entriesScanned >= maxEntries ||
        !entry.isDirectory() ||
        entry.name === "node_modules" ||
        entry.name.startsWith(".")
      ) {
        continue
      }

      try {
        const children = readdirSync(join(checkoutPath, entry.name), {
          withFileTypes: true,
        }).sort((a, b) => a.name.localeCompare(b.name))
        for (const child of children) {
          if (entriesScanned >= maxEntries) break
          entriesScanned += 1
          if (child.isFile()) shallowFiles.push(child.name)
        }
      } catch {
        // Ignore unreadable directories and continue detecting other markers.
      }
    }
  } catch {
    return []
  }

  const hasShallowExtension = (extensions: readonly string[]): boolean =>
    shallowFiles.some((file) =>
      extensions.some((extension) => file.endsWith(extension)),
    )

  const detected: ScipIndexerId[] = []
  if (hasFile("go.mod")) detected.push("go")
  if (hasFile("package.json")) detected.push("typescript")
  if (
    ["pyproject.toml", "setup.py", "requirements.txt", "setup.cfg"].some(
      hasFile,
    )
  ) {
    detected.push("python")
  }
  if (
    [
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "settings.gradle",
      "settings.gradle.kts",
    ].some(hasFile)
  ) {
    detected.push("java")
  }
  if (hasFile("Cargo.toml")) detected.push("rust")
  if (
    hasFile("compile_commands.json") ||
    hasFile("CMakeLists.txt") ||
    hasShallowExtension([".c", ".cpp", ".cc", ".cxx", ".h", ".hpp"])
  ) {
    detected.push("clang")
  }
  if (hasFile("Gemfile") || hasShallowExtension([".gemspec"])) {
    detected.push("ruby")
  }
  if (hasShallowExtension([".csproj", ".sln", ".vbproj", ".fsproj"])) {
    detected.push("dotnet")
  }
  if (hasFile("pubspec.yaml")) detected.push("dart")
  if (hasFile("composer.json") || hasShallowExtension([".php"])) {
    detected.push("php")
  }
  if (hasDirectory("debian")) detected.push("debian")

  return detected
}
