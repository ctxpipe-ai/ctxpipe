const LOCAL_MIGRATE_HOSTS = new Set(["localhost", "127.0.0.1", "postgres"])

/**
 * Host/Compose runtime URLs use `ctxpipe_app`. Drizzle migrate must run as
 * the table owner (`ctxpipe`). Neon/Aurora owners keep their own usernames.
 */
export function ownerUrlForMigrate(databaseUrl: string): string {
  const url = new URL(databaseUrl)
  if (url.username === "ctxpipe_app" && LOCAL_MIGRATE_HOSTS.has(url.hostname)) {
    url.username = "ctxpipe"
  }
  return url.toString()
}
