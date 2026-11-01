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
    if (!Number.isNaN(time)) return time
  }
  return null
}

/**
 * The Notion database files that list rows. A row is at
 * `<database>/rows/<row>/index.md`, and the index and the table of the
 * database are at `<database>/index.md` and `<database>/table.csv`.
 */
function derivedFromRow(rowPath: string): string[] {
  const rows = rowPath.indexOf("/rows/")
  if (rows < 0) return []
  const database = rowPath.slice(0, rows)
  return [`${database}/index.md`, `${database}/table.csv`]
}

/**
 * The changes that a connector mirror write makes to the tip (CTX-1104).
 *
 * One write can hold many items of one provider fetch. A file is stale when
 * the file on the tip at its path has a strictly newer update time. A stale
 * file is dropped, and the other files stay. A file with no update time that
 * lists rows (the index and the table of a database) is dropped too when a
 * row of that database is stale. A file on the tip with Git conflict markers,
 * or a side with no update time that ctxpipe can read, never makes a file
 * stale. The changes are the files that are not stale and not byte-identical
 * to the tip, and the deletes of paths on the tip.
 */
export async function mirrorWriteChanges<F extends GitFileChange>(
  write: { files: F[]; deletePaths: string[] },
  readTip: (path: string) => Promise<Buffer | null>,
): Promise<{ files: F[]; deletePaths: string[]; staleDropped: number }> {
  const candidates: F[] = []
  const stalePaths = new Set<string>()
  for (const file of write.files) {
    const bytes = gitFileBytes(file)
    const onTip = await readTip(file.path)
    if (onTip?.equals(bytes)) continue
    if (onTip && !hasConflictMarkers(onTip.toString("utf8"))) {
      const incomingTime = updateTime(bytes.toString("utf8"))
      const tipTime = updateTime(onTip.toString("utf8"))
      if (incomingTime !== null && tipTime !== null && tipTime > incomingTime) {
        stalePaths.add(file.path)
        continue
      }
    }
    candidates.push(file)
  }
  const staleDerived = new Set([...stalePaths].flatMap(derivedFromRow))
  const files = candidates.filter(
    (file) =>
      !(
        staleDerived.has(file.path) &&
        updateTime(gitFileBytes(file).toString("utf8")) === null
      ),
  )
  const deletePaths: string[] = []
  for (const path of write.deletePaths)
    if (await readTip(path)) deletePaths.push(path)
  return {
    files,
    deletePaths,
    staleDropped: stalePaths.size + candidates.length - files.length,
  }
}
