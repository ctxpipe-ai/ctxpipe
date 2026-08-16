import type { Workspace, WorkspaceDetail } from "./types"

export const docsWorkspace: Workspace = {
  id: "ws_docs",
  orgId: "org_acme",
  slug: "docs",
  displayName: "Docs",
  workspaceRepositoryUrl: "https://github.com/acme/docs",
  githubConnectionId: "con_1",
  desiredGeneration: 1,
  desiredSha: "abc123def456",
  activeProjectionUrl: "https://github.com/acme/docs",
  activeProjectionSha: "abc123def456",
  indexedSha: "abc123def456",
  writeStatus: "writable",
  hydrateStatus: "ready",
  readOnlyReason: null,
  mostRecentConversationId: "conv_1",
  createdAt: "2026-08-16T09:00:00.000Z",
  updatedAt: "2026-08-16T10:00:00.000Z",
}

export const readOnlyWorkspace: Workspace = {
  ...docsWorkspace,
  id: "ws_readonly",
  slug: "handbook",
  displayName: "Handbook",
  writeStatus: "read_only",
  readOnlyReason: "The GitHub App cannot write to this repository.",
}

export const hydratingWorkspace: Workspace = {
  ...docsWorkspace,
  id: "ws_hydrate",
  slug: "knowledge",
  displayName: "Knowledge",
  hydrateStatus: "running",
  activeProjectionSha: null,
  indexedSha: null,
}

export const docsWorkspaceDetail: WorkspaceDetail = {
  ...docsWorkspace,
  linkedRepositories: [
    {
      id: "wlr_1",
      workspaceId: docsWorkspace.id,
      gitUrl: "https://github.com/acme/app",
      desiredRef: "main",
      desiredSha: "def",
      indexedSha: "def",
      createdAt: "2026-08-16T09:00:00.000Z",
    },
  ],
}
