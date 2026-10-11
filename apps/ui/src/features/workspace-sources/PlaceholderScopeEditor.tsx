import { SOURCE_SCOPES } from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { TextField } from "@/components/ui/TextField"
import type { SourceScopeEditorProps } from "./source-provider-ui"

/** Parse the JSON text of a scope and validate it with the provider schema. */
export function parseScopeText(
  provider: SourceScopeEditorProps["provider"],
  text: string,
): { scope: Record<string, unknown> } | { error: string } {
  let value: unknown
  try {
    value = text.trim() ? JSON.parse(text) : {}
  } catch {
    return { error: "Enter valid JSON." }
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { error: "Enter a JSON object." }
  const parsed = SOURCE_SCOPES[provider].schema.safeParse(value)
  if (!parsed.success)
    return {
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
    }
  return { scope: parsed.data }
}

/**
 * The generic scope editor: the scope as JSON. A provider replaces it with
 * its own editor in `./providers/<provider>.tsx`.
 */
export function PlaceholderScopeEditor(props: SourceScopeEditorProps) {
  const { provider, initialScope, onChange, label } = props
  const [text, setText] = useState(() => JSON.stringify(initialScope, null, 2))
  const result = parseScopeText(provider, text)
  const error = "error" in result ? result.error : undefined
  return (
    <TextField
      label={label ? `Scope for ${label}` : "Scope"}
      description="Enter the scope as JSON. It becomes the entry in sources.yaml."
      errorMessage={error}
      rows={5}
      spellCheck="false"
      value={text}
      onChange={(next) => {
        setText(next)
        const parsed = parseScopeText(provider, next)
        onChange("scope" in parsed ? parsed.scope : null)
      }}
      isInvalid={Boolean(error)}
    />
  )
}
