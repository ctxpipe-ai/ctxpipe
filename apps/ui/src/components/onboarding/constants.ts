export const ADMIN_SLIDES = [
  "welcome",
  "overview",
  "create-org",
  "github",
  "mcp-config",
  "invite",
] as const
export const JOINER_SLIDES = [
  "welcome",
  "overview",
  "mcp-config",
  "done",
] as const

export type AdminSlideName = (typeof ADMIN_SLIDES)[number]
export type JoinerSlideName = (typeof JOINER_SLIDES)[number]
export type OnboardingSlideName = AdminSlideName | JoinerSlideName

export const GITHUB_FINALISING_MIN_MS = 1800
