import { withAmbientOrgDb } from "../db/org-sql.js"

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const queue: unknown[] = [error]
  const seen = new Set<unknown>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (current == null || seen.has(current) || typeof current !== "object") {
      continue
    }
    seen.add(current)
    const code = "code" in current ? String(current.code) : ""
    const name =
      "constraint" in current && typeof current.constraint === "string"
        ? current.constraint
        : ""
    if (
      code === "23505" &&
      (name === constraint || name.includes(constraint))
    ) {
      return true
    }
    if ("cause" in current) queue.push(current.cause)
  }
  return false
}

export function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}
