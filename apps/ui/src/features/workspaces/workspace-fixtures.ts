import type {
  ConversationDetail,
  ConversationListItem,
} from "@/features/chat/types"
import type {
  Workspace,
  WorkspaceDetail,
  WorkspaceFilesResponse,
  WorkspaceGraphPayload,
} from "./types"

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

export const hydratingWorkspaceDetail: WorkspaceDetail = {
  ...hydratingWorkspace,
  linkedRepositories: [],
}

export const docsConversationListItem: ConversationListItem = {
  id: "conv_1",
  name: "Repo layout",
  source: "ui",
  lastMessageAt: "2026-08-16T10:00:00.000Z",
}

export const docsConversations: ConversationListItem[] = [
  docsConversationListItem,
  {
    id: "conv_2",
    name: "Auth claims",
    source: "ui",
    lastMessageAt: "2026-08-16T09:12:00.000Z",
  },
]

export const docsConversationDetail: ConversationDetail = {
  conversation: {
    ...docsConversationListItem,
    orgId: "org_acme",
    userId: "user_storybook",
    workspaceId: docsWorkspace.id,
    createdAt: "2026-08-16T09:30:00.000Z",
    updatedAt: "2026-08-16T10:00:00.000Z",
  },
  messages: [
    {
      id: "msg_user_1",
      role: "user",
      parts: [{ type: "text", text: "How is billing structured?" }],
      metadata: { createdAt: "2026-08-16T09:30:00.000Z" },
    },
    {
      id: "msg_assistant_1",
      role: "assistant",
      parts: [
        {
          type: "text",
          text: "Billing lives in knowledge/billing.md. Invoices follow the org rules in that file.",
        },
      ],
      metadata: { createdAt: "2026-08-16T09:30:12.000Z" },
    },
  ],
}

export const docsWorkspaceFiles: WorkspaceFilesResponse = {
  items: [
    {
      path: "knowledge/billing.md",
      body: "# Billing\n\nInvoicing rules for the org.",
    },
    {
      path: "knowledge/auth.md",
      body: "# Auth\n\nOrg authentication.",
    },
  ],
  tree: [
    {
      name: "knowledge",
      path: "knowledge",
      children: [
        { name: "billing.md", path: "knowledge/billing.md" },
        { name: "auth.md", path: "knowledge/auth.md" },
      ],
    },
  ],
}

export const docsWorkspaceGraph: WorkspaceGraphPayload = {
  metrics: {
    totalNodes: 2,
    totalEdges: 1,
    lastUpdatedAt: "2026-08-16T10:00:00.000Z",
    nodesReturned: 2,
    edgesReturned: 1,
    truncated: false,
  },
  nodes: [
    {
      id: "knowledge/billing.md",
      kind: "file",
      name: "billing.md",
      summary: "Invoicing rules",
    },
    {
      id: "knowledge/auth.md",
      kind: "file",
      name: "auth.md",
      summary: "Org auth",
    },
  ],
  edges: [
    {
      sourceId: "knowledge/billing.md",
      targetId: "knowledge/auth.md",
      predicate: "depends_on",
      lastObservedAt: "2026-08-16T10:00:00.000Z",
      confidence: 0.8,
    },
  ],
}

export const eligibleGithubRepos = [
  {
    name: "acme/handbook",
    clone_url: "https://github.com/acme/handbook.git",
  },
  {
    name: "acme/web",
    clone_url: "https://github.com/acme/web.git",
  },
]
