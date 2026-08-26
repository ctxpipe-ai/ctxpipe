import type {
  ChatMessage,
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

export const failedHydrateWorkspaceDetail: WorkspaceDetail = {
  ...failedHydrateWorkspace,
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
      parts: [{ type: "text", content: "How is billing structured?" }],
      createdAt: new Date("2026-08-16T09:30:00.000Z"),
    },
    {
      id: "msg_assistant_1",
      role: "assistant",
      parts: [
        {
          type: "text",
          content:
            "Billing lives in knowledge/billing/ledger.md. Invoices follow the org rules in that file.",
        },
      ],
      createdAt: new Date("2026-08-16T09:30:12.000Z"),
    },
  ],
}

export const longThreadMessages: ChatMessage[] = [
  {
    id: "msg_long_u1",
    role: "user",
    parts: [{ type: "text", content: "How is billing structured?" }],
    createdAt: new Date("2026-08-16T09:30:00.000Z"),
  },
  {
    id: "msg_long_a1",
    role: "assistant",
    parts: [
      {
        type: "text",
        content:
          "Billing lives in knowledge/billing/ledger.md. Invoices follow the org rules in that file.",
      },
    ],
    createdAt: new Date("2026-08-16T09:30:12.000Z"),
  },
  {
    id: "msg_long_u2",
    role: "user",
    parts: [{ type: "text", content: "Where do refunds go?" }],
    createdAt: new Date("2026-08-16T09:31:00.000Z"),
  },
  {
    id: "msg_long_a2",
    role: "assistant",
    parts: [
      {
        type: "text",
        content:
          "Refunds go through the payments API and reverse the ledger. See knowledge/payments/refunds.md.",
      },
    ],
    createdAt: new Date("2026-08-16T09:31:18.000Z"),
  },
  {
    id: "msg_long_u3",
    role: "user",
    parts: [{ type: "text", content: "And tax?" }],
    createdAt: new Date("2026-08-16T09:32:00.000Z"),
  },
  {
    id: "msg_long_a3",
    role: "assistant",
    parts: [
      {
        type: "text",
        content:
          "VAT is applied when posting to the ledger. The tax notes live next to invoices.",
      },
    ],
    createdAt: new Date("2026-08-16T09:32:10.000Z"),
  },
]

export const markdownAnswerMessages: ChatMessage[] = [
  {
    id: "msg_md_u1",
    role: "user",
    parts: [{ type: "text", content: "Explain auth in this Workspace." }],
    createdAt: new Date("2026-08-16T09:40:00.000Z"),
  },
  {
    id: "msg_md_a1",
    role: "assistant",
    parts: [
      {
        type: "text",
        content: `# Auth

## Session cookies

Org login issues a session after the identity provider returns.

- Okta is the IdP
- Cookies are httpOnly
  - Refresh is silent
  - Expiry is 7 days

1. Redirect to Okta
2. Exchange the code
3. Set the session cookie`,
      },
    ],
    createdAt: new Date("2026-08-16T09:40:14.000Z"),
  },
]

export const codeAnswerMessages: ChatMessage[] = [
  {
    id: "msg_code_u1",
    role: "user",
    parts: [{ type: "text", content: "Show the session helper." }],
    createdAt: new Date("2026-08-16T09:41:00.000Z"),
  },
  {
    id: "msg_code_a1",
    role: "assistant",
    parts: [
      {
        type: "text",
        content: `Read the cookie prefix before you trust it.

\`\`\`ts
export function sessionFromCookie(raw: string) {
  return raw.slice(0, 8)
}
\`\`\``,
      },
    ],
    createdAt: new Date("2026-08-16T09:41:12.000Z"),
  },
]

export const reasoningMessages: ChatMessage[] = [
  {
    id: "msg_think_u1",
    role: "user",
    parts: [{ type: "text", content: "Why ledger.md and not invoices.md?" }],
    createdAt: new Date("2026-08-16T09:42:00.000Z"),
  },
  {
    id: "msg_think_a1",
    role: "assistant",
    parts: [
      {
        type: "thinking",
        content:
          "The payments API claims DEPENDS_ON ledger.md. Invoice documents are generated from that file, so they are a derived view rather than the source of truth. I should confirm by searching the billing docs and then reading the ledger itself before answering.",
      },
      {
        type: "text",
        content:
          "Use knowledge/billing/ledger.md. Invoice documents are generated from it.",
      },
    ],
    createdAt: new Date("2026-08-16T09:42:16.000Z"),
  },
]

export const streamingReasoningMessages: ChatMessage[] = [
  {
    id: "msg_think_live_u1",
    role: "user",
    parts: [{ type: "text", content: "What's in this Workspace?" }],
    createdAt: new Date("2026-08-16T09:42:20.000Z"),
  },
  {
    id: "msg_think_live_a1",
    role: "assistant",
    parts: [
      {
        type: "thinking",
        content:
          "I'll inspect the repository structure and its primary project metadata.",
      },
    ],
    createdAt: new Date("2026-08-16T09:42:21.000Z"),
  },
]

export const oneToolMessages: ChatMessage[] = [
  {
    id: "msg_tool_u1",
    role: "user",
    parts: [{ type: "text", content: "Where is login documented?" }],
    createdAt: new Date("2026-08-16T09:44:00.000Z"),
  },
  {
    id: "msg_tool_a1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "tc_hybrid_1",
        name: "hybrid_search",
        input: { query: "where is login documented" },
      },
      {
        type: "text",
        content: "Login lives in knowledge/auth/login.md.",
      },
    ],
    createdAt: new Date("2026-08-16T09:44:08.000Z"),
  },
]

export const manyToolMessages: ChatMessage[] = [
  {
    id: "msg_tools_u1",
    role: "user",
    parts: [{ type: "text", content: "How does billing work?" }],
    createdAt: new Date("2026-08-16T09:45:00.000Z"),
  },
  {
    id: "msg_tools_a1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "tc_1",
        name: "hybrid_search",
        input: { query: "billing ledger" },
      },
      {
        type: "tool-call",
        id: "tc_2",
        name: "get_file",
        input: { filePath: "knowledge/billing/ledger.md" },
      },
      {
        type: "tool-call",
        id: "tc_3",
        name: "glob_files",
        input: { pattern: "knowledge/billing/**/*.md" },
      },
      {
        type: "text",
        content: "Billing is defined by knowledge/billing/ledger.md.",
      },
    ],
    createdAt: new Date("2026-08-16T09:45:12.000Z"),
  },
]

export const streamingToolMessages: ChatMessage[] = [
  {
    id: "msg_tools_live_u1",
    role: "user",
    parts: [{ type: "text", content: "Summarize the repo." }],
    createdAt: new Date("2026-08-16T09:46:00.000Z"),
  },
  {
    id: "msg_tools_live_a1",
    role: "assistant",
    parts: [
      {
        type: "tool-call",
        id: "tc_live_1",
        name: "hybrid_search",
        input: { query: "summarize the repo" },
      },
      {
        type: "tool-call",
        id: "tc_live_2",
        name: "get_file",
        input: { filePath: "README.md" },
      },
    ],
    createdAt: new Date("2026-08-16T09:46:02.000Z"),
  },
]

export const reasoningAndToolsMessages: ChatMessage[] = [
  {
    id: "msg_all_u1",
    role: "user",
    parts: [{ type: "text", content: "Why ledger.md and not invoices.md?" }],
    createdAt: new Date("2026-08-16T09:47:00.000Z"),
  },
  {
    id: "msg_all_a1",
    role: "assistant",
    parts: [
      {
        type: "thinking",
        content:
          "The payments API claims DEPENDS_ON ledger.md. Invoice documents are generated from that file, so they are a derived view rather than the source of truth. I should confirm by searching the billing docs and then reading the ledger itself before answering.",
      },
      {
        type: "tool-call",
        id: "tc_all_1",
        name: "hybrid_search",
        input: { query: "ledger vs invoices" },
      },
      {
        type: "tool-call",
        id: "tc_all_2",
        name: "get_file",
        input: { filePath: "knowledge/billing/ledger.md" },
      },
      {
        type: "tool-call",
        id: "tc_all_3",
        name: "glob_files",
        input: { pattern: "knowledge/billing/**/*.md" },
      },
      {
        type: "text",
        content:
          "Use knowledge/billing/ledger.md. Invoice documents are generated from it.",
      },
      {
        type: "source-url",
        url: "https://github.com/acme/docs/blob/main/knowledge/billing/ledger.md",
        title: "knowledge/billing/ledger.md",
      },
    ],
    createdAt: new Date("2026-08-16T09:47:16.000Z"),
  },
]

export const streamingReasoningAndToolsMessages: ChatMessage[] = [
  {
    id: "msg_all_live_u1",
    role: "user",
    parts: [{ type: "text", content: "Why ledger.md and not invoices.md?" }],
    createdAt: new Date("2026-08-16T09:47:20.000Z"),
  },
  {
    id: "msg_all_live_a1",
    role: "assistant",
    parts: [
      {
        type: "thinking",
        content:
          "The payments API claims DEPENDS_ON ledger.md. Invoice documents are generated from that file, so they are a derived view. Searching billing docs next.",
      },
      {
        type: "tool-call",
        id: "tc_all_live_1",
        name: "hybrid_search",
        input: { query: "ledger vs invoices" },
      },
      {
        type: "tool-call",
        id: "tc_all_live_2",
        name: "get_file",
        input: { filePath: "knowledge/billing/ledger.md" },
      },
    ],
    createdAt: new Date("2026-08-16T09:47:21.000Z"),
  },
]

export const sourceLinkMessages: ChatMessage[] = [
  {
    id: "msg_src_u1",
    role: "user",
    parts: [{ type: "text", content: "Where is the payments API?" }],
    createdAt: new Date("2026-08-16T09:43:00.000Z"),
  },
  {
    id: "msg_src_a1",
    role: "assistant",
    parts: [
      {
        type: "text",
        content:
          "The payments API lives in knowledge/payments/api.md and depends on the billing ledger.",
      },
      {
        type: "source-url",
        url: "https://github.com/acme/docs/blob/main/knowledge/payments/api.md",
        title: "knowledge/payments/api.md",
      },
    ],
    createdAt: new Date("2026-08-16T09:43:10.000Z"),
  },
]

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
  "knowledge/org/handbook.md":
    "# Org handbook\n\nOrg-wide notes. Billing rules live in the [ledger](../billing/ledger.md).",
  "knowledge/ops/on-call.md":
    "# On-call\n\nOlder on-call notes. Prefer the Confluence ENG on-call space.",
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
    totalNodes: 28,
    totalEdges: 42,
    lastUpdatedAt: "2026-08-16T10:00:00.000Z",
    nodesReturned: 28,
    edgesReturned: 42,
    truncated: false,
  },
  nodes: [
    {
      id: "knowledge/billing/ledger.md",
      kind: "KnowledgeUnit",
      name: "ledger",
      summary: "Invoicing rules and payment state",
    },
    {
      id: "knowledge/billing/invoices.md",
      kind: "KnowledgeUnit",
      name: "invoices",
      summary: "Invoice lifecycle and reminders",
    },
    {
      id: "knowledge/billing/tax.md",
      kind: "KnowledgeUnit",
      name: "tax",
      summary: "VAT and regional tax mapping",
    },
    {
      id: "knowledge/auth/session.md",
      kind: "KnowledgeUnit",
      name: "session",
      summary: "Org session and cookie policy",
    },
    {
      id: "knowledge/auth/members.md",
      kind: "KnowledgeUnit",
      name: "members",
      summary: "Roles, invites, and seats",
    },
    {
      id: "knowledge/auth/sso.md",
      kind: "Capability",
      name: "SSO",
      summary: "SAML and OIDC sign-in",
    },
    {
      id: "knowledge/search/index.md",
      kind: "KnowledgeUnit",
      name: "search index",
      summary: "Zoekt projection of the workspace tree",
    },
    {
      id: "knowledge/search/query.md",
      kind: "Capability",
      name: "query",
      summary: "Workspace-scoped retrieval",
    },
    {
      id: "knowledge/search/ranking.md",
      kind: "Pattern",
      name: "ranking",
      summary: "Decay then damped combine",
    },
    {
      id: "knowledge/connectors/github.md",
      kind: "Integration",
      name: "GitHub",
      summary: "Workspace repository select and create",
    },
    {
      id: "knowledge/connectors/notion.md",
      kind: "Integration",
      name: "Notion",
      summary: "Git-native page mirror",
    },
    {
      id: "knowledge/connectors/linear.md",
      kind: "Integration",
      name: "Linear",
      summary: "Issue mirror into knowledge/",
    },
    {
      id: "knowledge/chat/composer.md",
      kind: "KnowledgeUnit",
      name: "composer",
      summary: "Floating conversation input",
    },
    {
      id: "knowledge/chat/sandbox.md",
      kind: "Service",
      name: "sandbox",
      summary: "TanStack withSandbox isolation",
    },
    {
      id: "knowledge/chat/tools.md",
      kind: "KnowledgeUnit",
      name: "chat tools",
      summary: "Backend-bridged retrieval tools",
    },
    {
      id: "knowledge/hydrate/projection.md",
      kind: "Capability",
      name: "projection",
      summary: "Read-only hydrate into Postgres and FalkorDB",
    },
    {
      id: "knowledge/hydrate/claims.md",
      kind: "KnowledgeUnit",
      name: "claims",
      summary: "Layer-2 relations from front matter",
    },
    {
      id: "knowledge/hydrate/git.md",
      kind: "Pattern",
      name: "git canonical",
      summary: "Files are identity; hydrate does not write git",
    },
    {
      id: "knowledge/settings/workspace.md",
      kind: "KnowledgeUnit",
      name: "workspace settings",
      summary: "Display name, slug, and remotes",
    },
    {
      id: "knowledge/settings/slug.md",
      kind: "KnowledgeUnit",
      name: "slug",
      summary: "Org-unique URL segment",
    },
    {
      id: "knowledge/scratch/orphan.md",
      kind: "KnowledgeUnit",
      name: "orphan",
      summary: "Imported note with no claims yet",
    },
    {
      id: "knowledge/platform/api.md",
      kind: "Service",
      name: "public API",
      summary: "Hono RPC for the Operate app",
    },
    {
      id: "knowledge/platform/worker.md",
      kind: "Service",
      name: "ingest worker",
      summary: "Jobs that write the workspace repository",
    },
    {
      id: "knowledge/platform/postgres.md",
      kind: "Technology",
      name: "Postgres",
      summary: "Canonical objects and conversations",
    },
    {
      id: "knowledge/platform/falkordb.md",
      kind: "Technology",
      name: "FalkorDB",
      summary: "Derived graph for traversal",
    },
    {
      id: "knowledge/platform/embeddings.md",
      kind: "Technology",
      name: "embeddings",
      summary: "Vector index for hybrid recall",
    },
    {
      id: "knowledge/platform/codesearch.md",
      kind: "Service",
      name: "codesearch",
      summary: "Zoekt plus SCIP over linked remotes",
    },
    {
      id: "knowledge/ops/jobs.md",
      kind: "Pattern",
      name: "jobs",
      summary: "One commit per job on the default branch",
    },
  ],
  edges: [
    {
      sourceId: "knowledge/billing/ledger.md",
      targetId: "knowledge/auth/session.md",
      predicate: "depends_on",
      lastObservedAt: "2026-08-16T10:00:00.000Z",
      confidence: 0.82,
    },
    {
      sourceId: "knowledge/billing/ledger.md",
      targetId: "knowledge/billing/invoices.md",
      predicate: "describes",
      lastObservedAt: "2026-08-12T09:00:00.000Z",
      confidence: 0.91,
    },
    {
      sourceId: "knowledge/billing/invoices.md",
      targetId: "knowledge/billing/tax.md",
      predicate: "uses",
      lastObservedAt: "2026-07-28T14:00:00.000Z",
      confidence: 0.74,
    },
    {
      sourceId: "knowledge/billing/ledger.md",
      targetId: "knowledge/platform/postgres.md",
      predicate: "stores_in",
      lastObservedAt: "2026-08-01T11:30:00.000Z",
      confidence: 0.88,
    },
    {
      sourceId: "knowledge/auth/session.md",
      targetId: "knowledge/auth/members.md",
      predicate: "depends_on",
      lastObservedAt: "2026-08-10T08:15:00.000Z",
      confidence: 0.86,
    },
    {
      sourceId: "knowledge/auth/members.md",
      targetId: "knowledge/auth/sso.md",
      predicate: "uses",
      lastObservedAt: "2026-06-18T16:00:00.000Z",
      confidence: 0.79,
    },
    {
      sourceId: "knowledge/auth/sso.md",
      targetId: "knowledge/connectors/github.md",
      predicate: "integrates_with",
      lastObservedAt: "2026-05-22T12:00:00.000Z",
      confidence: 0.61,
    },
    {
      sourceId: "knowledge/auth/session.md",
      targetId: "knowledge/platform/api.md",
      predicate: "exposed_by",
      lastObservedAt: "2026-08-14T17:40:00.000Z",
      confidence: 0.9,
    },
    {
      sourceId: "knowledge/search/query.md",
      targetId: "knowledge/search/index.md",
      predicate: "reads",
      lastObservedAt: "2026-08-15T09:20:00.000Z",
      confidence: 0.93,
    },
    {
      sourceId: "knowledge/search/query.md",
      targetId: "knowledge/search/ranking.md",
      predicate: "uses",
      lastObservedAt: "2026-07-02T10:00:00.000Z",
      confidence: 0.84,
    },
    {
      sourceId: "knowledge/search/index.md",
      targetId: "knowledge/platform/codesearch.md",
      predicate: "served_by",
      lastObservedAt: "2026-08-08T13:00:00.000Z",
      confidence: 0.87,
    },
    {
      sourceId: "knowledge/search/ranking.md",
      targetId: "knowledge/hydrate/claims.md",
      predicate: "ranks",
      lastObservedAt: "2026-04-11T08:00:00.000Z",
      confidence: 0.7,
    },
    {
      sourceId: "knowledge/connectors/github.md",
      targetId: "knowledge/hydrate/git.md",
      predicate: "writes",
      lastObservedAt: "2026-08-13T15:10:00.000Z",
      confidence: 0.89,
    },
    {
      sourceId: "knowledge/connectors/notion.md",
      targetId: "knowledge/hydrate/git.md",
      predicate: "mirrors_into",
      lastObservedAt: "2026-07-19T11:00:00.000Z",
      confidence: 0.77,
    },
    {
      sourceId: "knowledge/connectors/linear.md",
      targetId: "knowledge/hydrate/git.md",
      predicate: "mirrors_into",
      lastObservedAt: "2026-07-21T11:00:00.000Z",
      confidence: 0.76,
    },
    {
      sourceId: "knowledge/connectors/github.md",
      targetId: "knowledge/settings/workspace.md",
      predicate: "configured_in",
      lastObservedAt: "2026-08-09T07:45:00.000Z",
      confidence: 0.8,
    },
    {
      sourceId: "knowledge/chat/composer.md",
      targetId: "knowledge/chat/sandbox.md",
      predicate: "runs_in",
      lastObservedAt: "2026-08-16T08:00:00.000Z",
      confidence: 0.92,
    },
    {
      sourceId: "knowledge/chat/sandbox.md",
      targetId: "knowledge/chat/tools.md",
      predicate: "exposes",
      lastObservedAt: "2026-08-11T19:00:00.000Z",
      confidence: 0.85,
    },
    {
      sourceId: "knowledge/chat/tools.md",
      targetId: "knowledge/search/query.md",
      predicate: "calls",
      lastObservedAt: "2026-08-05T12:30:00.000Z",
      confidence: 0.81,
    },
    {
      sourceId: "knowledge/chat/tools.md",
      targetId: "knowledge/hydrate/projection.md",
      predicate: "reads",
      lastObservedAt: "2026-06-29T09:00:00.000Z",
      confidence: 0.73,
    },
    {
      sourceId: "knowledge/hydrate/projection.md",
      targetId: "knowledge/hydrate/claims.md",
      predicate: "projects",
      lastObservedAt: "2026-08-07T06:20:00.000Z",
      confidence: 0.94,
    },
    {
      sourceId: "knowledge/hydrate/projection.md",
      targetId: "knowledge/hydrate/git.md",
      predicate: "reads",
      lastObservedAt: "2026-08-07T06:21:00.000Z",
      confidence: 0.95,
    },
    {
      sourceId: "knowledge/hydrate/projection.md",
      targetId: "knowledge/platform/falkordb.md",
      predicate: "writes",
      lastObservedAt: "2026-08-07T06:22:00.000Z",
      confidence: 0.9,
    },
    {
      sourceId: "knowledge/hydrate/projection.md",
      targetId: "knowledge/platform/postgres.md",
      predicate: "writes",
      lastObservedAt: "2026-08-07T06:23:00.000Z",
      confidence: 0.9,
    },
    {
      sourceId: "knowledge/hydrate/projection.md",
      targetId: "knowledge/platform/embeddings.md",
      predicate: "writes",
      lastObservedAt: "2026-03-14T10:00:00.000Z",
      confidence: 0.68,
    },
    {
      sourceId: "knowledge/hydrate/claims.md",
      targetId: "knowledge/billing/ledger.md",
      predicate: "includes",
      lastObservedAt: "2026-08-02T14:00:00.000Z",
      confidence: 0.66,
    },
    {
      sourceId: "knowledge/hydrate/claims.md",
      targetId: "knowledge/auth/session.md",
      predicate: "includes",
      lastObservedAt: "2026-08-02T14:01:00.000Z",
      confidence: 0.64,
    },
    {
      sourceId: "knowledge/settings/workspace.md",
      targetId: "knowledge/settings/slug.md",
      predicate: "defines",
      lastObservedAt: "2026-08-04T10:10:00.000Z",
      confidence: 0.83,
    },
    {
      sourceId: "knowledge/settings/workspace.md",
      targetId: "knowledge/connectors/github.md",
      predicate: "links",
      lastObservedAt: "2026-08-04T10:11:00.000Z",
      confidence: 0.78,
    },
    {
      sourceId: "knowledge/platform/api.md",
      targetId: "knowledge/platform/postgres.md",
      predicate: "stores_in",
      lastObservedAt: "2026-07-30T18:00:00.000Z",
      confidence: 0.88,
    },
    {
      sourceId: "knowledge/platform/api.md",
      targetId: "knowledge/auth/session.md",
      predicate: "authenticates_with",
      lastObservedAt: "2026-07-15T09:00:00.000Z",
      confidence: 0.8,
    },
    {
      sourceId: "knowledge/platform/worker.md",
      targetId: "knowledge/ops/jobs.md",
      predicate: "follows",
      lastObservedAt: "2026-08-06T21:00:00.000Z",
      confidence: 0.86,
    },
    {
      sourceId: "knowledge/platform/worker.md",
      targetId: "knowledge/hydrate/git.md",
      predicate: "commits_to",
      lastObservedAt: "2026-08-06T21:05:00.000Z",
      confidence: 0.91,
    },
    {
      sourceId: "knowledge/ops/jobs.md",
      targetId: "knowledge/hydrate/projection.md",
      predicate: "enqueues",
      lastObservedAt: "2026-08-06T21:10:00.000Z",
      confidence: 0.75,
    },
    {
      sourceId: "knowledge/platform/codesearch.md",
      targetId: "knowledge/connectors/github.md",
      predicate: "indexes",
      lastObservedAt: "2026-05-03T08:00:00.000Z",
      confidence: 0.72,
    },
    {
      sourceId: "knowledge/platform/embeddings.md",
      targetId: "knowledge/search/query.md",
      predicate: "feeds",
      lastObservedAt: "2026-02-20T12:00:00.000Z",
      confidence: 0.58,
    },
    {
      sourceId: "knowledge/chat/composer.md",
      targetId: "knowledge/billing/invoices.md",
      predicate: "mentions",
      lastObservedAt: "2026-01-18T16:40:00.000Z",
      confidence: 0.41,
    },
    {
      sourceId: "knowledge/search/query.md",
      targetId: "knowledge/platform/api.md",
      predicate: "exposed_by",
      lastObservedAt: "2026-08-15T09:25:00.000Z",
      confidence: 0.87,
    },
    {
      sourceId: "knowledge/platform/falkordb.md",
      targetId: "knowledge/search/query.md",
      predicate: "serves",
      lastObservedAt: "2026-06-01T07:00:00.000Z",
      confidence: 0.69,
    },
    {
      sourceId: "knowledge/billing/tax.md",
      targetId: "knowledge/settings/workspace.md",
      predicate: "scoped_to",
      lastObservedAt: "2026-04-27T13:20:00.000Z",
      confidence: 0.52,
    },
    {
      sourceId: "knowledge/auth/members.md",
      targetId: "knowledge/settings/workspace.md",
      predicate: "administered_in",
      lastObservedAt: "2026-08-03T11:00:00.000Z",
      confidence: 0.71,
    },
    {
      sourceId: "knowledge/platform/worker.md",
      targetId: "knowledge/platform/postgres.md",
      predicate: "stores_in",
      lastObservedAt: "2026-07-08T04:00:00.000Z",
      confidence: 0.77,
    },
  ],
}

export const eligibleGithubRepos = [
  {
    id: 1,
    name: "handbook",
    full_name: "acme/handbook",
    html_url: "https://github.com/acme/handbook",
    clone_url: "https://github.com/acme/handbook.git",
  },
  {
    id: 2,
    name: "web",
    full_name: "acme/web",
    html_url: "https://github.com/acme/web",
    clone_url: "https://github.com/acme/web.git",
  },
]
