import { withOrgDbContext } from "../../db/client.js"
import {
  getWorkspaceSearchProjection,
  workspaceKnowledgeFolderCounts,
} from "../../models/workspaces.js"

/**
 * The hard limit of the orientation system prompt, in characters (about 500
 * tokens). Knowledge can hold many thousands of files, so the prompt never
 * lists file names: it gives the searchable repositories, the largest
 * top-level knowledge folders with their file counts, and the file to read
 * for more. The prompt drops folders, then repositories, until it fits.
 */
export const WORKSPACE_CHAT_ORIENTATION_MAX_CHARS = 2000

const MAX_LISTED = 20
const MAX_NAME_CHARS = 100

export type WorkspaceChatOrientationInput = {
  repositories: ReadonlyArray<{ id: string; name: string }>
  /** Top-level knowledge folders; `""` is the files at the Workspace root. */
  folders: ReadonlyArray<{ folder: string; files: number }>
  /** All knowledge folders and files, also those not in `folders`. */
  totalFolders: number
  totalFiles: number
  rootPath?: string
}

/**
 * A short orientation for the chat agent, so that it does not call
 * list_repositories or explore to find its way. The same input gives the
 * same text, so the prompt cache keeps it across turns.
 */
export function workspaceChatOrientationPrompt(
  input: WorkspaceChatOrientationInput,
): string {
  const prefix = input.rootPath ? `${input.rootPath}/` : ""
  const short = (text: string) =>
    text.length > MAX_NAME_CHARS
      ? `${text.slice(0, MAX_NAME_CHARS - 1)}…`
      : text
  const repositories = [
    ...new Map(input.repositories.map((repo) => [repo.id, repo])).values(),
  ]
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .slice(0, MAX_LISTED)
    .map((repo) => ({ id: repo.id, name: short(repo.name) }))
  const uniqueRepositories = new Set(input.repositories.map((r) => r.id)).size
  const folders = [...input.folders]
    .sort((a, b) => b.files - a.files || a.folder.localeCompare(b.folder))
    .slice(0, MAX_LISTED)
    .map((entry) => ({
      path: entry.folder ? `${prefix}${short(entry.folder)}/` : prefix || ".",
      files: entry.files,
    }))
  const render = () =>
    JSON.stringify({
      type: "workspace_orientation",
      instructions:
        "Use these repository ids with the code tools; do not call list_repositories for them. This is a summary, not a file list. For more, read the AGENTS.md file below (the folder map), or use hybrid_search, glob, and grep.",
      repositories,
      ...(uniqueRepositories > repositories.length
        ? { moreRepositories: uniqueRepositories - repositories.length }
        : {}),
      knowledge: {
        files: input.totalFiles,
        folders: input.totalFolders,
        largestFolders: folders,
        ...(input.totalFolders > folders.length
          ? { moreFolders: input.totalFolders - folders.length }
          : {}),
        readForMore: `${prefix}AGENTS.md`,
      },
    })
  let text = render()
  while (text.length > WORKSPACE_CHAT_ORIENTATION_MAX_CHARS) {
    if (folders.length) folders.pop()
    else if (repositories.length) repositories.pop()
    else break
    text = render()
  }
  return text
}

/**
 * Reads the orientation of a Workspace: two small queries (the database
 * counts files for each folder), never the file list.
 */
export async function loadWorkspaceChatOrientation(input: {
  orgId: string
  workspaceId: string
  rootPath?: string
}): Promise<string> {
  const { repositories, folders } = await withOrgDbContext(
    input.orgId,
    async () => ({
      repositories: (await getWorkspaceSearchProjection(input.workspaceId))
        .repositories,
      folders: await workspaceKnowledgeFolderCounts(
        input.workspaceId,
        MAX_LISTED,
      ),
    }),
  )
  return workspaceChatOrientationPrompt({
    repositories,
    folders,
    totalFolders: folders[0]?.folders ?? 0,
    totalFiles: folders[0]?.total ?? 0,
    ...(input.rootPath ? { rootPath: input.rootPath } : {}),
  })
}
