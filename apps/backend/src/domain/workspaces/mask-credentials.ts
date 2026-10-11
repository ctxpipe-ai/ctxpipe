const MASK = "[masked]"

/** Each rule replaces a credential and keeps the text around it. */
const RULES: Array<[RegExp, string]> = [
  // The whole value of an Authorization header, to the end of the quote or line.
  [/(authorization["']?\s*[:=]\s*["']?)[^"'\r\n]+/gi, `$1${MASK}`],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`],
  // User and password in a URL.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [/\bx-access-token:[^\s/@]+@/gi, `${MASK}@`],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
]

/** Replaces credentials in a text, such as GitHub tokens, API keys and URL passwords. */
export function maskCredentials(text: string): string {
  let masked = text
  for (const [pattern, replacement] of RULES)
    masked = masked.replace(pattern, replacement)
  return masked
}

/** Masks every string in plain objects and arrays. Other values stay as they are. */
export function maskCredentialsDeep<T>(value: T): T {
  if (typeof value === "string") return maskCredentials(value) as T
  if (Array.isArray(value)) return value.map(maskCredentialsDeep) as T
  if (value === null || typeof value !== "object") return value
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      maskCredentialsDeep(entry),
    ]),
  ) as T
}
