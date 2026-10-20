import type { StreamChunk } from "@tanstack/ai"

const MASK = "[masked]"

/**
 * Each rule replaces a credential and keeps the text around it. Every class
 * has an upper bound and every rule starts at a word boundary, so the time
 * stays linear in the length of the text.
 */
const RULES: Array<[RegExp, string]> = [
  // An Authorization header value: a scheme and a value. Quotes and
  // backslashes end the value, so escaped JSON stays valid.
  [
    /\b(authorization["']?\s{0,8}[:=]\s{0,8}["']?\s{0,8})(?:bearer|basic|token|digest)\s{1,8}[^\s"'\\]{8,4096}/gi,
    `$1${MASK}`,
  ],
  [/\b(bearer)\s{1,8}[A-Za-z0-9._~+/=-]{16,4096}/gi, `$1 ${MASK}`],
  // User and password in a URL; the user can be empty.
  [
    /\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@:"'\\]{0,256}:[^\s/@"'\\]{1,256}@/gi,
    `$1${MASK}@`,
  ],
  [/\bx-access-token:[^\s/@"'\\]{1,256}@/gi, `${MASK}@`],
  // A GitHub token. The installation token form has a numeric id, a second
  // underscore, and a value that can hold "_", "." and "-" (CTX-845). It
  // comes first, so the older form does not mask only a part of it.
  [
    /\bgh[pousr]_(?:[0-9]{1,20}_[A-Za-z0-9_-]{16,4096}(?:\.[A-Za-z0-9_-]{1,4096}){0,4}|[A-Za-z0-9]{20,255})/g,
    MASK,
  ],
  [/\bgithub_pat_[A-Za-z0-9_]{20,255}/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,255}/g, MASK],
  // A signed capability: base64url JSON, a dot, and a SHA-256 signature.
  [/\beyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, MASK],
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

/** Characters held back, so a credential that the next delta completes is not sent in part. */
const TAIL = 100
/** A run without whitespace longer than this is sent anyway. */
const HOLD_MAX = 8192
/** A scheme word at the end of the sent text would split it from its value. */
const SCHEME_AT_END =
  /(?:\b(?:bearer|basic|token|digest)|\bauthorization["']?\s{0,8}[:=]\s{0,8}["']?)\s*$/i

/**
 * Masks a text that arrives in small deltas. It sends the text up to the last
 * whitespace before a held-back tail, because a credential has no whitespace.
 */
export function createDeltaMasker() {
  let pending = ""
  return {
    push(delta: string): string {
      pending += delta
      const limit = pending.length - TAIL
      if (limit <= 0) return ""
      let end = limit
      while (end > 0 && !/\s/.test(pending.charAt(end - 1))) end -= 1
      if (end === 0) {
        if (pending.length <= HOLD_MAX) return ""
        end = limit
      }
      for (let guard = 0; guard < 3; guard += 1) {
        const scheme = SCHEME_AT_END.exec(pending.slice(0, end))
        if (!scheme) break
        end = scheme.index
      }
      const sent = pending.slice(0, end)
      pending = pending.slice(end)
      return maskCredentials(sent)
    },
    flush(): string {
      const sent = pending
      pending = ""
      return maskCredentials(sent)
    },
  }
}

type TextDeltaChunk = Extract<
  StreamChunk,
  { type: "TEXT_MESSAGE_CONTENT" | "REASONING_MESSAGE_CONTENT" }
>

/**
 * Masks credentials in a run's chunks. Text and reasoning arrive in small
 * deltas, so a credential can cross two of them: each message holds back a
 * tail until its end, the end of the run, a run error, or the end of the
 * stream.
 */
export function createChunkMasker() {
  const open = new Map<
    string,
    { masker: ReturnType<typeof createDeltaMasker>; last: TextDeltaChunk }
  >()
  const textChunk = (last: TextDeltaChunk, delta: string): StreamChunk => {
    // The accumulated `content` is not sent; only the delta is.
    const { content: _content, ...rest } = last as TextDeltaChunk & {
      content?: string
    }
    return { ...rest, delta } as StreamChunk
  }
  const flush = (messageId?: string): StreamChunk[] => {
    const ids = messageId === undefined ? [...open.keys()] : [messageId]
    return ids.flatMap((id) => {
      const entry = open.get(id)
      open.delete(id)
      const delta = entry?.masker.flush()
      return entry && delta ? [textChunk(entry.last, delta)] : []
    })
  }
  return {
    push(chunk: StreamChunk): StreamChunk[] {
      if (
        chunk.type === "TEXT_MESSAGE_CONTENT" ||
        chunk.type === "REASONING_MESSAGE_CONTENT"
      ) {
        const key = `${chunk.type}:${chunk.messageId}`
        const entry = open.get(key) ?? {
          masker: createDeltaMasker(),
          last: chunk,
        }
        entry.last = chunk
        open.set(key, entry)
        const delta = entry.masker.push(chunk.delta)
        return delta ? [textChunk(chunk, delta)] : []
      }
      const flushed =
        chunk.type === "TEXT_MESSAGE_END"
          ? flush(`TEXT_MESSAGE_CONTENT:${chunk.messageId}`)
          : chunk.type === "REASONING_MESSAGE_END"
            ? flush(`REASONING_MESSAGE_CONTENT:${chunk.messageId}`)
            : chunk.type === "RUN_FINISHED" || chunk.type === "RUN_ERROR"
              ? flush()
              : []
      return [...flushed, maskCredentialsDeep(chunk)]
    },
    /**
     * Sends the text that is still held. A cancelled run can end with no
     * message end and no run end, and the held text must not be lost.
     */
    end(): StreamChunk[] {
      return flush()
    },
  }
}
