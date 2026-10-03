const DAY_MS = 24 * 60 * 60 * 1000
const COMBINE_ALPHA = 0.25
const DEFAULT_HALF_LIFE_MS = 180 * DAY_MS

export function sourceHalfLifeMs(source: string | null | undefined): number {
  const key = source?.trim().toLowerCase() ?? ""
  if (key.includes("slack")) return 21 * DAY_MS
  if (key.includes("linear")) return 120 * DAY_MS
  if (key.includes("notion") || key.includes("confluence")) return 180 * DAY_MS
  if (
    key.includes("git") ||
    key.includes("manual") ||
    key.includes("github.com") ||
    key.includes("gitlab.") ||
    isRelativeRepoPath(key)
  ) {
    return 365 * DAY_MS
  }
  return DEFAULT_HALF_LIFE_MS
}

function isRelativeRepoPath(source: string): boolean {
  if (!source) return false
  if (source.includes("://") || source.startsWith("git@")) return false
  return true
}

/** Query-time decay of one signal. Hydrate still stores c_max. */
export function decayWorkspaceSignal(input: {
  confidence: number | null | undefined
  validFrom: string | null | undefined
  validTo: string | null | undefined
  source: string | null | undefined
  now?: Date
}): number {
  const cMax = clampUnit(input.confidence ?? 0)
  const now = input.now ?? new Date()
  const validFrom = parseInstant(input.validFrom)
  if (!validFrom) return cMax
  if (now.getTime() < validFrom.getTime()) return 0
  const validTo = parseInstant(input.validTo)
  if (validTo && now.getTime() >= validTo.getTime()) return 0
  if (validTo) {
    const span = validTo.getTime() - validFrom.getTime()
    if (span <= 0) return 0
    const age = now.getTime() - validFrom.getTime()
    return cMax * 0.5 ** (age / (span / 2))
  }
  const age = now.getTime() - validFrom.getTime()
  return cMax * 0.5 ** (age / sourceHalfLifeMs(input.source))
}

/** Damped combination of decayed signals. Zero-energy signals are omitted. */
export function combineWorkspaceSignals(energies: readonly number[]): number {
  const live = energies.map(clampUnit).filter((energy) => energy > 0)
  if (live.length === 0) return 0
  const max = Math.max(...live)
  if (live.length === 1) return max
  const others = removeOneMax(live, max)
  const product = others.reduce(
    (acc, energy) => acc * (1 - COMBINE_ALPHA * energy),
    1,
  )
  return clampUnit(max + (1 - max) * (1 - product))
}

function removeOneMax(values: readonly number[], max: number): number[] {
  let removed = false
  const others: number[] = []
  for (const value of values) {
    if (!removed && value === max) {
      removed = true
      continue
    }
    others.push(value)
  }
  return others
}

function parseInstant(value: string | null | undefined): Date | null {
  const raw = value?.trim() ?? ""
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value <= 0) return 0
  if (value >= 1) return 1
  return value
}
