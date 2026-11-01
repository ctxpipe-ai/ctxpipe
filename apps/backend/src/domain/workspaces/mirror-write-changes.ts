import {
  type GitFileChange,
  gitFileBytes,
} from "../../services/git/file-change.js"
import { splitFrontmatter } from "../codeIngestion/connectorFrontmatter.js"
import { hasConflictMarkers } from "./conflict-markers.js"

function updateTime(text: string): number | null {
  const data = splitFrontmatter(text)?.data
  // GitHub and Linear write `updatedAt`, PagerDuty and Plain write
  // `updated_at`, and Notion writes `last_edited_time`.
  for (const key of ["updatedAt", "updated_at", "last_edited_time"]) {
    const value = data?.[key]
    if (typeof value !== "string") continue
    const time = Date.parse(value)
    return Number.isNaN(time) ? null : time
  }
  return null
}

/**
 * The changes that a connector mirror write makes to the tip (CTX-1104).
 *
 * The files of one write come from one provider fetch. When the file on the
 * tip at one of the paths is a strictly newer snapshot, the write is stale,
 * and it changes nothing: no file and no delete. A file on the tip with Git
 * conflict markers, or a file where a side has no update time that ctxpipe
 * can read, never makes the write stale. Otherwise the changes are the files
 * that are not byte-identical to the tip and the deletes of paths on the tip.
 */
export async function mirrorWriteChanges<F extends GitFileChange>(
  write: { files: F[]; deletePaths: string[] },
  readTip: (path: string) => Promise<Buffer | null>,
): Promise<{ files: F[]; deletePaths: string[] }> {
  const files: F[] = []
  for (const file of write.files) {
    const bytes = gitFileBytes(file)
    const onTip = await readTip(file.path)
    if (onTip?.equals(bytes)) continue
    if (onTip && !hasConflictMarkers(onTip.toString("utf8"))) {
      const incomingTime = updateTime(bytes.toString("utf8"))
      const tipTime = updateTime(onTip.toString("utf8"))
      if (incomingTime !== null && tipTime !== null && tipTime > incomingTime)
        return { files: [], deletePaths: [] }
    }
    files.push(file)
  }
  const deletePaths: string[] = []
  for (const path of write.deletePaths)
    if (await readTip(path)) deletePaths.push(path)
  return { files, deletePaths }
}
