// The tables that an SQL statement names, for the `tables` edge of
// trace-edges.mjs. This module imports nothing. A test imports it without the
// hooks of trace-edges.mjs, whose import() of a package file has a computed
// path: in the import closure of a test, that import() gives the test no
// cache key.

// The tokens of a statement: words (lower case), quoted identifiers (with
// their quotes) and single punctuation characters. String literals
// ('...', E'...', $tag$...$tag$) and comments (`--`, `/* */`) give no token,
// so that their text can never become a table name.
function sqlTokens(text) {
  const tokens = []
  let at = 0
  while (at < text.length) {
    const c = text[at]
    if (/\s/.test(c)) {
      at++
    } else if (text.startsWith("--", at)) {
      const end = text.indexOf("\n", at)
      at = end === -1 ? text.length : end + 1
    } else if (text.startsWith("/*", at)) {
      // Postgres block comments nest.
      let depth = 0
      do {
        if (text.startsWith("/*", at)) {
          depth++
          at += 2
        } else if (text.startsWith("*/", at)) {
          depth--
          at += 2
        } else at++
      } while (depth > 0 && at < text.length)
    } else if (c === "'") {
      // A backslash escapes only in an E'...' string.
      const escapes =
        /^[eE]$/.test(tokens.at(-1)?.raw ?? "") && /[eE]/.test(text[at - 1])
      if (escapes) tokens.pop()
      at++
      while (at < text.length) {
        if (escapes && text[at] === "\\") at += 2
        else if (text[at] === "'" && text[at + 1] === "'") at += 2
        else if (text[at++] === "'") break
      }
      tokens.push({ kind: "literal" })
    } else if (c === "$" && /^\$(?:[A-Za-z_]\w*)?\$/.test(text.slice(at))) {
      const tag = text.slice(at).match(/^\$(?:[A-Za-z_]\w*)?\$/)[0]
      const end = text.indexOf(tag, at + tag.length)
      at = end === -1 ? text.length : end + tag.length
      tokens.push({ kind: "literal" })
    } else if (c === '"') {
      let end = at + 1
      while (end < text.length) {
        if (text[end] === '"' && text[end + 1] === '"') end += 2
        else if (text[end] === '"') break
        else end++
      }
      // An identifier without its closing quote is not a name.
      tokens.push(
        end < text.length
          ? { kind: "name", raw: text.slice(at, end + 1) }
          : { kind: "literal" },
      )
      at = end + 1
    } else if (/[A-Za-z_]/.test(c)) {
      const raw = text.slice(at).match(/^[A-Za-z_][\w$]*/)[0]
      tokens.push({ kind: "word", raw, word: raw.toLowerCase() })
      at += raw.length
    } else {
      tokens.push({ kind: "punct", raw: c })
      at++
    }
  }
  return tokens
}

// Words that can follow `from`, `join` or `update` and are not a table:
// `do update set`, `for update skip locked`, `from lateral (...)`.
const notTables = new Set(["set", "skip", "nowait", "of", "lateral", "select"])
const schemaWords = new Set([
  "create",
  "alter",
  "drop",
  "truncate",
  "grant",
  "revoke",
  "comment",
  "do",
])

// Adds the tables that a statement names. Names come only from table
// positions: after `from` or `join` (a read), and after `insert into`,
// `update` or `delete from` (a write). A name after `from` or `join` and
// before `(` is a function, not a table. `into` is the edges of a case.
export function noteTables(text, into) {
  const tokens = sqlTokens(text)
  if (schemaWords.has(tokens[0]?.word)) return
  const isWord = (i, ...words) => words.includes(tokens[i]?.word)
  for (let i = 0; i < tokens.length; i++) {
    let read
    let next
    if (isWord(i, "insert") && isWord(i + 1, "into")) {
      read = false
      next = i + 2
    } else if (isWord(i, "delete") && isWord(i + 1, "from")) {
      read = false
      next = i + 2
    } else if (isWord(i, "update")) {
      read = false
      next = i + 1
    } else if (isWord(i, "from", "join")) {
      read = true
      next = i + 1
    } else continue
    while (isWord(next, "only")) next++
    if (isWord(next, "if")) {
      next++
      if (isWord(next, "not")) next++
      if (isWord(next, "exists")) next++
    }
    const name = (j) =>
      tokens[j]?.kind === "word" || tokens[j]?.kind === "name"
        ? tokens[j].raw
        : undefined
    const first = name(next)
    if (first === undefined) continue
    let second
    let after = next + 1
    if (tokens[after]?.raw === "." && name(after + 1) !== undefined) {
      second = name(after + 1)
      after += 2
    }
    if (read && tokens[after]?.raw === "(") continue
    const table = normalizeTable(first, second)
    if (table) (read ? into.read : into.write).add(table)
    i = after - 1
  }
}

// `"public"."users"` and `users` give `users`; another schema stays.
// Unquoted names fold to lower case, as in Postgres.
function normalizeTable(first, second) {
  const part = (name) =>
    name.startsWith('"')
      ? name.slice(1, -1).replaceAll('""', '"')
      : name.toLowerCase()
  const parts =
    second === undefined ? [part(first)] : [part(first), part(second)]
  if (parts.length === 2 && parts[0] === "public") parts.shift()
  if (parts.length === 1 && notTables.has(parts[0])) return undefined
  const table = parts.join(".")
  return table.length > 128 ? undefined : table
}
