// Relative imports only: the Nitro plugin bundles this file without the `@/` alias.
import { deploymentEnvironment } from "../../../../shared/deployment-environment.js"

/**
 * `OTEL_*` lists are comma-separated `key=value` pairs. Split on the first `=`,
 * trim, percent-decode. Same rules as the OTel SDK header parser. `+` stays `+`.
 */
export function parseOtelKeyValueList(raw: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (const entry of raw.split(",")) {
    const eq = entry.indexOf("=")
    if (eq < 0) continue
    const key = percentDecode(entry.slice(0, eq).trim())
    if (!key) continue
    pairs.push([key, percentDecode(entry.slice(eq + 1).trim())])
  }
  return pairs
}

function percentDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * The deployment name (`shared/deployment-environment.ts`), else the last
 * `deployment.environment`, else NODE_ENV.
 */
export function deploymentName(): string {
  const deployment = deploymentEnvironment(process.env)
  if (deployment) return deployment
  const raw = process.env.OTEL_RESOURCE_ATTRIBUTES?.trim()
  if (raw) {
    let named: string | undefined
    for (const [key, value] of parseOtelKeyValueList(raw)) {
      if (key === "deployment.environment" && value) named = value
    }
    if (named) return named
  }
  return process.env.NODE_ENV === "production" ? "production" : "development"
}
