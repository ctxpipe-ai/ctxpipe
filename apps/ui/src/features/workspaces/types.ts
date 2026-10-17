import type { InferResponseType } from "hono/client"
import type { ApiClient } from "@/lib/api"

type V1 = ApiClient[":orgSlug"]["api"]["v1"]
type WorkspaceRoutes = V1["workspaces"][":workspaceSlug"]
type ConversationRoutes = V1["conversations"][":conversationId"]

/** The response types come from the backend routes through the Hono client. */
export type WorkspaceListResponse = InferResponseType<
  V1["workspaces"]["$get"],
  200
>

export type Workspace = WorkspaceListResponse["items"][number]

export type WorkspaceDetail = InferResponseType<WorkspaceRoutes["$get"], 200>

export type WorkspaceLinkedRepository =
  WorkspaceDetail["linkedRepositories"][number]

export type WorkspaceSkippedFile = NonNullable<
  WorkspaceDetail["skippedFiles"]
>[number]

export type WorkspaceStorePhase = NonNullable<
  WorkspaceDetail["hydratePhases"]
>["graph"]

export type WorkspaceActivityResponse = InferResponseType<
  V1["activity"]["$get"],
  200
>

export type WorkspaceActivityDay = WorkspaceActivityResponse["days"][number]

export type WorkspaceActivityCommit =
  WorkspaceActivityResponse["recent"][number]

export type WorkspaceFilesResponse = InferResponseType<
  WorkspaceRoutes["files"]["$get"],
  200
>

export type WorkspaceFile = WorkspaceFilesResponse["items"][number]

export type WorkspaceFileTreeNode = WorkspaceFilesResponse["tree"][number]

export type WorkspaceGitTreeResponse = InferResponseType<
  WorkspaceRoutes["files"]["tree"]["$get"],
  200
>

export type ConversationGitTreeResponse = InferResponseType<
  ConversationRoutes["files"]["tree"]["$get"],
  200
>

export type WorkspaceGitBlobResponse = InferResponseType<
  WorkspaceRoutes["files"]["blob"]["$get"],
  200
>

export type WorkspaceGitStatusResponse = InferResponseType<
  WorkspaceRoutes["files"]["status"]["$get"],
  200
>

export type WorkspaceGitStatusItem = WorkspaceGitStatusResponse["items"][number]

export type WorkspaceGitStatus = WorkspaceGitStatusItem["status"]

export type ConversationGitStatusResponse = InferResponseType<
  ConversationRoutes["files"]["status"]["$get"],
  200
>

/** A diff read. `gone`: the turn's snapshots are no longer in the sandbox (410). */
export type ConversationGitDiffResponse = InferResponseType<
  ConversationRoutes["files"]["diff"]["$get"],
  200
> & { gone?: boolean }

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

export type ConversationFileWriteResponse = InferResponseType<
  ConversationRoutes["files"]["blob"]["$put"],
  200
>

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
