import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { decode } from "@jridgewell/sourcemap-codec"

// Maps V8 coverage to repo source lines. The Vitest trace worker
// (trace-worker.mjs) and the Storybook browser trace (storybook.mjs) use it.

// The offset of the first character of each line.
export function lineStarts(text) {
  const starts = [0]
  let newline = text.indexOf("\n")
  while (newline !== -1) {
    starts.push(newline + 1)
    newline = text.indexOf("\n", newline + 1)
  }
  return starts
}

// The repo-relative path of a file, or null outside the repo and in
// node_modules.
export function repoPath(root, path) {
  const name = relative(root, path).replaceAll("\\", "/")
  return name.startsWith("..") || name.includes("node_modules/") ? null : name
}

// The source position of each source map segment of one script, sorted by
// offset in the script that V8 ran. `starts` are the line offsets of that
// script, and `prefix` is the length of a wrapper on its first line. Without
// a source map the script is the source, and `text` gives the first
// character of each line that is not white space. `base` is the file that
// relative source names resolve against (the map file, or the script).
// Adds each position to `code` (source path to the set of lines with code).
export function positionsOf(
  { path, text, starts, prefix = 0, map, base = path },
  root,
  code,
) {
  const positions = []
  if (map) {
    const names = map.sources.map((source) => {
      if (source.startsWith("file:"))
        return repoPath(root, fileURLToPath(source))
      const full = isAbsolute(source)
        ? source
        : resolve(dirname(base), map.sourceRoot ?? "", source)
      return repoPath(root, full)
    })
    for (const [line, segments] of decode(map.mappings).entries())
      for (const [column, source, sourceLine] of segments) {
        if (
          source === undefined ||
          !names[source] ||
          starts[line] === undefined
        )
          continue
        positions.push({
          offset: starts[line] + column + (line === 0 ? prefix : 0),
          source: names[source],
          line: sourceLine + 1,
        })
      }
  } else {
    const name = repoPath(root, path)
    for (const [line, start] of starts.entries()) {
      const from = start + (line === 0 ? prefix : 0)
      const end = starts[line + 1] ?? text.length
      const indent = text.slice(from, end).search(/\S/)
      if (!name || indent === -1) continue
      positions.push({ offset: from + indent, source: name, line: line + 1 })
    }
  }
  for (const { source, line } of positions) {
    if (!code.has(source)) code.set(source, new Set())
    code.get(source).add(line)
  }
  return positions
}

// Adds the positions that ran to `lines`. A segment ran when the innermost
// V8 range that holds its offset has a count above zero: the function ranges
// minus their nested blocks with a zero count.
export function executed(ranges, positions, lines) {
  ranges.sort(
    (a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset,
  )
  const stack = []
  let next = 0
  for (const { offset, source, line } of positions) {
    while (next < ranges.length && ranges[next].startOffset <= offset) {
      const range = ranges[next++]
      while (stack.length && stack.at(-1).endOffset <= range.startOffset)
        stack.pop()
      stack.push(range)
    }
    while (stack.length && stack.at(-1).endOffset <= offset) stack.pop()
    if (!stack.length || stack.at(-1).count === 0) continue
    if (!lines.has(source)) lines.set(source, new Set())
    lines.get(source).add(line)
  }
}

// Line sets to sorted [start, end] ranges. A line with no code (blank, a
// comment, a type) does not end a range. `code` is the map that
// positionsOf filled.
export function lineRanges(lines, code) {
  const out = {}
  for (const [source, set] of [...lines].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const known = code.get(source)
    const sorted = [...set].sort((a, b) => a - b)
    const list = []
    for (const line of sorted) {
      const last = list.at(-1)
      if (last) {
        let gap = true
        for (let between = last[1] + 1; between < line && gap; between++)
          if (known.has(between)) gap = false
        if (gap) {
          last[1] = line
          continue
        }
      }
      list.push([line, line])
    }
    out[source] = list
  }
  return out
}
