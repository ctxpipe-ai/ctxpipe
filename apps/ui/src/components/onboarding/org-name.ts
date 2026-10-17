import { isValidSlug } from "backend/domain/workspaces/slug"

export const ORG_SLUG_MAX_LENGTH = 32

/** A lowercase, hyphenated slug for an organization name. */
export function orgSlugFromName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, ORG_SLUG_MAX_LENGTH)
      // The cut can leave a hyphen at the end.
      .replace(/-+$/g, "")
  )
}

/**
 * The message for a slug the server refuses, or null when the slug is valid.
 * The rule is `isValidSlug` from the backend, so both sides agree.
 */
export function orgSlugError(raw: string): string | null {
  const slug = raw.trim()
  if (!slug) return "Enter the organization slug."
  if (slug.length > ORG_SLUG_MAX_LENGTH) {
    return `Organization slug must be at most ${ORG_SLUG_MAX_LENGTH} characters.`
  }
  if (!isValidSlug(slug)) {
    return "Use lowercase letters and numbers. Separate words with a single hyphen. Do not start or end with a hyphen."
  }
  return null
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
