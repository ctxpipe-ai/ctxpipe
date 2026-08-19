import type {
  ConversationDetail,
  ConversationListItem,
} from "@/features/chat/types"
import type {
  Workspace,
  WorkspaceDetail,
  WorkspaceFilesResponse,
  WorkspaceFileTreeNode,
  WorkspaceGitStatusResponse,
  WorkspaceGitTreeResponse,
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
  hydrateError: null,
  readOnlyReason: null,
  mostRecentConversationId: "conv_1",
  migrationExportSha: "abc123def456",
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
  hydrateError: null,
  activeProjectionSha: null,
  migrationExportSha: null,
  indexedSha: null,
}

export const failedHydrateWorkspace: Workspace = {
  ...hydratingWorkspace,
  id: "ws_hydrate_failed",
  slug: "knowledge-failed",
  displayName: "Knowledge",
  hydrateStatus: "failed",
  desiredSha: null,
  hydrateError: "getLogger: no logger in context.",
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

export const readOnlyWorkspaceDetail: WorkspaceDetail = {
  ...readOnlyWorkspace,
  linkedRepositories: [],
}

export const projectionLagWorkspaceDetail: WorkspaceDetail = {
  ...docsWorkspaceDetail,
  workspaceRepositoryUrl: "https://github.com/acme/docs-v2",
  activeProjectionUrl: "https://github.com/acme/docs",
  hydrateStatus: "running",
  desiredSha: "fff111aaa222",
  activeProjectionSha: "abc123def456",
}

export const emptyLinkedWorkspaceDetail: WorkspaceDetail = {
  ...docsWorkspace,
  linkedRepositories: [],
}

export const waitingForTipWorkspace: Workspace = {
  ...hydratingWorkspace,
  id: "ws_waiting_tip",
  slug: "waiting-tip",
  displayName: "Waiting tip",
  desiredSha: null,
  hydrateStatus: "pending",
  activeProjectionSha: null,
  indexedSha: null,
}

export const waitingForTipWorkspaceDetail: WorkspaceDetail = {
  ...waitingForTipWorkspace,
  linkedRepositories: [],
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
          text: "Billing lives in knowledge/billing/ledger.md. Invoices follow the org rules in that file.",
        },
      ],
      metadata: { createdAt: "2026-08-16T09:30:12.000Z" },
    },
  ],
}

export const docsWorkspaceGitBlobs: Record<string, string> = {
  "AGENTS.md":
    "# Docs workspace\n\nUse knowledge files as the source of truth for this org.",
  "README.md":
    "# Docs\n\nOrg knowledge and imported Confluence / Notion mirrors.",
  "apps/ui/package.json": '{\n  "name": "@acme/ui"\n}\n',
  "apps/ui/src/main.tsx": "export {}\n",
  "knowledge/auth/idp.md":
    "# Identity provider\n\nOrg SSO is Okta. Login and session both depend on this IdP.",
  "knowledge/auth/login.md":
    "# Login\n\nBrowser login redirects to the [identity provider](idp.md), then issues a [session](session.md).",
  "knowledge/auth/session.md":
    "# Session\n\nOrg authentication issues session cookies after IdP login. See [login](login.md).",
  "knowledge/billing/invoices.md":
    "# Invoices\n\nInvoice documents are generated from the [ledger](ledger.md).",
  "knowledge/billing/ledger.md": `# Billing ledger

Invoicing rules for the org. The payments API depends on this ledger.

See [Payments API](../payments/api.md) and [invoices](invoices.md).`,
  "knowledge/billing/tax.md":
    "# Tax\n\nVAT treatment for invoices. Applied when posting to the [ledger](ledger.md).",
  "knowledge/imported/billing.md":
    "# Billing (imported)\n\nMigrated notes from the previous knowledge store. Prefer [ledger](../billing/ledger.md).",
  "knowledge/imported/org-handbook.md":
    "# Org handbook\n\nMigrated notes from the previous knowledge store.",
  "knowledge/imported/on-call.md":
    "# On-call (imported)\n\nOlder on-call notes. Prefer the Confluence ENG on-call space.",
  "knowledge/payments/api.md": `---
claims:
  - to: ../billing/ledger.md
    predicate: DEPENDS_ON
    confidence: 0.7
---

The payments API depends on [Billing ledger](../billing/ledger.md).`,
  "knowledge/payments/refunds.md":
    "# Refunds\n\nRefunds go through the [payments API](api.md) and reverse the [ledger](../billing/ledger.md).",
  "knowledge/payments/webhooks.md":
    "# Webhooks\n\nProvider callbacks for charges and [refunds](refunds.md).",
  "confluence/ENG/on-call/index.md":
    "# On-call\n\nEngineering on-call home. Child pages cover rotation and severity.",
  "confluence/ENG/on-call/pager-rotation--111.md":
    "# Pager rotation\n\nPrimary and secondary rotation for the ENG space.",
  "confluence/ENG/on-call/severity-levels--112.md":
    "# Severity levels\n\nSEV-1 through SEV-4 for incidents.",
  "confluence/HANDBOOK/welcome--200.md":
    "# Welcome\n\nHandbook space root page for new joiners.",
  "notion/pages/engineering-wiki--page-1/index.md":
    "# Engineering wiki\n\nSynced Notion page. Child pages live alongside this index.",
  "notion/pages/engineering-wiki--page-1/auth-rfc--page-2/index.md":
    "# Auth RFC\n\nNested Notion page under the engineering wiki.",
  "notion/databases/launch-checklist--db-1/index.md":
    "# Launch checklist\n\nSynced Notion database. Rows are nested under this folder.",
  "notion/databases/launch-checklist--db-1/rows/cutover-runbook--row-1/index.md":
    "# Cutover runbook\n\nDatabase row mirrored as markdown.",
  "notion/databases/launch-checklist--db-1/rows/prepare-release--row-2/index.md":
    "# Prepare release\n\nChecklist row for the launch database.",
}

const docsKnowledgePaths = Object.keys(docsWorkspaceGitBlobs).filter((path) =>
  path.endsWith(".md"),
)

export const docsWorkspaceGitTree: WorkspaceGitTreeResponse = {
  sha: docsWorkspace.activeProjectionSha ?? "abc123def456",
  paths: Object.keys(docsWorkspaceGitBlobs).sort(),
}

export const docsWorkspaceGitStatus: WorkspaceGitStatusResponse = {
  sha: docsWorkspaceGitTree.sha,
  source: "sandbox",
  items: [
    {
      path: "knowledge/billing/ledger.md",
      status: "modified",
      body: `${docsWorkspaceGitBlobs["knowledge/billing/ledger.md"] ?? ""}\nQueued sandbox edit.\n`,
      additions: 2,
      deletions: 0,
    },
    {
      path: "AGENTS.md",
      status: "added",
      additions: 3,
      deletions: 0,
    },
    {
      path: "README.md",
      status: "modified",
      additions: 4,
      deletions: 1,
    },
  ],
}

export const docsWorkspaceFiles: WorkspaceFilesResponse =
  workspaceFilesFromBodies(
    Object.fromEntries(
      docsKnowledgePaths.map((path) => [
        path,
        docsWorkspaceGitBlobs[path] ?? "",
      ]),
    ),
  )

function workspaceFilesFromBodies(
  bodies: Record<string, string>,
): WorkspaceFilesResponse {
  const paths = Object.keys(bodies).sort()
  return {
    items: paths.map((path) => ({ path, body: bodies[path] ?? "" })),
    tree: fileTreeFromPaths(paths),
  }
}

function fileTreeFromPaths(paths: readonly string[]): WorkspaceFileTreeNode[] {
  const root: WorkspaceFileTreeNode[] = []
  for (const path of [...paths].sort()) {
    const parts = path.split("/").filter(Boolean)
    let level = root
    let prefix = ""
    for (const [index, part] of parts.entries()) {
      prefix = prefix ? `${prefix}/${part}` : part
      const existing = level.find((node) => node.name === part)
      if (existing) {
        if (index < parts.length - 1) {
          existing.children ??= []
          level = existing.children
        }
        continue
      }
      const node: WorkspaceFileTreeNode =
        index === parts.length - 1
          ? { name: part, path: prefix }
          : { name: part, path: prefix, children: [] }
      level.push(node)
      if (node.children) level = node.children
    }
  }
  return root
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
      id: "knowledge/billing/ledger.md",
      kind: "file",
      name: "ledger.md",
      summary: "Invoicing rules",
    },
    {
      id: "knowledge/auth/session.md",
      kind: "file",
      name: "session.md",
      summary: "Org auth",
    },
  ],
  edges: [
    {
      sourceId: "knowledge/billing/ledger.md",
      targetId: "knowledge/auth/session.md",
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
