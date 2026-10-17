import type { z } from "zod"
import { checkPlainGitUrl } from "./providers/git.js"
import { githubFileSourceScope } from "./providers/github.js"
import type { SourceScopeDefinition } from "./providers/scope.js"
import {
  SOURCE_PROVIDERS,
  SOURCE_SCOPES,
  type SourceProvider,
  sourceConnectionIdSchema,
  sourceProviderSchema,
} from "./sources-file.js"

/**
 * The shared schema of a source file: one Markdown file under `sources/` for
 * each Workspace source (ADR-050, revision 2026-10-16). The front matter
 * holds the provider, the connection, and the scope. The body is a
 * description that people own. The backend and the UI import this module,
 * so it imports only `zod` and the provider scope modules. The text parser
 * (YAML) is in `source-file-text.ts`.
 *
 * Each path in this module is relative to the Workspace root folder.
 */

export const SOURCE_FILES_FOLDER = "sources"

/** The largest source file that ctx| reads (64 KiB). */
export const SOURCE_FILE_MAX_BYTES = 64 * 1024

/**
 * The scope of each provider in a source file. A GitHub file names one
 * repository; the other providers use the scope of `.ctxpipe/sources.yaml`.
 */
export const SOURCE_FILE_SCOPES: Record<SourceProvider, SourceScopeDefinition> =
  { ...SOURCE_SCOPES, github: githubFileSourceScope }

/** The front matter keys of every source file. The other keys are the scope. */
const COMMON_KEYS: ReadonlySet<string> = new Set(["provider", "connection"])

/** Keys that a source file must not have: the path is the id, the folder is the kind. */
const REFUSED_KEYS = ["id", "kind"] as const

// A segment is also a part of a pull request branch name, so it follows the
// git ref name rules too: no "..", no "." at the end, no ".lock" at the end.
const SEGMENT = /^(?!.*\.\.)(?!.*\.lock$)[a-z0-9][a-z0-9._-]{0,99}(?<!\.)$/
const SEGMENT_RULE =
  "Each path segment uses lowercase letters, digits, '.', '_', and '-', starts with a letter or digit, does not have '..', does not end with '.' or '.lock', and has at most 100 characters"

export type SourceFile = {
  /** The path of the file, relative to the Workspace root folder. */
  path: string
  provider: SourceProvider
  /** Null only for a plain git source, which has no connection (CTX-815). */
  connectionId: string | null
  scope: Record<string, unknown>
}

export type ParsedSourceFile =
  | { ok: true; source: SourceFile; body: string }
  | {
      ok: false
      path: string
      /** Present when the folder or the front matter gives a known provider. */
      provider: SourceProvider | null
      connectionId: string | null
      /**
       * The scope, when the scope keys parse but another key is wrong. Thus a
       * GitHub row that is invalid for a time keeps the pin of its repository.
       */
      scope?: Record<string, unknown>
      detail: string
    }

/**
 * Check the path rules of ADR-050: `sources/<provider>/<name>.md` or
 * `sources/<provider>/<group>/<name>.md`.
 */
export function checkSourcePath(
  path: string,
): { ok: true; provider: SourceProvider } | { ok: false; reason: string } {
  const parts = path.split("/")
  if (parts[0] !== SOURCE_FILES_FOLDER)
    return { ok: false, reason: "A source path starts with sources/" }
  if (parts.length !== 3 && parts.length !== 4)
    return {
      ok: false,
      reason:
        "Use sources/<provider>/<name>.md or sources/<provider>/<group>/<name>.md",
    }
  const provider = sourceProviderSchema.safeParse(parts[1])
  if (!provider.success)
    return {
      ok: false,
      reason: `The provider folder must be one of ${SOURCE_PROVIDERS.join(", ")}`,
    }
  const file = parts.at(-1) ?? ""
  if (!file.endsWith(".md"))
    return { ok: false, reason: "A source file name ends with .md" }
  const segments = [...parts.slice(2, -1), file.slice(0, -".md".length)]
  if (!segments.every((segment) => SEGMENT.test(segment)))
    return { ok: false, reason: SEGMENT_RULE }
  return { ok: true, provider: provider.data }
}

/** Make one path segment from free text, or "" when nothing is left. */
export function toSegment(text: string): string {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 100)
    .replace(/[-.]+$/, "")
}

/**
 * The path of a new GitHub source file: `sources/github/<owner>/<name>.md`,
 * in lowercase. A segment must start with a letter or digit, so a name that
 * starts with `.` (for example `.github`) gets `dot-` in place of the `.`. A
 * name that starts with `dot`, zero or more `0`, and `-` gets one more `0`
 * (`dot-foo` becomes `dot0-foo`). Thus two names never get the same path.
 */
export function githubSourcePath(owner: string, name: string): string {
  const lower = name.toLowerCase()
  const repo = lower.startsWith(".")
    ? `dot-${lower.slice(1)}`
    : lower.replace(/^dot(0*)-/, (_, zeros: string) => `dot${zeros}0-`)
  return `${SOURCE_FILES_FOLDER}/github/${owner.toLowerCase()}/${repo}.md`
}

/**
 * The path of a new plain git source file: `sources/git/<host>/<name>.md`.
 * The name comes from the repository path, with no `.git` at the end. When
 * the path is in `taken`, the name gets the first free suffix. Null when the
 * URL is not a plain git URL ({@link checkPlainGitUrl}).
 */
export function gitSourcePath(
  url: string,
  taken: ReadonlySet<string> = new Set(),
): string | null {
  const checked = checkPlainGitUrl(url)
  if (!checked.ok) return null
  const host = toSegment(checked.host)
  const name =
    toSegment(
      checked.path
        .replace(/\.git$/i, "")
        .split("/")
        .filter(Boolean)
        .join("-"),
    ).slice(0, 90) || "repository"
  const pathOf = (stem: string) =>
    `${SOURCE_FILES_FOLDER}/git/${host}/${stem}.md`
  if (!taken.has(pathOf(name))) return pathOf(name)
  for (let n = 2; ; n++)
    if (!taken.has(pathOf(`${name}-${n}`))) return pathOf(`${name}-${n}`)
}

/**
 * The path of a new source file of a provider other than GitHub:
 * `sources/<provider>/<name>.md`. The name comes from `label`, or is the
 * provider. When the path is in `taken`, the name gets the first free
 * suffix (`linear-2`, `linear-3`, …).
 */
export function sourcePathFor(
  provider: SourceProvider,
  label: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  const name = toSegment(label).slice(0, 90) || provider
  const pathOf = (stem: string) =>
    `${SOURCE_FILES_FOLDER}/${provider}/${stem}.md`
  if (!taken.has(pathOf(name))) return pathOf(name)
  for (let n = 2; ; n++)
    if (!taken.has(pathOf(`${name}-${n}`))) return pathOf(`${name}-${n}`)
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ")
}

/**
 * Validate the parsed front matter of the source file at `path`. `body` is
 * the text after the front matter; this function does not read it.
 */
export function parseSourceFrontMatter(
  path: string,
  frontMatter: unknown,
  body: string,
): ParsedSourceFile {
  const checked = checkSourcePath(path)
  const record =
    frontMatter &&
    typeof frontMatter === "object" &&
    !Array.isArray(frontMatter)
      ? (frontMatter as Record<string, unknown>)
      : null
  const provider = sourceProviderSchema.safeParse(record?.provider)
  const connection = sourceConnectionIdSchema.safeParse(record?.connection)
  const rawScope = Object.fromEntries(
    Object.entries(record ?? {}).filter(
      ([key]) =>
        !COMMON_KEYS.has(key) &&
        !(REFUSED_KEYS as readonly string[]).includes(key),
    ),
  )
  const scope = checked.ok
    ? SOURCE_FILE_SCOPES[checked.provider].schema.safeParse(rawScope)
    : null
  const fail = (detail: string): ParsedSourceFile => ({
    ok: false,
    path,
    provider: checked.ok
      ? checked.provider
      : provider.success
        ? provider.data
        : null,
    connectionId: connection.success ? connection.data : null,
    ...(scope?.success ? { scope: scope.data } : {}),
    detail,
  })
  if (!checked.ok) return fail(checked.reason)
  if (!record) return fail("The front matter must be a map")
  const refused = REFUSED_KEYS.filter((key) => key in record)
  if (refused.length)
    return fail(
      `Remove ${refused.join(" and ")}: the path is the id, and the folder gives the kind`,
    )
  if (!provider.success)
    return fail(`provider: use one of ${SOURCE_PROVIDERS.join(", ")}`)
  if (provider.data !== checked.provider)
    return fail(
      `provider: ${provider.data} is not the provider folder ${checked.provider}`,
    )
  // A plain git source reads a public URL with no credential, so it has no
  // connection (CTX-815). Each other provider needs one.
  const needsConnection = SOURCE_FILE_SCOPES[provider.data].connectionType
  if (needsConnection === null && "connection" in record)
    return fail("connection: a plain git source has no connection")
  if (needsConnection !== null && !connection.success)
    return fail(`connection: ${issuesText(connection.error)}`)
  // The provider equals the provider of the path, so `scope` is its scope.
  if (!scope?.success)
    return fail(scope ? issuesText(scope.error) : "The scope does not parse")
  // A scope schema that strips unknown keys still must not hide a typo.
  const unknown = Object.keys(rawScope).filter((key) => !(key in scope.data))
  if (unknown.length) return fail(`Unknown scope keys: ${unknown.join(", ")}`)
  return {
    ok: true,
    source: {
      path,
      provider: provider.data,
      connectionId: needsConnection === null ? null : (connection.data ?? null),
      scope: scope.data,
    },
    body,
  }
}
