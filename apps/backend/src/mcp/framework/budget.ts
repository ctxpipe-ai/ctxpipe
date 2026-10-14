import { encode } from "@toon-format/toon"

/**
 * Hard cap on one tool result (ADR-051 §5): the text and `structuredContent`
 * together, in characters of their JSON.
 */
export const HARD_CAP_CHARS = 24_000

/** About four characters for each token: cheap, and close for English and code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * What a result costs on the wire: the TOON text, its tokens, and the JSON
 * characters of the text and `structuredContent` together. `toolSuccess` and
 * `fitPage` both use this one formula.
 */
export function measureResult(structured: Record<string, unknown>): {
  text: string
  tokens: number
  chars: number
} {
  const text = encode(structured)
  return {
    text,
    tokens: estimateTokens(text),
    chars: JSON.stringify({
      content: [{ type: "text", text }],
      structuredContent: structured,
    }).length,
  }
}

/**
 * Cut `text` to at most `maxChars` UTF-16 units, with a marker when cut. The
 * cut never splits a surrogate pair.
 */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  let end = Math.max(0, maxChars - 1)
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

/** Room for the `cursor` and `truncated` fields that a tool adds after the fit. */
const RESERVED_TOKENS = 100
const RESERVED_CHARS = 600

/** A string shorter than this does not shrink any more. */
const SHRINK_FLOOR = 16

function shrinkString(text: string): string | null {
  if (text.length <= SHRINK_FLOOR) return null
  return truncateText(text, Math.min(Math.floor(text.length / 2), 12_000))
}

/**
 * A smaller form of one item: a string, or an object with its longest
 * top-level string cut. Null when no string is left to cut.
 */
export function shrinkItem<T>(item: T): T | null {
  if (typeof item === "string") return shrinkString(item) as T | null
  if (item === null || typeof item !== "object") return null
  let longest: string | null = null
  for (const [key, value] of Object.entries(item)) {
    if (
      typeof value === "string" &&
      value.length > SHRINK_FLOOR &&
      (longest === null ||
        value.length > ((item as Record<string, string>)[longest] ?? "").length)
    ) {
      longest = key
    }
  }
  if (longest === null) return null
  const cut = shrinkString((item as Record<string, string>)[longest] as string)
  return cut === null ? null : ({ ...item, [longest]: cut } as T)
}

/**
 * One page of `items` from `offset` that fits the real result: at most
 * `limit` items, `maxTokens` TOON tokens, and the hard cap of
 * {@link HARD_CAP_CHARS} characters on the wire. `result` builds the whole
 * structured result for a page, so the other fields count too. The cursor
 * always moves past the items it leaves out, so a cursor walk makes progress. An
 * item that does not fit alone is cut with `shrink` (default
 * {@link shrinkItem}), and the page is `truncated`. An item that cannot be cut
 * enough is left out and returned in `dropped`. A tool that pages with
 * this never gives `response_too_large`.
 */
export function fitPage<T>(
  items: readonly T[],
  options: {
    offset?: number
    limit: number
    maxTokens: number
    result: (page: T[]) => Record<string, unknown>
    shrink?: (item: T) => T | null
  },
): {
  page: T[]
  nextOffset: number | null
  /** The budget shortened the page, or an item was cut. */
  truncated: boolean
  /** An item was cut with `shrink`. */
  cut: boolean
  /** Items left out because they cannot fit alone, even cut. */
  dropped: T[]
} {
  const start = options.offset ?? 0
  const shrink = options.shrink ?? shrinkItem
  const fits = (page: T[]): boolean => {
    const size = measureResult(options.result(page))
    return (
      size.tokens <= options.maxTokens - RESERVED_TOKENS &&
      size.chars <= HARD_CAP_CHARS - RESERVED_CHARS
    )
  }

  // Each item is on the wire at least once as JSON, so items past the cap
  // cannot fit and need no measure.
  const candidates: T[] = []
  let floor = 0
  for (
    let index = start;
    index < items.length && candidates.length < options.limit;
    index += 1
  ) {
    const item = items[index] as T
    candidates.push(item)
    floor += JSON.stringify(item).length
    if (floor > HARD_CAP_CHARS) break
  }
  if (candidates.length === 0) {
    return {
      page: [],
      nextOffset: null,
      truncated: false,
      cut: false,
      dropped: [],
    }
  }

  // An item with nothing left to cut that is still over budget is dropped, so
  // a page is never over the cap.
  const dropped: T[] = []
  let cut = false
  let page: T[] = []
  let skip = 0
  while (skip < candidates.length) {
    let item = candidates[skip] as T
    let fitted = fits([item])
    let shrunk = false
    while (!fitted) {
      const smaller = shrink(item)
      if (smaller === null) break
      item = smaller
      shrunk = true
      fitted = fits([item])
    }
    if (!fitted) {
      dropped.push(candidates[skip] as T)
      skip += 1
      continue
    }
    if (shrunk) {
      page = [item]
      cut = true
      skip += 1
      break
    }
    // The largest prefix that fits; each measure is of a whole page.
    const rest = candidates.slice(skip)
    let low = 1
    let high = rest.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (fits(rest.slice(0, middle))) low = middle
      else high = middle - 1
    }
    page = rest.slice(0, low)
    skip += low
    break
  }
  const next = start + skip
  return {
    page,
    nextOffset: next < items.length ? next : null,
    truncated: cut || dropped.length > 0 || skip < candidates.length,
    cut,
    dropped,
  }
}
