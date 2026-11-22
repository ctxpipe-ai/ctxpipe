import { asStringArray } from "../domain/codeIngestion/connectorFrontmatter.js"
import { connectorMirrorRoot } from "../domain/codeIngestion/connectorMirrorPaths.js"
import {
  confluencePageDedupKey,
  extractUrls,
  githubIssueOrPullDedupKey,
  issueDedupKey,
  linearWorkspaceOfUrl,
  normalizeLinearIdentifier,
  parseConfluencePageUrl,
  parseLinearEntityUrl,
  parseLinearIssueUrl,
  parseSlackPermalink,
  threadDedupKey,
} from "../domain/codeIngestion/referenceResolver.js"
import { resolveHydrateLink } from "../domain/workspaces/hydrate.js"
import { closingPullRequests } from "../domain/workspaces/source-time.js"
import {
  confluencePageIdOfPath,
  githubBlobOf,
  mirrorUnitKeys,
  parseNotionPageUrl,
} from "../domain/workspaces/mirror-units.js"
import {
  changeTargetOf,
  mergedPullRequest,
  sourceRepositoriesOf,
} from "../domain/workspaces/pull-request-changes.js"

/**
 * The reference keys of one file (ADR-066 decision 5, CTX-1400). Some links
 * name their target by a key, not by a path: a Linear identifier, a provider
 * URL, or the repository and the folder of a changed file of a pull request.
 * The file that is the target states its own keys (`keys`), and the file
 * that links states the keys that it names (`links`). Both come from the
 * text of one file. The read finds the documents of a key, so the rows of a
 * file do not depend on other files.
 *
 * The key functions of this module make both sides, so a link and a key
 * cannot differ.
 */
export type FileReferences = {
  /** The keys that name this file. */
  keys: string[]
  /** The relations of this file to a key. */
  links: ReferenceLink[]
}

/** One relation of a file to a reference key. */
export type ReferenceLink = {
  key: string
  predicate: "LINKS_TO" | "CHANGED" | "MENTIONS"
  /** 1, except for a `MENTIONS` link: the confidence of its rule. */
  confidence: number
  /** An ISO time, or null. */
  validFrom: string | null
  /**
   * The text of the body that names the key, so that the relation records
   * the chunk that states it. Empty for a key from the front matter.
   */
  text: string
}

/** The key of a Linear issue identifier, for example `iss:linear:CTX-12`. */
function linearIssueKey(identifier: string): string | null {
  const normalized = normalizeLinearIdentifier(identifier)
  return normalized ? issueDedupKey(normalized) : null
}

/**
 * The keys that a URL names. A Linear URL key holds the Linear workspace of
 * the URL, so that a URL of another Linear workspace names nothing of this
 * Workspace. An unknown URL gives no key.
 */
function referenceKeysOfUrl(url: string): string[] {
  const keys: string[] = []
  const linearWorkspace = linearWorkspaceOfUrl(url)
  if (linearWorkspace) {
    const issue = parseLinearIssueUrl(url)
    const entity = parseLinearEntityUrl(url)
    for (const key of [issue && issueDedupKey(issue), entity])
      if (key) keys.push(`${key}@${linearWorkspace}`)
  }
  const page = parseConfluencePageUrl(url)
  if (page) keys.push(confluencePageDedupKey(page.pageId))
  const thread = parseSlackPermalink(url)
  if (thread) keys.push(threadDedupKey(thread.channelId, thread.ts))
  const notion = parseNotionPageUrl(url)
  if (notion) keys.push(notion)
  const github = githubIssueOrPullDedupKey(url)
  if (github) keys.push(github)
  return keys
}

/**
 * The key by which a `CHANGED` claim names a repository (`root` null) or a
 * package root of it (`""` is the repository top).
 */
function changedKey(repositoryUrl: string, root: string | null): string {
  return root === null
    ? `changed:${repositoryUrl}`
    : `changed:${repositoryUrl}#${root}`
}

/**
 * The keys of each package root below the repository top that can hold
 * `file`: each folder that holds it. A file cannot see which roots exist,
 * so it names all of them (ADR-066 decision 5).
 */
function folderKeysOf(repositoryUrl: string, file: string): string[] {
  const folders = file.split("/").slice(0, -1)
  return folders.map((_, depth) =>
    changedKey(repositoryUrl, folders.slice(0, depth + 1).join("/")),
  )
}

/** The HTTP methods of an operation, as a regular expression group. */
const HTTP_METHODS = "GET|PUT|POST|PATCH|DELETE|HEAD|OPTIONS"

/** The key of a name of a knowledge unit: lowercase, with single spaces. */
const nameKey = (name: string) =>
  `name:${name.trim().replace(/\s+/g, " ").toLowerCase()}`

/** An HTTP path with each parameter (`{name}`) as `{}` and no end slash. */
const operationPath = (path: string) =>
  path.replace(/\{[^}]*\}/g, "{}").replace(/\/+$/, "") || "/"

const operationKey = (method: string, path: string) =>
  `op:${method.toUpperCase()} ${operationPath(path)}`

const operationPathKey = (path: string) => `oppath:${operationPath(path)}`

/**
 * The keys by which an issue can mention a knowledge unit: its name and,
 * for an operation, its method and path. The keys of its package root are
 * the `CHANGED` keys. A connector mirror file is not a knowledge unit.
 */
function mentionTargetKeys(
  path: string,
  kind: string | null,
  attributes: Record<string, unknown>,
): string[] {
  // The kinds of code knowledge that the ingest skills write (CTX-1502).
  const kinds = [
    "Service",
    "App",
    "Library",
    "API",
    "Operation",
    "Database",
    "Infrastructure",
    "Repository",
  ]
  if (connectorMirrorRoot(path) !== null || !kinds.includes(kind ?? ""))
    return []
  const name = typeof attributes.name === "string" ? attributes.name : ""
  if (!name.trim()) return []
  const operation =
    kind === "Operation"
      ? new RegExp(`^(${HTTP_METHODS}) (\\/\\S*)$`).exec(name)
      : null
  return operation?.[1] && operation[2]
    ? [
        nameKey(name),
        operationKey(operation[1], operation[2]),
        operationPathKey(operation[2]),
      ]
    : [nameKey(name)]
}

/** The text with each fenced code block made empty. */
const withoutFences = (text: string) =>
  text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, " ")

/**
 * The knowledge units that the text of an issue names, as `MENTIONS` links
 * with the confidence of the rule that found each one (CTX-1502). The
 * rules use only the issue file, so its rows do not depend on other files
 * (ADR-066 decision 5). Most keys name no document; the read drops such a
 * link, and it weighs each other one by how many files mention its key.
 * The rules, from the highest confidence:
 * - 0.9: a file path, which names each package root below the repository
 *   top that can hold it, in each repository of the issue, and a GitHub
 *   permalink of a file, in its own repository; a method and an HTTP path.
 *   The Repository and the top hold each path, also a file of the reporter
 *   (`src/main.rs`), so a match on them is no evidence.
 * - 0.8: an HTTP path with no method, in a code span or under `/api`; a
 *   label `area/<name>` or `component/<name>`; a full code span with a
 *   lowercase letter.
 * - 0.7: a name with `-` or `_` in the title or the text (`client-go`).
 * A plain word of the title or the text is not a rule, also the first word
 * of a title before a colon (`Bug: …`): most such words name nothing, and
 * some name the wrong unit (`kind`). A name of one or two characters is a
 * variable more often than a unit (`x`), so it is not a mention.
 */
function mentionLinks(input: {
  title: string
  body: string
  attributes: Record<string, unknown>
  repositories: readonly string[]
  urls: readonly string[]
}): ReferenceLink[] {
  const links: ReferenceLink[] = []
  const mention = (key: string, confidence: number, text: string) =>
    links.push({
      key,
      predicate: "MENTIONS",
      confidence,
      validFrom: null,
      text,
    })
  const mentionName = (name: string, confidence: number, text: string) => {
    if (name.trim().length > 2) mention(nameKey(name), confidence, text)
  }
  // A GitHub permalink of a file names the folders of the file in its own
  // repository.
  for (const url of input.urls) {
    let blob: ReturnType<typeof githubBlobOf> = null
    try {
      blob = githubBlobOf(url)
    } catch {
      // A malformed escape in the URL: it names no file.
    }
    if (blob)
      for (const key of folderKeysOf(blob.repository, blob.path))
        mention(key, 0.9, url)
  }
  // Each other URL is a link of its own, not a path or a name.
  const body = input.urls.reduce(
    (text, url) => text.replaceAll(url, " "),
    input.body,
  )
  const prose = withoutFences(body)
  const spans = Array.from(prose.matchAll(/`([^`\n]+)`/g), (m) =>
    (m[1] ?? "").trim(),
  )

  // The path and the operation rules also read fenced code, because a stack
  // trace or a request log names real files and operations. The name rules
  // read only the prose. A path from `./` or `../` is a local file of the
  // reporter, and a path whose first folder holds a dot is a Go import path
  // or a host (`k8s.io/…`). Neither names a file of the repository.
  for (const match of body.matchAll(
    /(?<![\w/.:~-])((?:[\w-]+\/)(?:[\w.-]+\/)*[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7})(?![\w/])/g,
  )) {
    const file = match[1] ?? ""
    for (const repository of input.repositories)
      for (const key of folderKeysOf(repository, file))
        mention(key, 0.9, match[0])
  }
  // A method and a path, also with the path in a code span (GET `/orders/`).
  // The key of the operation drops an end slash.
  const operation = new RegExp(
    `\\b(${HTTP_METHODS})\\s+(\`?)(\\/(?:[\\w./{}:-]*[\\w}])?\\/?)\\2`,
    "g",
  )
  for (const match of body.matchAll(operation))
    mention(operationKey(match[1] ?? "", match[3] ?? ""), 0.9, match[0])

  // A path with its method names only the operation of that method, so the
  // rules of a path with no method do not read it.
  const pathText = prose.replace(operation, " ")
  for (const [, span = ""] of pathText.matchAll(/`([^`\n]+)`/g))
    if (/^(?:\/[\w.{}:-]+)+\/?$/.test(span.trim()))
      mention(operationPathKey(span.trim()), 0.8, span.trim())
  for (const match of pathText.matchAll(
    /(?<![\w./-])\/apis?\/(?:[\w./{}:-]*[\w}])?/g,
  ))
    mention(operationPathKey(match[0]), 0.8, match[0])
  for (const label of asStringArray(input.attributes.labels)) {
    const name = /^(?:area|component)\/(.+)$/.exec(label)?.[1]
    if (name) mentionName(name, 0.8, "")
  }
  // A code span with no lowercase letter is a constant or an environment
  // variable (`HOME`), and a span from `/` is a path: neither is the name
  // of a unit.
  for (const span of spans)
    if (/[a-z]/.test(span) && !span.startsWith("/"))
      mentionName(span, 0.8, span)

  // The name of a file names a page, not a unit
  // (`docs/concepts/dynamic-resource-allocation.md`), so the name rule does
  // not read it. A folder of the path can name a unit (`client-go/tools`).
  // A login is not a unit either: a handle (`@k8s-ci-robot`) and the heading
  // of a mirrored comment (`### <time> · <login>`).
  const nameText = `${input.title}\n${prose}`
    .replace(/^### \S+ · .*$/gm, " ")
    .replace(/@[\w/-]+/g, " ")
    .replace(/[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w/-])/g, " ")
  for (const match of nameText.matchAll(
    /(?<![\w.-])[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+(?![\w-])/gi,
  ))
    mentionName(match[0], 0.7, match[0])
  return links
}

/**
 * The reference keys of one parsed file.
 * - `keys`: from the front matter of a mirror file (`notion_id`, `url`,
 *   `identifier`), from the path of a Confluence page or a Slack thread, the
 *   `CHANGED` keys of a package or a Repository file, and the keys by which
 *   an issue can mention a knowledge unit (`name:`, `op:`, `oppath:`).
 * - `links`: the provider URLs and the Linear identifiers of the body, the
 *   page id of a relative Confluence link, the `CHANGED` claims of a merged
 *   pull request, and the `MENTIONS` links of an issue (`mentionLinks`).
 *
 * A key that the file states for itself gives no link.
 */
export function fileReferences(input: {
  path: string
  kind: string | null
  body: string
  /** The link destinations of the body. */
  links: readonly string[]
  attributes: Record<string, unknown>
  /**
   * Path of each GitHub source file → its repository URL. A change of the
   * sources starts a full rebuild (ADR-067 decision 4).
   */
  sourceRepositories: ReadonlyMap<string, string>
}): FileReferences {
  const { path, attributes } = input
  const keys = new Set([
    ...mirrorUnitKeys(path, attributes, referenceKeysOfUrl),
    ...mentionTargetKeys(path, input.kind, attributes),
  ])
  const target = changeTargetOf(
    { path, kind: input.kind, attributes },
    input.sourceRepositories,
  )
  if (target && target !== "invalid_root")
    for (const repository of target.repositories)
      keys.add(changedKey(repository, target.root))

  const links = new Map<string, ReferenceLink>()
  // The first link of a predicate and a key wins, so a rule with a higher
  // confidence comes first.
  const add = (link: ReferenceLink) => {
    const id = `${link.predicate}\0${link.key}`
    if (!keys.has(link.key) && !links.has(id)) links.set(id, link)
  }
  const linkTo = (key: string, text: string) =>
    add({ key, predicate: "LINKS_TO", confidence: 1, validFrom: null, text })

  // A pull request that closed a GitHub issue (`closedBy`, which the mirror
  // also writes in the `## Closed by` section) is linked from the time of
  // the close (CTX-1516). It comes first, so the link of the body URL does
  // not replace it.
  const closing = closingPullRequests(attributes)
  for (const url of closing?.urls ?? [])
    if (closing && URL.canParse(url))
      for (const key of referenceKeysOfUrl(url))
        add({
          key,
          predicate: "LINKS_TO",
          confidence: 1,
          validFrom: closing.closedAt,
          text: url,
        })

  const urls = extractUrls(input.body)
  for (const url of urls) {
    // Text that only looks like a URL (a template or a placeholder host)
    // names nothing (CTX-1088).
    if (!URL.canParse(url)) continue
    for (const key of referenceKeysOfUrl(url)) linkTo(key, url)
  }
  // An identifier in a URL or in a Linear link is part of that link.
  const text = urls.reduce(
    (body, url) => body.replaceAll(url, " "),
    input.body.replace(
      /\[[^\]]*\]\((https?:\/\/linear\.app\/[^)\s]*)\)/gi,
      " ",
    ),
  )
  // A file names no Linear team, so each identifier in capitals is a key.
  // An identifier that names no file (for example `SHA-256`) is a `missing`
  // target when it is read, and it stores no placeholder row.
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9]{0,9}-\d+\b/g)) {
    const key = linearIssueKey(match[0])
    if (key) linkTo(key, match[0])
  }
  // A relative link to a Confluence page also names the page id, so that it
  // finds the page after the page moved.
  const dir = path.split("/").slice(0, -1).join("/")
  for (const href of input.links) {
    const page = confluencePageIdOfPath(resolveHydrateLink(dir, href))
    if (page) linkTo(confluencePageDedupKey(page), href)
  }

  // A merged pull request changed each package whose root holds a changed
  // file, and its repository.
  const pull =
    input.kind === "PullRequest" ? mergedPullRequest(attributes) : null
  if (pull)
    for (const file of pull.paths)
      for (const key of [
        changedKey(pull.repositoryUrl, null),
        changedKey(pull.repositoryUrl, ""),
        ...folderKeysOf(pull.repositoryUrl, file),
      ])
        add({
          key,
          predicate: "CHANGED",
          confidence: 1,
          validFrom: pull.mergedAt,
          text: "",
        })

  // The repositories of an issue are those of its `sources`, which the
  // mirror writes (`stampMirrorFiles`), as for a package unit.
  if (input.kind === "Issue")
    for (const link of mentionLinks({
      title: typeof attributes.title === "string" ? attributes.title : "",
      body: input.body,
      attributes,
      repositories: sourceRepositoriesOf(attributes, input.sourceRepositories),
      urls,
    }))
      add(link)
  return { keys: [...keys].sort(), links: [...links.values()] }
}
