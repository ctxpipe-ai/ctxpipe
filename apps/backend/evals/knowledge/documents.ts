import { execFileSync } from "node:child_process"
import { posix } from "node:path"

import { parse as parseYaml } from "yaml"
import { z } from "zod"

import { markdownLinks } from "../../src/domain/workspaces/hydrate.js"

/*
 * The documents of one frozen context repo, as the drafter of the question
 * set (`draft.ts`) and the judge panel (`panel.ts`) read them: the
 * frontmatter, the links between documents, and a keyword search that finds
 * the nearest documents of a text. The search is only a tool to pick and
 * check questions. It is not part of a retrieval arm.
 */

/** One Markdown document of a context repo. */
export type CorpusDocument = {
  /** The path relative to the root of the Workspace, as the tools give it. */
  path: string
  /**
   * The group of the document: the knowledge folder (`knowledge/apis`) or
   * the repository of a mirrored issue (`issues/kubernetes/enhancements`).
   * Other files have the group `other`.
   */
  group: string
  title: string
  summary: string
  /** The text after the frontmatter. */
  body: string
  /** The whole file. */
  text: string
  /**
   * The documents of the corpus that this document links to: each edge that
   * the stacks can make (a claim, a relative Markdown link, a GitHub URL),
   * and also each short issue reference (`#123`).
   */
  links: { to: string; via: string }[]
  /** The fields of a mirrored issue that the drafter reads. */
  issue?: { stateReason: string | null; closedAt: string | null }
  /** The comments of a mirrored issue: the handle of each. */
  comments: string[]
  /** The GitHub handles in the document (authors, assignees, comments). */
  handles: string[]
}

const frontmatterSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    summary: z.string(),
    claims: z.array(
      z.object({ to: z.string(), predicate: z.string() }).partial(),
    ),
    repository: z.string(),
    state: z.string(),
    stateReason: z.string().nullable(),
    closedAt: z.unknown(),
    author: z.string(),
    assignees: z.array(z.string()),
    closedBy: z.array(z.string()),
  })
  .partial()

const dateText = (value: unknown): string | null =>
  value instanceof Date
    ? value.toISOString()
    : typeof value === "string"
      ? value
      : null

/** The path of a mirrored issue in the context repo. */
const issuePath = (repository: string, number: string) =>
  `github/issues/${repository}/${number}.md`

/** Read one document. `paths` holds each path of the corpus. */
export function parseDocument(
  path: string,
  text: string,
  paths: ReadonlySet<string>,
): CorpusDocument {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  let front: z.infer<typeof frontmatterSchema> = {}
  if (match) {
    try {
      front = frontmatterSchema.safeParse(parseYaml(match[1] ?? "")).data ?? {}
    } catch {
      front = {}
    }
  }
  const body = match ? text.slice(match[0].length) : text
  const segments = path.split("/")
  const isIssue = segments[0] === "github" && segments[1] === "issues"
  const group = isIssue
    ? `issues/${segments[2]}/${segments[3]}`
    : segments[0] === "knowledge" && segments.length > 2
      ? `knowledge/${segments[1]}`
      : "other"
  const links: CorpusDocument["links"] = []
  const add = (to: string, via: string) => {
    if (to !== path && paths.has(to) && !links.some((link) => link.to === to))
      links.push({ to, via })
  }
  const relative = (to: string) =>
    posix.normalize(posix.join(posix.dirname(path), to))
  for (const claim of front.claims ?? [])
    if (claim.to) add(relative(claim.to), claim.predicate ?? "claim")
  for (const href of markdownLinks(body)) add(relative(href), "LINKS_TO")
  for (const [, repository, number] of body.matchAll(
    /github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g,
  ))
    if (repository && number) add(issuePath(repository, number), "reference")
  if (isIssue && front.repository)
    for (const [, repository, number] of body.matchAll(
      /(?:^|[\s(])([\w.-]+\/[\w.-]+)?#(\d+)\b/g,
    ))
      if (number)
        add(issuePath(repository ?? front.repository, number), "reference")
  // The mirror writes each comment under `### <time> · <handle>`.
  const comments = [...body.matchAll(/^### \S+ · (\S+)\s*$/gm)].flatMap(
    ([, handle]) => (handle ? [handle] : []),
  )
  const handles = new Set([
    ...(front.author ? [front.author] : []),
    ...(front.assignees ?? []),
    ...(front.closedBy ?? []),
    ...comments,
  ])
  return {
    path,
    group,
    title:
      front.name ?? front.title ?? /^# (.+)$/m.exec(body)?.[1]?.trim() ?? path,
    summary: front.summary ?? "",
    body,
    text,
    links,
    ...(isIssue && front.state
      ? {
          issue: {
            stateReason: front.stateReason ?? null,
            closedAt: dateText(front.closedAt),
          },
        }
      : {}),
    comments,
    handles: [...handles],
  }
}

/**
 * Read each Markdown document of the context repo clone `repo` at `sha`,
 * under the Workspace root `root`.
 */
export function loadDocuments(
  repo: string,
  sha: string,
  root: string,
): CorpusDocument[] {
  const paths = execFileSync(
    "git",
    ["-C", repo, "ls-tree", "-r", "--name-only", root ? `${sha}:${root}` : sha],
    { encoding: "utf8", maxBuffer: 1 << 28 },
  )
    .split("\n")
    .filter((path) => path.endsWith(".md"))
  // One `cat-file --batch` reads each blob with no process for each file.
  const prefix = root ? `${sha}:${root}/` : `${sha}:`
  const output = execFileSync("git", ["-C", repo, "cat-file", "--batch"], {
    input: paths.map((path) => `${prefix}${path}`).join("\n"),
    maxBuffer: 1 << 30,
  })
  const pathSet = new Set(paths)
  const documents: CorpusDocument[] = []
  let offset = 0
  for (const path of paths) {
    const headerEnd = output.indexOf(10, offset)
    const header = output.subarray(offset, headerEnd).toString("utf8")
    const [, type, size] = header.split(" ")
    if (type !== "blob")
      throw new Error(`git cannot read ${prefix}${path}: ${header}`)
    const end = headerEnd + 1 + Number(size)
    documents.push(
      parseDocument(
        path,
        output.subarray(headerEnd + 1, end).toString("utf8"),
        pathSet,
      ),
    )
    offset = end + 1
  }
  return documents
}

const tokens = (text: string) =>
  text.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []

/**
 * A plain keyword search (BM25) over the whole text of `documents`.
 * `nearest` gives the paths of the `limit` documents with the highest
 * score for `text`.
 */
export function termIndex(documents: readonly CorpusDocument[]) {
  const frequency = new Map<string, number>()
  const counts = documents.map((document) => {
    const count = new Map<string, number>()
    for (const token of tokens(document.text))
      count.set(token, (count.get(token) ?? 0) + 1)
    for (const token of count.keys())
      frequency.set(token, (frequency.get(token) ?? 0) + 1)
    return count
  })
  const lengths = counts.map((count) =>
    [...count.values()].reduce((sum, n) => sum + n, 0),
  )
  const average =
    lengths.reduce((sum, length) => sum + length, 0) / (lengths.length || 1)
  const idf = (token: string) => {
    const n = frequency.get(token) ?? 0
    return Math.log(1 + (documents.length - n + 0.5) / (n + 0.5))
  }
  // The usual BM25 constants.
  const k1 = 1.2
  const b = 0.75
  return {
    nearest(
      text: string,
      limit: number,
      keep: (document: CorpusDocument) => boolean = () => true,
    ): string[] {
      const query = new Set(tokens(text))
      return documents
        .map((document, index) => {
          const count = counts[index]
          const length = lengths[index] ?? 0
          let score = 0
          for (const token of query) {
            const n = count?.get(token) ?? 0
            if (n > 0)
              score +=
                (idf(token) * n * (k1 + 1)) /
                (n + k1 * (1 - b + (b * length) / (average || 1)))
          }
          return { document, score }
        })
        .filter(({ document, score }) => score > 0 && keep(document))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ document }) => document.path)
    },
  }
}
