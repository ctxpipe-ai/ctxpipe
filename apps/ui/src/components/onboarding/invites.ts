export function parseInviteEmails(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean)
    .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
}

export function emailDomain(email: string): string {
  const [, domain] = email.split("@")
  return domain?.toLowerCase() ?? ""
}
