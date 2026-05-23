/* Shared visual tokens between canvas and explorer so colour/size decisions live
 * in one place rather than drifting across three files. */
export const KIND_PALETTE = [
  "#0f5fa8",
  "#1378bb",
  "#1792ca",
  "#1facd0",
  "#3dbec8",
  "#63cdbb",
  "#88d8b0",
  "#aee4a9",
  "#c8efbd",
  "#d8f5cf",
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
