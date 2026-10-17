import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { contextIndexAtStepBase } from "../domain/ingestion/context-index.js"

/** The tree of no file: a projection with no unit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

/**
 * Write the context index of a test step through the host path
 * (`contextIndexAtStepBase`, ADR-052 section 6) to
 * `<root>/context/<workspaceId>.index.json`. With no pinned revision, the
 * projection is empty and each file at `base` is a file that the run wrote.
 */
export async function writeStepIndex(input: {
  root: string
  workspaceId: string
  contextDir: string
  base: string
  /** The source file path of the run's repository (`sources`). */
  sourcePath: string
  pinnedRevision?: string
}): Promise<void> {
  const { json } = await contextIndexAtStepBase({
    workspaceId: input.workspaceId,
    projection: [],
    pinnedRevision: input.pinnedRevision ?? EMPTY_TREE,
    base: input.base,
    sourcePath: input.sourcePath,
    repoDir: input.contextDir,
  })
  writeFileSync(
    join(input.root, "context", `${input.workspaceId}.index.json`),
    json,
  )
}
