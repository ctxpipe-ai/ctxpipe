// Rejects dead links to the docs site (apps/docs).
//
// The check reads the source, so it needs no docs build. It checks:
// - each `/docs/…` and `#heading` link in a docs page, outside code;
// - each image path (`src="/…"`) in a docs page, against apps/docs/public;
// - each docs.ctxpipe.ai URL in apps, packages, plugins, examples, and the
//   README.
// A link must name a published page and, after `#`, a heading of that page.
// A page with `draft: true` in its front matter is not published
// (apps/docs/lib/source.ts). A redirect source is not a page either: the
// redirects in apps/docs/next.config.ts are for links outside this repository.
//
// Usage: node scripts/ci/check-docs-links.mjs [repository root]

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(
  process.argv[2] ?? fileURLToPath(new URL("../..", import.meta.url)),
)
const DOCS = "apps/docs/content/docs"
const SKIP = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".source",
  ".turbo",
  "coverage",
])

function walk(directory, keep) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : walk(path, keep)
    return keep(entry.name) ? [path] : []
  })
}

/** The id that Fumadocs gives a heading (github-slugger). */
function slug(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-")
}

/** The lines of a page, with code blocks and front matter made empty. */
function proseLines(text) {
  const lines = text.split("\n")
  let frontMatter = lines[0] === "---"
  let fence = null
  return lines.map((line, index) => {
    if (frontMatter) {
      if (index > 0 && line === "---") frontMatter = false
      return ""
    }
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1]
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length)
        fence = null
      return ""
    }
    if (marker) fence = marker
    return marker ? "" : line
  })
}

const pages = new Map()
const pageFiles = walk(join(root, DOCS), (name) => name.endsWith(".mdx"))
for (const file of pageFiles) {
  const segments = relative(join(root, DOCS), file)
    .replace(/\.mdx$/, "")
    .split("/")
    .filter((segment) => !/^\(.*\)$/.test(segment))
  if (segments.at(-1) === "index") segments.pop()
  const text = readFileSync(file, "utf8")
  const frontMatter = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""
  const lines = proseLines(text)
  const anchors = new Set()
  const count = new Map()
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/)?.[1]
    if (heading) {
      const id = slug(heading)
      const seen = count.get(id) ?? 0
      count.set(id, seen + 1)
      anchors.add(seen ? `${id}-${seen}` : id)
    }
  }
  pages.set(["/docs", ...segments].join("/"), {
    file,
    lines,
    anchors,
    draft: /^draft:\s*true\s*$/m.test(frontMatter),
  })
}

/** Why `target` is dead, or null. `here` is the page of a `#heading` link. */
function deadReason(target, here) {
  const [path, hash] = target.split("#")
  let page = here
  if (path) {
    const url = path.replace(/\.mdx$/, "").replace(/(.)\/$/, "$1")
    page = pages.get(url)
    if (!page) return "no such page"
    if (page.draft) return "the page is a draft"
  }
  if (hash && !page?.anchors.has(hash)) return "no such heading"
  return null
}

const PAGE_LINK = /\]\((\/docs[^)\s]*|#[^)\s]*)\)|href="(\/docs[^"]*|#[^"]*)"/g
const IMAGE = /\bsrc="(\/[^"]+)"|!\[[^\]]*\]\((\/[^)\s]+)\)/g
const DOCS_URL = /(?:docs\.ctxpipe\.ai|DOCS_URL\})(\/docs[^\s"'`)<>\]]*)/g

const problems = []
let checked = 0
/** Counts one checked link, and keeps it when `reason` says that it is dead. */
function record(file, index, target, reason) {
  checked += 1
  if (reason)
    problems.push(`${relative(root, file)}:${index + 1}: ${target}: ${reason}`)
}

/** Checks each docs.ctxpipe.ai URL on one line of any file. */
function checkDocsUrls(file, line, index) {
  for (const match of line.matchAll(DOCS_URL)) {
    const target = match[1].replace(/[.,;:]+$/, "")
    record(file, index, target, deadReason(target, null))
  }
}

for (const page of pages.values()) {
  page.lines.forEach((line, index) => {
    const prose = line.replace(/(`+)[^`]*?\1/g, "")
    for (const match of prose.matchAll(PAGE_LINK)) {
      const target = match[1] ?? match[2]
      record(page.file, index, target, deadReason(target, page))
    }
    checkDocsUrls(page.file, prose, index)
    for (const match of prose.matchAll(IMAGE)) {
      const image = match[1] ?? match[2]
      const found = existsSync(join(root, "apps/docs/public", image))
      record(
        page.file,
        index,
        image,
        found ? null : "no such file in apps/docs/public",
      )
    }
  })
}

const otherFiles = ["apps", "packages", "plugins", "examples"]
  .flatMap((directory) =>
    walk(
      join(root, directory),
      (name) =>
        /\.(ts|tsx|mjs|js|md|mdx|json)$/.test(name) && name !== "CHANGELOG.md",
    ),
  )
  .filter((file) => !file.startsWith(join(root, DOCS)))
if (existsSync(join(root, "README.md")))
  otherFiles.push(join(root, "README.md"))
for (const file of otherFiles) {
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => checkDocsUrls(file, line, index))
}

if (problems.length) {
  console.error(`Dead docs links (${problems.length}):`)
  for (const line of problems) console.error(line)
  process.exit(1)
}
console.log(
  `Docs links: ${checked} links and images in ${pages.size} pages and the code are good.`,
)
