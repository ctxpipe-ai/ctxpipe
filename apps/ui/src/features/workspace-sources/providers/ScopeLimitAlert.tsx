import type { z } from "zod"
import { InlineAlert } from "@/components/ui/InlineAlert"

/**
 * The message of the first list in `scope` that is above its cap, or null.
 * The message comes from the scope schema, so the API gives the same text.
 */
export function scopeLimitMessage(
  schema: z.ZodType,
  scope: unknown,
): string | null {
  const parsed = schema.safeParse(scope)
  if (parsed.success) return null
  const issue = parsed.error.issues.find(
    (item) => item.code === "too_big" && item.origin === "array",
  )
  return issue?.message ?? null
}

/** An error when the selection of a scope editor is above a list cap. */
export function ScopeLimitAlert(props: { schema: z.ZodType; scope: unknown }) {
  const message = scopeLimitMessage(props.schema, props.scope)
  return message ? <InlineAlert variant="error">{message}.</InlineAlert> : null
}
