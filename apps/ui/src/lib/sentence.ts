/**
 * A text as one sentence: raw error text often has no final mark, so this
 * adds a period. A text that ends in . ! or ?, and an empty text, stay.
 */
export function asSentence(text: string): string {
  const trimmed = text.trimEnd()
  if (trimmed === "" || /[.!?]$/.test(trimmed)) return trimmed
  return `${trimmed}.`
}
