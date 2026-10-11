import { type FileDiffMetadata, parseDiffFromFile } from "@pierre/diffs"
import type { ConversationGitDiffItem } from "./types"

export type ChangedFileStatus = "added" | "modified" | "deleted"

export type ChangedFile = {
  path: string
  status: ChangedFileStatus
  additions: number
  deletions: number
}

export type ConversationDiffFile = ChangedFile & { diff: FileDiffMetadata }

/** Parses each before and after body once, for the rows and their diffs. */
export function conversationDiffFiles(
  items: ConversationGitDiffItem[],
): ConversationDiffFile[] {
  return items.map((item) => {
    const status: ChangedFileStatus =
      item.oldBody == null
        ? "added"
        : item.body == null
          ? "deleted"
          : "modified"
    const diff = parseDiffFromFile(
      item.oldBody == null
        ? null
        : {
            name: item.path,
            contents: item.oldBody,
            cacheKey: `old:${item.path}`,
          },
      item.body == null
        ? null
        : {
            name: item.path,
            contents: item.body,
            cacheKey: `new:${item.path}`,
          },
    )
    let additions = 0
    let deletions = 0
    for (const hunk of diff.hunks) {
      additions += hunk.additionLines
      deletions += hunk.deletionLines
    }
    return { path: item.path, status, additions, deletions, diff }
  })
}

export type ChangedFolder = {
  folder: string
  additions: number
  deletions: number
  files: ChangedFile[]
}

export function groupChangedFilesByFolder(
  files: ChangedFile[],
): ChangedFolder[] {
  const byFolder = new Map<string, ChangedFolder>()
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  for (const file of sorted) {
    const slash = file.path.lastIndexOf("/")
    const folder = slash === -1 ? "" : file.path.slice(0, slash)
    const group = byFolder.get(folder) ?? {
      folder,
      additions: 0,
      deletions: 0,
      files: [],
    }
    group.additions += file.additions
    group.deletions += file.deletions
    group.files.push(file)
    byFolder.set(folder, group)
  }
  return [...byFolder.values()].sort((a, b) => a.folder.localeCompare(b.folder))
}

export function formatLineCount(count: number): string {
  if (count < 1_000) return String(count)
  const thousands = count / 1_000
  return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}k`
}
