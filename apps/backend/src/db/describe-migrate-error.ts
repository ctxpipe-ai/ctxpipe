type PgFields = {
  code?: unknown
  schema?: unknown
  table?: unknown
  constraint?: unknown
  query?: unknown
}

/**
 * One text for a failed migrate: the message of each error in the cause chain,
 * plus what Postgres says about it (SQLSTATE, table, constraint, statement start).
 * It never prints the Postgres `detail` or `where` text, which can hold key
 * values or a whole row, and never a connection URL or query parameters.
 */
export function describeMigrateError(error: unknown): string {
  const lines: string[] = []
  const seen = new Set<unknown>()
  for (
    let current: unknown = error;
    current && !seen.has(current);
    current = (current as { cause?: unknown }).cause
  ) {
    seen.add(current)
    const fields = current as PgFields
    const message = current instanceof Error ? current.message : String(current)
    // A Drizzle query error repeats the statement and its parameters in its message.
    const first = typeof fields.query === "string" ? "Failed query" : message
    const facts: string[] = []
    if (typeof fields.code === "string") facts.push(`SQLSTATE ${fields.code}`)
    if (typeof fields.table === "string")
      facts.push(
        `table ${typeof fields.schema === "string" ? `${fields.schema}.` : ""}${fields.table}`,
      )
    if (typeof fields.constraint === "string")
      facts.push(`constraint ${fields.constraint}`)
    if (typeof fields.query === "string")
      facts.push(
        `statement: ${fields.query.replace(/\s+/g, " ").slice(0, 120)}`,
      )
    lines.push(
      `${lines.length === 0 ? "" : "Caused by: "}${first}${facts.length ? ` (${facts.join("; ")})` : ""}`,
    )
  }
  return lines.join("\n")
}
