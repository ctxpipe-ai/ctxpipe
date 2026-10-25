import type { InferResponseType } from "hono/client"

import type { ApiClient } from "@/lib/api"

type WithOptional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>

type V1 = ApiClient[":orgSlug"]["api"]["v1"]
type WorkspaceRoutes = V1["workspaces"][":workspaceSlug"]
type ConversationRoutes = V1["conversations"][":conversationId"]

/** The response types come from the backend routes through the Hono client. */
type WorkspaceListRead = InferResponseType<V1["workspaces"]["$get"], 200>

/** `conversationWritable`: older responses omit it, and the UI falls back to the write status. */
export type Workspace = WithOptional<
  WorkspaceListRead["items"][number],
  "conversationWritable"
>

export type WorkspaceListResponse = Omit<WorkspaceListRead, "items"> & {
  items: Workspace[]
}

type WorkspaceDetailRead = InferResponseType<WorkspaceRoutes["$get"], 200>

/** `skippedFiles` and `hydratePhases` are absent on a detail seeded from the list. */
export type WorkspaceDetail = Omit<
  WithOptional<
    WorkspaceDetailRead,
    "skippedFiles" | "hydratePhases" | "conversationWritable"
  >,
  "linkedRepositories"
> & { linkedRepositories: WorkspaceLinkedRepository[] }

type LinkedRepositoryRead = WorkspaceDetailRead["linkedRepositories"][number]

/** The org repository index health is absent when the repository has no index row. */
export type WorkspaceLinkedRepository = WithOptional<
  LinkedRepositoryRead,
  "indexingStatus" | "indexingError"
>

export type WorkspaceSkippedFile = NonNullable<
  WorkspaceDetailRead["skippedFiles"]
>[number]

export type WorkspaceStorePhase = NonNullable<
  WorkspaceDetailRead["hydratePhases"]
>["graph"]

export type WorkspaceActivityResponse = InferResponseType<
  V1["activity"]["$get"],
  200
>

export type WorkspaceActivityDay = WorkspaceActivityResponse["days"][number]

export type WorkspaceActivityCommit =
  WorkspaceActivityResponse["recent"][number]

type WorkspaceFilesRead = InferResponseType<
  WorkspaceRoutes["files"]["$get"],
  200
>

/** The route schema is recursive, so the client type of `children` is loose. */
export type WorkspaceFileTreeNode = {
  name: string
  path: string
  children?: WorkspaceFileTreeNode[]
}

export type WorkspaceFilesResponse = Omit<WorkspaceFilesRead, "tree"> & {
  tree: WorkspaceFileTreeNode[]
}

export type WorkspaceGitTreeResponse = InferResponseType<
  WorkspaceRoutes["files"]["tree"]["$get"],
  200
>

type ConversationGitTreeRead = InferResponseType<
  ConversationRoutes["files"]["tree"]["$get"],
  200
>

/** `ready` is set by a poll that waits for the sandbox; a cached tree has no `worktreeVersion`. */
export type ConversationGitTreeResponse = Omit<
  ConversationGitTreeRead,
  "worktreeVersion"
> & { worktreeVersion?: string; ready?: boolean }

export type WorkspaceGitBlobResponse = InferResponseType<
  WorkspaceRoutes["files"]["blob"]["$get"],
  200
>

export type WorkspaceGitStatusResponse = InferResponseType<
  WorkspaceRoutes["files"]["status"]["$get"],
  200
>

export type WorkspaceGitStatusItem = WorkspaceGitStatusResponse["items"][number]

type ConversationGitStatusRead = InferResponseType<
  ConversationRoutes["files"]["status"]["$get"],
  200
>

/** The sandbox status read; the cached copies of it omit some fields. */
export type ConversationGitStatusResponse = WithOptional<
  ConversationGitStatusRead,
  | "sha"
  | "desiredSha"
  | "stale"
  | "workspaceMovedUnderChanges"
  | "worktreeVersion"
>

/** A diff read. `gone`: the turn's snapshots are no longer in the sandbox (410). */
type ConversationGitDiffRead = InferResponseType<
  ConversationRoutes["files"]["diff"]["$get"],
  200
>

export type ConversationGitDiffResponse = Omit<
  ConversationGitDiffRead,
  "base"
> & {
  base?: string
  gone?: boolean
}

export type ConversationGitDiffItem =
  ConversationGitDiffResponse["items"][number]

export type ConversationTurnChangesResponse = InferResponseType<
  ConversationRoutes["turns"]["$get"],
  200
>

export type ConversationTurnChanges =
  ConversationTurnChangesResponse["items"][number]

/** One changed file, as the backend's git diff gives it. */
export type ChangedFile = ConversationTurnChanges["files"][number]

/** One push of the conversation's commits to its branch. */
export type ConversationSync = ConversationTurnChangesResponse["syncs"][number]

export type ConversationFileMutation = {
  path: string
  body?: string
  deletePath?: boolean
  from?: string
  expectedWorktreeVersion: string
}

type ConversationFileWriteRead = InferResponseType<
  ConversationRoutes["files"]["blob"]["$put"],
  200
>

export type ConversationFileWriteResponse = Omit<
  ConversationFileWriteRead,
  "status" | "tree"
> & {
  tree: ConversationGitTreeResponse
  status: ConversationGitStatusResponse
}

export type ConversationPushResponse = InferResponseType<
  ConversationRoutes["push"]["$post"],
  200
>

export type ConversationPullRequestResponse = InferResponseType<
  ConversationRoutes["pull-request"]["$get"],
  200
>

export type WorkspaceFileJobRequest =
  | { op: "save"; path: string; content: string }
  | { op: "create"; path: string; kind: "file" | "folder"; content?: string }
  | { op: "rename"; from: string; to: string }
  | { op: "move"; from: string; toDirectory: string | null }
  | { op: "delete"; path: string }

/** What the graph route returns when the graph is ready. */
export type WorkspaceGraphPayload = InferResponseType<
  WorkspaceRoutes["graph"]["$get"],
  200
>
