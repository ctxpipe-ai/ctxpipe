/**
 * The Workspace paths that no agent write can change without a pull request
 * (CTX-722, CTX-721). A source grants data flow, so a person must review a
 * change to its config: `.ctxpipe/` holds the old sources config, and each
 * file under `sources/` is one source. The patch validator, the ingest ref
 * broker and the semantic merge write without a pull request, so they refuse
 * these paths. Conversation publish pushes only to the session branch, so it
 * allows them. Each agent write path must call this one function.
 */
const HOST_ONLY_FOLDERS = [".ctxpipe", "sources"] as const

/**
 * True when `path` is a host-only folder or a file in one. The match ignores
 * case, so a checkout on a case-insensitive file system cannot write the
 * folder under another spelling.
 */
export function isHostOnlyPath(path: string): boolean {
  const folded = path.normalize("NFC").toLowerCase()
  return HOST_ONLY_FOLDERS.some(
    (folder) => folded === folder || folded.startsWith(`${folder}/`),
  )
}
