/**
 * Stable pseudonyms for the people of an org twin (CTX-1661). Each person
 * gets `person-0001`, `person-0002`, … in the order in which the corpus
 * step first sees the person, so the same plan gives the same pseudonyms.
 * The text scrub replaces each known name and login, each email address,
 * and each avatar link, so no real name, email address or user id stays in
 * a file of the twin.
 */
export class Pseudonyms {
  private readonly byKey = new Map<string, string>()
  /** A full name or a login, in lower case, to its pseudonym. */
  private readonly names = new Map<string, string>()
  /** One capitalized word of a full name (a first name), to its pseudonym. */
  private readonly words = new Map<string, string>()
  private patterns: { names: RegExp | null; words: RegExp | null } | null = null

  /** The pseudonym of `key` (for example `zulip:11` or `github:bob`). */
  add(key: string, names: string[]): string {
    let pseudonym = this.byKey.get(key)
    if (!pseudonym) {
      pseudonym = `person-${String(this.byKey.size + 1).padStart(4, "0")}`
      this.byKey.set(key, pseudonym)
    }
    for (const name of names.map((item) => item.trim())) {
      // A name of one character is not a name that identifies a person.
      if (name.length < 2) continue
      this.names.set(name.toLowerCase(), pseudonym)
      // The words of a full name, so that a first name alone goes too.
      const words = name.includes(" ") ? name.split(/\s+/) : []
      for (const word of words)
        if (/^\p{Lu}\p{L}{2,}$/u.test(word))
          // A word of two people names neither of them.
          this.words.set(
            word,
            this.words.get(word) === undefined ||
              this.words.get(word) === pseudonym
              ? pseudonym
              : "someone",
          )
    }
    this.patterns = null
    return pseudonym
  }

  get count(): number {
    return this.byKey.size
  }

  of(key: string): string | undefined {
    return this.byKey.get(key)
  }

  /** The pseudonym of a known full name or login, in any case. */
  named(name: string): string | undefined {
    return this.names.get(name.trim().toLowerCase())
  }

  scrub(text: string): string {
    this.patterns ??= {
      names: alternation([...this.names.keys()], "giu"),
      words: alternation([...this.words.keys()], "gu"),
    }
    let result = text
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]")
      .replace(/https?:\/\/[\w.-]*gravatar\.com\/avatar\/[^\s)]+/g, "[avatar]")
      .replace(/\/avatar\/\d+/g, "/avatar/[person]")
    const { names, words } = this.patterns
    if (names)
      result = result.replace(
        names,
        (match) => this.names.get(match.toLowerCase()) ?? match,
      )
    if (words)
      result = result.replace(words, (match) => this.words.get(match) ?? match)
    return result
  }
}

/** One expression for all `items` as whole words, the longest first. */
function alternation(items: string[], flags: string): RegExp | null {
  if (items.length === 0) return null
  const escaped = [...items]
    .sort((left, right) => right.length - left.length)
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${escaped.join("|")})(?![\\p{L}\\p{N}_])`,
    flags,
  )
}
