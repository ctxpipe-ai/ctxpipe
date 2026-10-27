import { createHash } from "node:crypto"

import { McpToolError } from "./tool-errors.js"

/**
 * Opaque page cursor (ADR-051 §5). It is bound to the org, the Workspace
 * (null for a call over several Workspaces), the tool and its query
 * (`scope`), and the projection SHA. A cursor from another org, Workspace or
 * query is invalid. A cursor after a new projection is stale, because the
 * order can change.
 */
export type CursorBinding = {
  orgId: string
  workspaceId: string | null
  sha: string
  scope: string
}

function scopeKey(binding: CursorBinding): string {
  return digest(
    JSON.stringify([binding.orgId, binding.workspaceId, binding.scope]),
  )
}
type CursorPayload = { v: 1; s: string; q: string; o: number; t?: number }

function digest(value: string): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 16)
}

/**
 * `anchor` is a time in epoch milliseconds that a tool needs again on the next
 * page. `get_related` ranks as of this time, so a page after a cache miss gives
 * the same order.
 */
export function encodeCursor(
  input: CursorBinding & { offset: number; anchor?: number },
): string {
  const payload: CursorPayload = {
    v: 1,
    s: digest(input.sha),
    q: scopeKey(input),
    o: input.offset,
    ...(input.anchor === undefined ? {} : { t: input.anchor }),
  }
  return Buffer.from(JSON.stringify(payload)).toString("base64url")
}

function invalidCursor(): McpToolError {
  return new McpToolError(
    "invalid_cursor",
    "The cursor is not valid for this call. Send the same arguments with the cursor of the last result, or omit the cursor.",
  )
}

/** Offset of a cursor from `encodeCursor` with the same binding. */
export function decodeCursor(cursor: string, expected: CursorBinding): number {
  return decodeCursorWithAnchor(cursor, expected).offset
}

/** Offset and anchor of a cursor from `encodeCursor` with the same binding. */
export function decodeCursorWithAnchor(
  cursor: string,
  expected: CursorBinding,
): { offset: number; anchor: number | undefined } {
  let payload: Partial<CursorPayload>
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor()
    payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))
  } catch {
    throw invalidCursor()
  }
  if (
    payload === null ||
    typeof payload !== "object" ||
    payload.v !== 1 ||
    typeof payload.s !== "string" ||
    typeof payload.q !== "string" ||
    typeof payload.o !== "number" ||
    !Number.isInteger(payload.o) ||
    payload.o < 0 ||
    (payload.t !== undefined &&
      (typeof payload.t !== "number" ||
        Number.isNaN(new Date(payload.t).getTime())))
  ) {
    throw invalidCursor()
  }
  if (payload.q !== scopeKey(expected)) throw invalidCursor()
  if (payload.s !== digest(expected.sha)) {
    throw new McpToolError(
      "stale_cursor",
      "The Workspace has a new revision since this cursor. Send the call again without the cursor.",
    )
  }
  return { offset: payload.o, anchor: payload.t }
}
