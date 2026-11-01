/**
 * True when the text has a Git conflict, outside fenced code blocks: a
 * `<<<<<<< ` line, then a `=======` line, then a `>>>>>>> ` line.
 */
export function hasConflictMarkers(content: string): boolean {
  let fence: { char: string; length: number } | null = null
  let stage = 0
  for (const line of content.split("\n")) {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.replace(/\r$/, ""))
    if (fence) {
      if (
        opening &&
        opening[1]?.[0] === fence.char &&
        opening[1].length >= fence.length &&
        opening[2]?.trim() === ""
      ) {
        fence = null
      }
      continue
    }
    if (opening && !(opening[1]?.[0] === "`" && opening[2]?.includes("`"))) {
      fence = { char: opening[1]?.[0] ?? "`", length: opening[1]?.length ?? 3 }
      continue
    }
    if (stage === 0 && /^<{7} /.test(line)) stage = 1
    else if (stage === 1 && /^={7}\r?$/.test(line)) stage = 2
    else if (stage === 2 && /^>{7} /.test(line)) return true
  }
  return false
}
