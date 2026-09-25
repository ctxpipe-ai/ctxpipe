function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Drop email, name, and IP fields before a log event is exported. */
export function stripLogPii(event: Record<string, unknown>): void {
  if (isRecord(event.user)) {
    delete event.user.email
    delete event.user.name
    delete event.user.image
  }
  if (isRecord(event.session)) {
    delete event.session.ipAddress
    delete event.session.userAgent
  }
  delete event.userAgent
  delete event.email
  delete event.ipAddress
  if (isRecord(event.headers)) {
    delete event.headers["user-agent"]
    delete event.headers["User-Agent"]
  }
}
