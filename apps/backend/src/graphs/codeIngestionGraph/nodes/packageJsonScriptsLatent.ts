/**
 * Deterministic latent signals from package.json `scripts` (tier 3, capped).
 */
import { createHash } from "node:crypto"

const STABLE_SCRIPT_BASE = new Set(["test", "lint", "build", "dev", "start"])

const MAX_EXCERPT = 240

export type PackageManagerHint = "pnpm" | "npm" | "yarn" | "neutral"

export function parsePackageJsonScripts(
  jsonText: string,
): { scriptName: string; body: string }[] {
  let pkg: { scripts?: Record<string, unknown> }
  try {
    pkg = JSON.parse(jsonText) as { scripts?: Record<string, unknown> }
  } catch {
    return []
  }
  const scripts = pkg.scripts
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
    return []
  const out: { scriptName: string; body: string }[] = []
  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== "string" || body.length === 0) continue
    out.push({ scriptName: name, body })
  }
  out.sort((a, b) => a.scriptName.localeCompare(b.scriptName))
  return out
}

export function inferPackageManagerFromPaths(
  allPaths: string[],
): PackageManagerHint {
  const has = (suffix: string) =>
    allPaths.some((p) => p === suffix || p.endsWith(`/${suffix}`))
  if (has("pnpm-lock.yaml")) return "pnpm"
  if (has("pnpm-workspace.yaml")) return "pnpm"
  if (has("yarn.lock")) return "yarn"
  if (has("package-lock.json") || has("npm-shrinkwrap.json")) return "npm"
  return "neutral"
}

export function isStableScriptName(scriptName: string): boolean {
  const base = scriptName.includes(":") ? scriptName.split(":")[0] : scriptName
  return base !== undefined && STABLE_SCRIPT_BASE.has(base)
}

export function looksDangerousScriptBody(body: string): boolean {
  return /\brm\s+(-rf|--recursive)\b|\bcurl[^|\n]*\|\s*(ba)?sh\b|\bmkfs\.?\b|>\s*\/dev\/sd/i.test(
    body,
  )
}

export function formatScriptInvocationLabel(
  scriptName: string,
  pm: PackageManagerHint,
): string {
  switch (pm) {
    case "pnpm":
      return `pnpm run ${scriptName}`
    case "yarn":
      return `yarn ${scriptName}`
    case "npm":
      return `npm run ${scriptName}`
    default:
      return `Run script \`${scriptName}\` (package.json)`
  }
}

export function inferScriptEnvironment(
  scriptName: string,
): "ci" | "local" | undefined {
  const lower = scriptName.toLowerCase()
  const base = lower.includes(":") ? lower.split(":")[0] : lower
  if (!base) return undefined
  if (
    base === "test" ||
    base === "lint" ||
    base === "build" ||
    base === "ci" ||
    base === "check"
  ) {
    return "ci"
  }
  if (base === "dev" || base === "start") return "local"
  return undefined
}

/** Canonical string for latent dedup / content_hash (not necessarily the excerpt). */
export function latentScriptCanonicalString(
  root: string,
  scriptName: string,
  body: string,
): string {
  return `latent:package.json:${root}:${scriptName}:${body}`
}

/** Deterministic confidence in [0.52, 0.58] from script identity. */
export function latentDeterministicConfidence(seed: string): number {
  const h = createHash("sha256").update(seed, "utf8").digest("hex")
  const n = Number.parseInt(h.slice(0, 2), 16) % 7
  return Math.round((0.52 + n * 0.01) * 100) / 100
}

export function truncateExcerpt(body: string): string {
  const t = body.trim()
  if (t.length <= MAX_EXCERPT) return t
  return `${t.slice(0, MAX_EXCERPT)}…`
}

export function findScriptKeyLineRange(
  content: string,
  scriptName: string,
): { lineStart: number; lineEnd: number } {
  const escaped = scriptName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`^\\s*"${escaped}"\\s*:`)
  const lines = content.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line && re.test(line)) {
      return { lineStart: i + 1, lineEnd: i + 1 }
    }
  }
  return { lineStart: 1, lineEnd: 1 }
}

export const LATENT_SCRIPTS_CAP = 15
