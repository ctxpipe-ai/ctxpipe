import { posix } from "node:path"

import { log } from "../../observability/logger.js"

/**
 * Why `path` is not a safe mirror path, or null. A folder path ends with
 * "/". The path must already be in its normal form: the sync refuses a path
 * that a POSIX or a Unicode (NFC) normalization changes. It does not repair
 * the path, because the repaired path can point to a file of a different
 * owner.
 *
 * A folder segment can start with ".", because a GitHub repository name
 * (".github") makes a folder of the pull request mirror. A file name cannot
 * start with ".", because Git reads files such as ".gitattributes".
 */
export function unsafeMirrorPath(path: string, folder = false): string | null {
  if (path.normalize("NFC") !== path) return "changes in Unicode NFC form"
  // oxlint-disable-next-line no-control-regex -- the check refuses control characters
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path))
    return "contains a control character"
  if (path.includes("\\")) return "contains a backslash"
  if (path.startsWith("/")) return "is absolute"
  if (folder !== path.endsWith("/"))
    return folder ? 'must end with "/"' : 'must not end with "/"'
  const body = folder ? path.slice(0, -1) : path
  const parts = body.split("/")
  if (parts.some((part) => part === "" || part === "." || part === ".."))
    return 'has an empty, ".", or ".." segment'
  if (parts.some((part) => part.toLowerCase() === ".git"))
    return 'has a ".git" segment'
  if (!folder && parts.at(-1)?.startsWith("."))
    return 'has a file name that starts with "."'
  if (posix.normalize(body) !== body) return "changes when normalized"
  return null
}

/**
 * Why the write seam refuses to write the slice file `path`, or null: the
 * path must be a safe mirror path under one of `ownedPrefixes`.
 */
export function refusedSliceFile(
  path: string,
  ownedPrefixes: readonly string[],
): string | null {
  return (
    unsafeMirrorPath(path) ??
    (ownedPrefixes.some((prefix) => path.startsWith(prefix))
      ? null
      : "is not under a path that the write owns")
  )
}

/**
 * Refuse a mirror path. The log gets the path and the reason. The error
 * does not, because the path can contain provider ids and the error goes
 * to workflow errors.
 */
export function refuseMirrorPath(input: {
  provider: string
  path: string
  reason: string
}): never {
  log.warn({
    step: "workspace_sources.refused_path",
    message: "A mirror path is not safe",
    ...input,
  })
  throw new Error(
    `The ${input.provider} sync refused an unsafe path. Nothing was written.`,
  )
}
