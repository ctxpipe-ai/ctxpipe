/* Shared visual tokens between canvas and explorer so colour/size decisions live
 * in one place rather than drifting across three files. */
export const KIND_PALETTE = [
  "#2dd4bf", // teal
  "#60a5fa", // blue
  "#a78bfa", // violet
  "#f59e0b", // amber
  "#fb7185", // rose
  "#34d399", // emerald
  "#f472b6", // pink
  "#f97316", // orange
  "#818cf8", // indigo
  "#facc15", // yellow
] as const

export const KIND_FALLBACK_COLOR = "#71717a"
export const LINK_BASE = "rgba(226, 232, 240, 0.55)"
export const UNKNOWN_COLOR = "#52525b"
export const PAGE_BG = "#09090b"

export function hashStringToIndex(s: string, mod: number): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h) % mod
}

export function colorForKind(kind: string): string {
  const idx = hashStringToIndex(kind, KIND_PALETTE.length)
  return KIND_PALETTE[idx] ?? KIND_FALLBACK_COLOR
}
