/**
 * The Workspace root folder, as the backend stores it (CTX-709): a relative
 * path without a trailing slash; "" is the whole repository. The backend
 * checks the same rules; this check only gives an early message.
 */
export function normalizeRootFolder(raw: string): string {
  return raw.trim().replace(/\/+$/, "")
}

export function rootFolderError(raw: string): string | null {
  const path = normalizeRootFolder(raw)
  if (path === "") return null
  const segments = path.split("/")
  const valid =
    raw.length <= 200 &&
    segments.length <= 16 &&
    segments.every(
      (segment) =>
        /^[A-Za-z0-9._-]+$/.test(segment) &&
        segment !== "." &&
        segment !== ".." &&
        segment.toLowerCase() !== ".git",
    )
  return valid
    ? null
    : "Use a relative folder path, like docs/context. Use only letters, numbers, '.', '_', '-', and '/'."
}
