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
import {
  confluencePageIdOfPath,
  mirrorUnitKeys,
  parseNotionPageUrl,
} from "../domain/workspaces/mirror-units.js"
import {
  changeTargetOf,
  mergedPullRequest,
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
  predicate: "LINKS_TO" | "CHANGED"
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
 * The reference keys of one parsed file.
 * - `keys`: from the front matter of a mirror file (`notion_id`, `url`,
 *   `identifier`), from the path of a Confluence page or a Slack thread, and
 *   the `CHANGED` keys of a package or a Repository file.
 * - `links`: the provider URLs and the Linear identifiers of the body, the
 *   page id of a relative Confluence link, and the `CHANGED` claims of a
 *   merged pull request.
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
  const keys = new Set(mirrorUnitKeys(path, attributes, referenceKeysOfUrl))
  const target = changeTargetOf(
    { path, kind: input.kind, attributes },
    input.sourceRepositories,
  )
  if (target && target !== "invalid_root")
    for (const repository of target.repositories)
      keys.add(changedKey(repository, target.root))

  const links = new Map<string, ReferenceLink>()
  const add = (link: ReferenceLink) => {
    const id = `${link.predicate}\0${link.key}`
    if (!keys.has(link.key) && !links.has(id)) links.set(id, link)
  }
  const linkTo = (key: string, text: string) =>
    add({ key, predicate: "LINKS_TO", validFrom: null, text })

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
  if (pull) {
    const named = new Set<string>()
    for (const file of pull.paths) {
      named.add(changedKey(pull.repositoryUrl, null))
      const folders = file.split("/").slice(0, -1)
      for (let depth = 0; depth <= folders.length; depth++)
        named.add(
          changedKey(pull.repositoryUrl, folders.slice(0, depth).join("/")),
        )
    }
    for (const key of named)
      add({
        key,
        predicate: "CHANGED",
        validFrom: pull.mergedAt,
        text: "",
      })
  }
  return { keys: [...keys].sort(), links: [...links.values()] }
}
