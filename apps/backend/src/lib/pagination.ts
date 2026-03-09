import { z } from "@hono/zod-openapi"

/**
 * Encode a cursor object as an opaque base64 string.
 * Use for Relay-style cursor pagination.
 */
export function encodeCursor(data: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(data), "utf-8").toString("base64url")
}

/**
 * Decode an opaque cursor string back to an object.
 * Returns null if the cursor is invalid.
 */
export function decodeCursor<T extends Record<string, unknown>>(
  cursor: string,
): T | null {
  try {
    const json = Buffer.from(cursor, "base64url").toString("utf-8")
    const parsed = JSON.parse(json) as unknown
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null
    }
    return parsed as T
  } catch {
    return null
  }
}

export const PageInfoSchema = z
  .object({
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
    startCursor: z.string().nullable(),
    endCursor: z.string().nullable(),
  })
  .openapi("PageInfo")

export type PageInfo = z.infer<typeof PageInfoSchema>

export function buildPageInfo<T>(params: {
  items: T[]
  limit: number
  after: string | undefined
  encodeCursor: (item: T) => string
}): { items: T[]; pageInfo: PageInfo } {
  const { items: rawItems, limit, after, encodeCursor } = params
  const hasNextPage = rawItems.length > limit
  const items = hasNextPage ? rawItems.slice(0, limit) : rawItems

  const first = items[0]
  const last = items[items.length - 1]
  return {
    items,
    pageInfo: {
      hasNextPage,
      hasPreviousPage: !!after,
      startCursor: first != null ? encodeCursor(first) : null,
      endCursor: last != null ? encodeCursor(last) : null,
    },
  }
}
