// Shared by the script skills that read YAML text with no parser (the
// sandbox has none): the `apis` skill reads OpenAPI files, and the
// `workflows` skill reads GitHub Actions workflow files.

/** A longer YAML line is not a key line. */
const MAX_YAML_LINE = 4096

/**
 * `key` of a YAML mapping line `key: value`, with the value text; null when
 * the line has another form. It reads the line from left to right with no
 * regular expression that can backtrack, so the cost is linear.
 */
export function yamlEntry(line) {
  if (line.length > MAX_YAML_LINE) return null
  const rest = line.trimStart()
  const indent = line.length - rest.length
  let key
  let after
  const quote = rest[0]
  if (quote === '"' || quote === "'") {
    const close = rest.indexOf(quote, 1)
    if (close === -1) return null
    key = rest.slice(1, close)
    after = rest.slice(close + 1).trimStart()
    if (after[0] !== ":") return null
    after = after.slice(1)
  } else {
    if (rest === "" || /[\s#'"-]/.test(rest[0])) return null
    const end = rest.search(/[:#]/)
    if (end === -1 || rest[end] !== ":") return null
    key = rest.slice(0, end).trimEnd()
    after = rest.slice(end + 1)
  }
  if (after !== "" && !/^\s/.test(after)) return null
  const comment = after.search(/\s#/)
  return {
    indent,
    key,
    value: (comment === -1 ? after : after.slice(0, comment)).trim(),
  }
}
