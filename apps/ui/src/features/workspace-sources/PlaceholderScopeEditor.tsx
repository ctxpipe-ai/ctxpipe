import { SOURCE_SCOPES } from "backend/domain/workspace-sources/sources-file"
import { useState } from "react"
import { TextArea, TextField } from "react-aria-components"
import { Description, FieldError, Label } from "@/components/ui/Field"
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
      value={text}
      onChange={(next) => {
        setText(next)
        const parsed = parseScopeText(provider, next)
        onChange("scope" in parsed ? parsed.scope : null)
      }}
      isInvalid={Boolean(error)}
      className="flex flex-col gap-1 font-sans"
    >
      <Label>{label ? `Scope for ${label}` : "Scope"}</Label>
      <TextArea
        rows={5}
        spellCheck={false}
        className="min-h-24 rounded-md border border-neutral-600 bg-neutral-900 px-3 py-2 font-mono text-xs text-neutral-200 outline-none focus-visible:border-neutral-300 data-[invalid]:border-red-600"
      />
      <Description>
        Enter the scope as JSON. It becomes the entry in sources.yaml.
      </Description>
      <FieldError>{error}</FieldError>
    </TextField>
  )
}
