import { isDeepStrictEqual } from "node:util"
import YAML, { isNode, type Node, type YAMLSeq } from "yaml"
import type { UpgradeNotice } from "../upgrades/registry.js"
import { normalizeWorkspaceRepositoryUrl } from "../workspaces/slug.js"
import {
  githubLegacyScopeSchema,
  githubScopeRepositories,
} from "./providers/github.js"
import {
  checkSourcePath,
  githubSourcePath,
  SOURCE_FILE_MAX_BYTES,
  SOURCE_FILES_FOLDER,
  type SourceFile,
  toSegment,
} from "./source-file.js"
import { parseSourceFile, renderSourceFile } from "./source-file-text.js"
import {
  parseLegacySourceEntry,
  SOURCES_FILE_PATH,
  sourcesFileSchema,
} from "./sources-file.js"
import { parseSourcesDocument } from "./sources-yaml.js"

/**
 * The input of the conversion: the sources of one Workspace tree. Each path
 * is relative to the Workspace root folder (CTX-709), as in the upgrade
 * registry.
 */
export type SourcesConversionTree = {
  /** The text of `.ctxpipe/sources.yaml`, or null when the file is absent. */
  sourcesYaml: string | null
  /** Every blob under `sources/`. */
  sourceFiles: ReadonlyArray<{ path: string; text: string }>
  /**
   * The Workspace repository URL. A GitHub entry that names it is skipped
   * and goes to the report, as before the source files: a source file for it
   * would project as invalid.
   */
  workspaceUrl?: string | null
}

/** The change of the conversion. Each path is relative to the Workspace root folder. */
export type SourcesConversion = {
  writes: Array<{ path: string; content: string }>
  deletes: string[]
  /** Lines for the pull request body: each input that did not become an active source file. */
  report: string[]
  /** The actions and risks for the user, in plain words (see `UpgradeStepPlan.notices`). */
  notices?: UpgradeNotice[]
}

/**
 * The folder for each input that cannot become an active source file. The
 * folder is not a provider, so the projection gives each file in it an
 * `invalid` row. Thus the input stays in git and in the Sources pane, and it
 * does not sync.
 */
export const UNCONVERTED_SOURCES_FOLDER = `${SOURCE_FILES_FOLDER}/unconverted`

/**
 * Convert `.ctxpipe/sources.yaml` to one Markdown file for each source under
 * `sources/` (ADR-050 revision 2026-10-16, decision 14; ADR-053 upgrade step
 * 2). The function is pure, deterministic, and idempotent: a tree with no
 * `.ctxpipe/sources.yaml` gives no change.
 *
 * Rules:
 * - A valid GitHub entry gives one file for each repository, at
 *   `sources/github/<owner>/<name>.md`, with `repository` and `ref`. The
 *   projection finds each pin by repository URL and `ref`, so each `wlr_…`
 *   id stays.
 * - Each other valid entry gives `sources/<provider>/<id>.md` with the same
 *   connection and scope.
 * - A string `description` key of an entry, and the comment lines directly
 *   above an entry, become the body of its files.
 * - A source file that already has the same source (provider, connection,
 *   and scope) is kept, and the entry gives no file. Thus a second run on a
 *   tree that an old pull request gave `sources.yaml` again changes nothing
 *   that is already there.
 * - When the path is taken by a different file, the entry gets the first
 *   free path with a suffix (`eng-2.md`). The existing file does not change.
 * - An input that has no effect before the conversion gets no active file:
 *   an entry that does not parse, an entry whose id is not unique, and a
 *   GitHub repository that a source file or an earlier entry already links
 *   with a different connection or `ref`. It goes to a file under
 *   {@link UNCONVERTED_SOURCES_FOLDER}, with its data and the reason. A
 *   sources file that cannot be read goes there too, as text.
 * - The conversion deletes `.ctxpipe/sources.yaml`.
 */
export function planSourcesConversion(
  tree: SourcesConversionTree,
): SourcesConversion {
  if (tree.sourcesYaml === null) return { writes: [], deletes: [], report: [] }
  const plan = new ConversionPlan(tree.sourceFiles, tree.workspaceUrl ?? null)
  convertYaml(tree.sourcesYaml, plan)
  return {
    writes: [...plan.writes.values()]
      .map(({ path, content }) => ({ path, content }))
      .sort((a, b) => compareBytes(a.path, b.path)),
    deletes: [SOURCES_FILE_PATH],
    report: plan.report,
    notices: plan.notices,
  }
}

/**
 * The `.ctxpipe/sources.yaml` id of each file under
 * {@link UNCONVERTED_SOURCES_FOLDER} whose front matter keeps one, by path.
 * The row of such a file takes the held target of the entry row, so the
 * files of the entry stay in git when the conversion merges.
 */
export function unconvertedEntryIds(
  files: ReadonlyArray<{ path: string; text: string }>,
): Map<string, string> {
  const ids = new Map<string, string>()
  for (const file of files) {
    if (!file.path.startsWith(`${UNCONVERTED_SOURCES_FOLDER}/`)) continue
    const match = /^---\r?\n((?:.*\n)*?)---/.exec(file.text)
    if (!match) continue
    let data: unknown
    try {
      data = YAML.parse(match[1] ?? "", { maxAliasCount: 50 })
    } catch {
      continue
    }
    const id =
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>).id
        : undefined
    if (typeof id === "string") ids.set(file.path, id)
  }
  return ids
}

/** The notice for keys and comments that the conversion drops. */
const UNCONVERTED_SETTINGS: UpgradeNotice = {
  kind: "risk",
  text: "Some settings or comments of the old sources file are not converted.",
}

/** The sources that exist or that the plan writes, and the plan itself. */
class ConversionPlan {
  readonly writes = new Map<string, { path: string; content: string }>()
  readonly report: string[] = []
  readonly notices: UpgradeNotice[] = []
  /**
   * Every path under `sources/` that a file has or that the plan writes, in
   * lowercase: two paths that differ only in case are one file on a
   * case-insensitive checkout.
   */
  private readonly taken: Set<string>
  /** The text of each existing file under {@link UNCONVERTED_SOURCES_FOLDER}, by path. */
  private readonly unconverted = new Map<string, string>()
  /** The valid sources: existing files, then the files that the plan writes. */
  private readonly sources: SourceFile[] = []

  constructor(
    files: SourcesConversionTree["sourceFiles"],
    readonly workspaceUrl: string | null,
  ) {
    this.taken = new Set(files.map((file) => file.path.toLowerCase()))
    for (const file of files)
      if (file.path.startsWith(`${UNCONVERTED_SOURCES_FOLDER}/`))
        this.unconverted.set(file.path, file.text)
    for (const file of [...files].sort((a, b) =>
      compareBytes(a.path, b.path),
    )) {
      const parsed = parseSourceFile(file.path, file.text)
      if (parsed.ok) this.sources.push(parsed.source)
    }
  }

  /** The source that has the same provider, connection, and scope, or undefined. */
  same(source: Omit<SourceFile, "path">): SourceFile | undefined {
    return this.sources.find(
      (other) =>
        other.provider === source.provider &&
        other.connectionId === source.connectionId &&
        isDeepStrictEqual(other.scope, source.scope),
    )
  }

  /** The GitHub source that links `repository` (case-insensitive), or undefined. */
  linking(repository: string): SourceFile | undefined {
    const wanted = repository.toLowerCase()
    return this.sources.find(
      (other) =>
        other.provider === "github" &&
        String(other.scope.repository).toLowerCase() === wanted,
    )
  }

  /** `path` when it is free, else the first free path with a suffix `-2`, `-3`, … */
  free(path: string): string {
    const stem = path.slice(0, -".md".length)
    const isFree = (candidate: string) =>
      !this.taken.has(candidate.toLowerCase())
    if (isFree(path)) return path
    for (let n = 2; ; n++)
      if (isFree(`${stem}-${n}.md`)) return `${stem}-${n}.md`
  }

  writeSource(
    source: Omit<SourceFile, "path">,
    wantedPath: string,
    body: string,
    origin: string,
  ): void {
    const path = this.free(wantedPath)
    const content = renderSourceFile({ ...source, path }, body)
    const tooLarge = Buffer.byteLength(content, "utf8") > SOURCE_FILE_MAX_BYTES
    // A source file over the limit is invalid, and its row holds no target.
    // Thus the source file gets no body, so that it stays valid and keeps
    // its synced files. The body goes to a file that does not sync.
    this.write(
      path,
      tooLarge && body ? renderSourceFile({ ...source, path }, "") : content,
    )
    this.sources.push({ ...source, path })
    if (tooLarge && body)
      this.writeUnconverted(
        `${path.slice(`${SOURCE_FILES_FOLDER}/`.length, -".md".length)}-description`,
        undefined,
        `The description makes ${path} larger than ${SOURCE_FILE_MAX_BYTES / 1024} KiB, so ${path} has no description`,
        `the description of ${origin}`,
        `\nThe description:\n${body}`,
      )
    else if (tooLarge) {
      this.report.push(
        `${path} (from ${origin}) is larger than ${SOURCE_FILE_MAX_BYTES / 1024} KiB, so it is invalid. Split it into smaller sources.`,
      )
      this.notices.push({
        kind: "action",
        text: "Some sources are too large and are not valid. Split each one into smaller sources.",
      })
    }
  }

  writeUnconverted(
    name: string,
    frontMatter: unknown,
    reason: string,
    origin: string,
    extra = "",
  ): void {
    const yaml =
      frontMatter === undefined
        ? ""
        : YAML.stringify(frontMatter, { lineWidth: 0 })
    const content = `---\n${yaml}---\n\nctx| did not convert ${origin} of ${SOURCES_FILE_PATH}: ${reason}\n\nTo use it, move it to ${SOURCE_FILES_FOLDER}/<provider>/<name>.md, remove the id key, and correct the error. Else, remove this file.\n${extra}`
    // An old pull request can bring `sources.yaml` back. The same input then
    // gives the same text, and the file that has it stays the only copy.
    const existing = [...this.unconverted].find(([, text]) => text === content)
    const path =
      existing?.[0] ??
      this.free(
        `${UNCONVERTED_SOURCES_FOLDER}/${toSegment(name) || "entry"}.md`,
      )
    if (!existing) this.write(path, content)
    this.report.push(`${origin} went to ${path}: ${reason}`)
    this.notices.push({
      kind: "action",
      text: "ctx| could not convert some sources. They show as not valid in Sources. Fix or delete them.",
    })
  }

  private write(path: string, content: string): void {
    this.taken.add(path.toLowerCase())
    this.writes.set(path, { path, content })
  }
}

function convertYaml(text: string, plan: ConversionPlan): void {
  let document: YAML.Document.Parsed
  let data: unknown
  try {
    document = parseSourcesDocument(text)
    data = document.toJS({ maxAliasCount: 50 })
  } catch (error) {
    keepUnreadableFile(text, errorText(error), plan)
    return
  }
  if (data === null || data === undefined) {
    reportComments(document, new Set(), plan)
    return
  }
  const file = sourcesFileSchema.safeParse(data)
  if (!file.success) {
    keepUnreadableFile(
      text,
      `The file does not match version 1: ${file.error.issues.map((issue) => issue.message).join("; ")}`,
      plan,
    )
    return
  }
  const extraKeys = Object.keys(data as object).filter(
    (key) => key !== "version" && key !== "sources",
  )
  if (extraKeys.length) {
    plan.report.push(
      `${SOURCES_FILE_PATH} had keys that ctx| did not use, and they are not converted: ${extraKeys.join(", ")}`,
    )
    plan.notices.push(UNCONVERTED_SETTINGS)
  }

  const sequence = document.get("sources", true)
  const items: readonly unknown[] = YAML.isSeq(sequence)
    ? (sequence as YAMLSeq).items
    : []
  const usedComments = new Set<string>()
  const ids = file.data.sources.map((raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).id
      : undefined,
  )
  file.data.sources.forEach((raw, index) => {
    const comment = entryComment(sequence, items[index], index)
    if (comment) usedComments.add(comment)
    convertEntry(raw, index, {
      comment: comment ? commentText(comment) : null,
      duplicateId:
        typeof ids[index] === "string" &&
        ids.filter((id) => id === ids[index]).length > 1,
      plan,
    })
  })
  reportComments(document, usedComments, plan)
}

function convertEntry(
  raw: unknown,
  index: number,
  input: { comment: string | null; duplicateId: boolean; plan: ConversionPlan },
): void {
  const { plan } = input
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null
  const id = typeof record?.id === "string" ? record.id : null
  const origin = id ? `the entry "${id}"` : `entry ${index + 1}`
  const name = id ?? `entry-${index + 1}`
  if (input.duplicateId) {
    plan.writeUnconverted(
      name,
      raw,
      `The id "${id}" is used by more than one entry`,
      origin,
    )
    return
  }
  // The same parse as the projection of the YAML file, so an entry that was
  // invalid there does not start to sync here. Only a GitHub entry above the
  // repository cap (CTX-822) converts: it gives one file for each repository,
  // and it linked each of them before the cap.
  const parsed = parseLegacySourceEntry(raw)
  if (!parsed.ok) {
    plan.writeUnconverted(name, raw, parsed.detail, origin)
    return
  }
  const { entry } = parsed
  // The YAML scope of Slack and Linear drops unknown keys, but a source file
  // refuses them. A string `description` becomes the body; the projection
  // did not use the other keys, so the report names them.
  const ignored = Object.keys(record ?? {}).filter(
    (key) =>
      !["id", "provider", "connection"].includes(key) && !(key in entry.scope),
  )
  const description =
    ignored.includes("description") && typeof record?.description === "string"
      ? record.description.trim()
      : ""
  const unused = ignored.filter(
    (key) => !(key === "description" && description),
  )
  if (unused.length) {
    plan.report.push(
      `${origin} had keys that ctx| did not use, and they are not converted: ${unused.join(", ")}`,
    )
    plan.notices.push(UNCONVERTED_SETTINGS)
  }
  const body = [description, input.comment ?? ""]
    .filter(Boolean)
    .map((text) => `\n${text}\n`)
    .join("")

  if (entry.provider !== "github") {
    const source = {
      provider: entry.provider,
      connectionId: entry.connectionId,
      scope: entry.scope,
    }
    if (plan.same(source)) return
    plan.writeSource(
      source,
      `${SOURCE_FILES_FOLDER}/${entry.provider}/${entry.key}.md`,
      body,
      origin,
    )
    return
  }

  const scope = githubLegacyScopeSchema.parse(entry.scope)
  for (const { name: repository, ref } of githubScopeRepositories(scope)) {
    const source = {
      provider: "github" as const,
      connectionId: entry.connectionId,
      scope: ref === null ? { repository } : { repository, ref },
    }
    if (
      plan.workspaceUrl &&
      normalizeWorkspaceRepositoryUrl(plan.workspaceUrl).toLowerCase() ===
        normalizeWorkspaceRepositoryUrl(
          `https://github.com/${repository}`,
        ).toLowerCase()
    ) {
      plan.report.push(
        `${repository} in ${origin} is the Workspace repository, so it was skipped. A Workspace cannot link its own repository.`,
      )
      continue
    }
    const holder = plan.linking(repository)
    if (holder && plan.same(source)) continue
    if (holder) {
      plan.writeUnconverted(
        `github-${repository.replace("/", "-")}`,
        {
          provider: "github",
          connection: entry.connectionId,
          ...source.scope,
        },
        `${holder.path} already links ${repository}`,
        `${repository} in ${origin}`,
      )
      continue
    }
    const [owner = "", repo = ""] = repository.split("/")
    plan.writeSource(
      source,
      githubFilePath(owner, repo),
      body,
      `${repository} in ${origin}`,
    )
  }
}

/**
 * The GitHub source path of a repository. A repository name that is not a
 * valid path segment (for example `api.lock` or `a..b`) gets `-` in place
 * of each `.`.
 */
function githubFilePath(owner: string, name: string): string {
  const path = githubSourcePath(owner, name)
  if (checkSourcePath(path).ok) return path
  return `${SOURCE_FILES_FOLDER}/github/${owner.toLowerCase()}/${toSegment(name.replaceAll(".", "-")) || "repository"}.md`
}

/** Keep a sources file that cannot be read, as text in a file. */
function keepUnreadableFile(
  text: string,
  reason: string,
  plan: ConversionPlan,
): void {
  const fence = "~".repeat(
    Math.max(
      3,
      ...[...text.matchAll(/~+/g)].map((match) => match[0].length + 1),
    ),
  )
  plan.writeUnconverted(
    "sources-yaml",
    undefined,
    reason,
    "the full file",
    `\nThe text of the file:\n\n${fence}yaml\n${text}${text.endsWith("\n") ? "" : "\n"}${fence}\n`,
  )
}

/**
 * The comment lines directly above the entry `item`. The YAML parser puts the
 * comment of the first entry on the list.
 */
function entryComment(
  sequence: unknown,
  item: unknown,
  index: number,
): string | null {
  if (isNode(item) && item.commentBefore) return item.commentBefore
  if (index === 0 && isNode(sequence) && sequence.commentBefore)
    return sequence.commentBefore
  return null
}

/** Report each comment of the file that is not the description of an entry. */
function reportComments(
  document: YAML.Document.Parsed,
  used: ReadonlySet<string>,
  plan: ConversionPlan,
): void {
  const comments: string[] = []
  const add = (comment: string | null | undefined) => {
    if (comment && !used.has(comment)) comments.push(commentText(comment))
  }
  add(document.commentBefore)
  YAML.visit(document, (_key, node) => {
    if (isNode(node)) {
      add((node as Node).commentBefore)
      add((node as Node).comment)
    }
  })
  add(document.comment)
  if (comments.length) {
    plan.report.push(
      `${SOURCES_FILE_PATH} had comments that are not above an entry, and they are not converted:\n${comments.map((comment) => `> ${comment.replaceAll("\n", "\n> ")}`).join("\n")}`,
    )
    plan.notices.push(UNCONVERTED_SETTINGS)
  }
}

/** The text of a YAML comment: each line without the space after `#`. */
function commentText(comment: string): string {
  return comment
    .split("\n")
    .map((line) => line.replace(/^ /, ""))
    .join("\n")
    .trim()
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
