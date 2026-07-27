import YAML from "yaml"

function normalizePathValue(value: string): string {
  let normalized = value.trim()
  if (normalized.startsWith("./")) normalized = normalized.slice(2)
  while (normalized.endsWith("/")) normalized = normalized.slice(0, -1)
  return normalized
}

function extractTomlStringArray(
  content: string,
  section: string,
  key: string,
): string[] {
  const sectionPattern = new RegExp(
    String.raw`\[${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\]([\s\S]*?)(?:\n\[|$)`,
    "m",
  )
  const sectionMatch = content.match(sectionPattern)
  if (!sectionMatch) return []
  const block = sectionMatch[1]
  const keyPattern = new RegExp(
    String.raw`\b${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\b\s*=\s*\[([\s\S]*?)\]`,
    "m",
  )
  const keyMatch = block.match(keyPattern)
  if (!keyMatch) return []

  return Array.from(keyMatch[1].matchAll(/"([^"]+)"/g))
    .map((match) => normalizePathValue(match[1] ?? ""))
    .filter((value) => value.length > 0)
}

export function parsePnpmWorkspacePackages(content: string): string[] {
  try {
    const parsed = YAML.parse(content) as { packages?: unknown }
    if (!parsed || !Array.isArray(parsed.packages)) return []
    return parsed.packages
      .filter((entry): entry is string => typeof entry === "string")
      .map(normalizePathValue)
      .filter((value) => value.length > 0)
  } catch {
    return []
  }
}

export function parsePackageJsonWorkspaces(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as {
      workspaces?: string[] | { packages?: string[] }
    }
    const workspaces = parsed.workspaces
    if (Array.isArray(workspaces)) {
      return workspaces
        .map(normalizePathValue)
        .filter((value) => value.length > 0)
    }
    if (workspaces && Array.isArray(workspaces.packages)) {
      return workspaces.packages
        .map(normalizePathValue)
        .filter((value) => value.length > 0)
    }
    return []
  } catch {
    return []
  }
}

export function parseLernaPackages(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as { packages?: string[] }
    if (!Array.isArray(parsed.packages)) return []
    return parsed.packages
      .map(normalizePathValue)
      .filter((value) => value.length > 0)
  } catch {
    return []
  }
}

export function parseRushProjectFolders(content: string): string[] {
  try {
    const parsed = JSON.parse(content) as {
      projects?: Array<{ projectFolder?: string }>
    }
    if (!Array.isArray(parsed.projects)) return []
    return parsed.projects
      .map((project) => normalizePathValue(project.projectFolder ?? ""))
      .filter((value) => value.length > 0)
  } catch {
    return []
  }
}

export function parseDenoWorkspace(content: string): string[] {
  try {
    const stripped = content.replace(/\/\/.*$/gm, "")
    const parsed = JSON.parse(stripped) as { workspace?: string[] }
    if (!Array.isArray(parsed.workspace)) return []
    return parsed.workspace
      .map(normalizePathValue)
      .filter((value) => value.length > 0)
  } catch {
    return []
  }
}

export function parseCargoWorkspaceMembers(content: string): string[] {
  return extractTomlStringArray(content, "workspace", "members")
}

export function parseGoWorkUsePaths(content: string): string[] {
  const roots: string[] = []
  const useBlockMatch = content.match(/\buse\s*\(([\s\S]*?)\)/m)
  if (useBlockMatch) {
    const block = useBlockMatch[1]
    const lines = block
      .split("\n")
      .map((line) => line.replace(/\/\/.*$/, "").trim())
      .filter((line) => line.length > 0)
    for (const line of lines) {
      const normalized = normalizePathValue(line)
      if (normalized.length > 0) roots.push(normalized)
    }
  }

  for (const match of content.matchAll(/\buse\s+([^\s()]+)\s*$/gm)) {
    const normalized = normalizePathValue(match[1] ?? "")
    if (normalized.length > 0) roots.push(normalized)
  }

  return Array.from(new Set(roots))
}

export function parseUvWorkspaceMembers(content: string): string[] {
  return extractTomlStringArray(content, "tool.uv.workspace", "members")
}

export function parseMavenPomModules(content: string): string[] {
  return Array.from(content.matchAll(/<module>([^<]+)<\/module>/g))
    .map((match) => normalizePathValue(match[1] ?? ""))
    .filter((value) => value.length > 0)
}

function gradlePathToDirectory(value: string): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "")
  if (!trimmed) return ""
  if (trimmed.startsWith(":")) {
    return normalizePathValue(trimmed.slice(1).replaceAll(":", "/"))
  }
  return normalizePathValue(trimmed)
}

export function parseGradleSettingsIncludes(content: string): string[] {
  const roots: string[] = []
  const includeCallPattern = /include\s*\(([\s\S]*?)\)/g
  for (const match of content.matchAll(includeCallPattern)) {
    const args = match[1] ?? ""
    for (const stringMatch of args.matchAll(/['"]([^'"]+)['"]/g)) {
      const root = gradlePathToDirectory(stringMatch[1] ?? "")
      if (root) roots.push(root)
    }
  }

  const includeInlinePattern = /^\s*include\s+(.+)$/gm
  for (const match of content.matchAll(includeInlinePattern)) {
    const args = match[1] ?? ""
    for (const stringMatch of args.matchAll(/['"]([^'"]+)['"]/g)) {
      const root = gradlePathToDirectory(stringMatch[1] ?? "")
      if (root) roots.push(root)
    }
  }

  return Array.from(new Set(roots))
}
