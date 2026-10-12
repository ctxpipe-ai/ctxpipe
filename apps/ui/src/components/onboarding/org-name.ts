export const ORG_SLUG_MAX_LENGTH = 32

/** A lowercase, hyphenated slug for an organization name. */
export function orgSlugFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, ORG_SLUG_MAX_LENGTH)
}

/**
 * A starting organization name from a work email: pat@initech.io gives
 * "Initech". A personal mail provider gives nothing, because its domain does
 * not identify the team.
 */
export function orgNameFromEmail(email: string | null | undefined): string {
  const domain = email?.split("@")[1]?.trim().toLowerCase()
  if (!domain) return ""
  const labels = domain.split(".").filter(Boolean)
  // Remove the public suffix: the last label, and a generic second level
  // such as co.uk or com.au.
  labels.pop()
  if (
    labels.length > 1 &&
    ["co", "com", "org", "net", "ac", "gov", "edu"].includes(
      labels.at(-1) ?? "",
    )
  ) {
    labels.pop()
  }
  const name = labels.at(-1)
  if (!name || PERSONAL_MAIL_DOMAINS.has(name)) return ""
  return name.charAt(0).toUpperCase() + name.slice(1)
}

const PERSONAL_MAIL_DOMAINS = new Set([
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "icloud",
  "me",
  "mac",
  "aol",
  "proton",
  "protonmail",
  "pm",
  "gmx",
  "mail",
  "yandex",
  "zoho",
  "fastmail",
  "hey",
  "tutanota",
  "qq",
  "163",
  "example",
])
