/** A text as one sentence: raw error text often has no final period. */
export function asSentence(text: string): string {
  return text.replace(/[.!?]?\s*$/, ".")
}
