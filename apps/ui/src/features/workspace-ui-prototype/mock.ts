export type VariantKey = "A" | "B" | "C"
export type SceneKey =
  | "populated"
  | "one-ws"
  | "empty-org"
  | "empty-ws"
  | "readonly"
export type RightTab = "files" | "graph" | "settings" | "changes"

export type Conversation = {
  id: string
  name: string
  lastBranch: string
}

export type Workspace = {
  id: string
  name: string
  repo: string
  readonly: boolean
  readonlyReason: string | null
  conversations: Conversation[]
  linkedRepos: string[]
}

export type PaneTab =
  | { type: "files" }
  | { type: "graph" }
  | { type: "settings" }
  | { type: "file"; path: string }

export type KnowledgeFile = {
  path: string
  title: string
  body: string
}

export const VARIANT_NAMES: Record<VariantKey, string> = {
  A: "Chosen chrome",
  B: "Work queue",
  C: "Single workspace",
}

export const SCENE_NAMES: Record<SceneKey, string> = {
  populated: "Populated",
  "one-ws": "One workspace",
  "empty-org": "No workspaces",
  "empty-ws": "Empty workspace",
  readonly: "Read-only",
}

export const KNOWLEDGE_FILES: KnowledgeFile[] = [
  {
    path: "AGENTS.md",
    title: "AGENTS.md",
    body: "---\nname: Platform context\n---\n\n## Folder structure\n- `knowledge/` — extracted units\n- `repositories/` — linked remotes",
  },
  {
    path: "knowledge/hydrate/cas.md",
    title: "Hydrate CAS",
    body: "Hydrate rebuilds the projection from a workspace-repository SHA. It never writes git.",
  },
  {
    path: "knowledge/chat/brokered-pr.md",
    title: "Brokered PR",
    body: "Chat may open a branch + PR. Only jobs push the default branch.",
  },
  {
    path: "repositories/backend.md",
    title: "backend",
    body: "---\ngit: https://github.com/acme/backend\nbranch: main\n---\n\nAPI and workers.",
  },
]

export function seedWorkspaces(scene: SceneKey): Workspace[] {
  if (scene === "empty-org") return []
  const billing: Workspace = {
    id: "ws_billing",
    name: "Billing knowledge",
    repo: "acme/billing-context",
    readonly: false,
    readonlyReason: null,
    linkedRepos: ["acme/billing-api"],
    conversations: [
      {
        id: "conv_invoice",
        name: "How are invoices mirrored?",
        lastBranch: "main",
      },
    ],
  }
  const onboarding: Workspace = {
    id: "ws_onboarding",
    name: "Onboarding docs",
    repo: "acme/onboarding-context",
    readonly: false,
    readonlyReason: null,
    linkedRepos: [],
    conversations: [],
  }
  const platform: Workspace = {
    id: "ws_platform",
    name: "Platform context",
    repo: "acme/platform-context",
    readonly: scene === "readonly",
    readonlyReason:
      scene === "readonly"
        ? "GitHub App cannot push: Contents:write missing on acme/platform-context"
        : null,
    linkedRepos: ["acme/backend", "acme/ui"],
    conversations:
      scene === "empty-ws"
        ? []
        : [
            {
              id: "conv_hydrate",
              name: "How do we hydrate from git?",
              lastBranch: "ctxpipe/chat/conv_hydrate/1",
            },
            {
              id: "conv_relink",
              name: "Relink without a merge",
              lastBranch: "main",
            },
            {
              id: "conv_jobs",
              name: "One job kind per concern",
              lastBranch: "main",
            },
            {
              id: "conv_readonly",
              name: "Read-only workspace chrome",
              lastBranch: "main",
            },
            {
              id: "conv_search",
              name: "Workspace-scoped search",
              lastBranch: "main",
            },
            {
              id: "conv_old",
              name: "Older thread about claims",
              lastBranch: "main",
            },
            {
              id: "conv_bootstrap",
              name: "Bootstrap AGENTS.md only",
              lastBranch: "main",
            },
            {
              id: "conv_cas",
              name: "Hydrate CAS on rewind",
              lastBranch: "main",
            },
            {
              id: "conv_pr",
              name: "Brokered branch and PR",
              lastBranch: "main",
            },
            {
              id: "conv_idle",
              name: "Chat idle and last branch",
              lastBranch: "main",
            },
            {
              id: "conv_link",
              name: "Link another workspace URL",
              lastBranch: "main",
            },
            {
              id: "conv_name",
              name: "Conversation name as the label",
              lastBranch: "main",
            },
          ],
  }
  if (scene === "one-ws") return [platform]
  return [platform, billing, onboarding]
}

export const CHAT_TURNS: Array<{ role: "user" | "assistant"; text: string }> = [
  {
    role: "user",
    text: "How do we hydrate from git?",
  },
  {
    role: "assistant",
    text: "Hydrate rebuilds the projection from the workspace-repository SHA. It does not edit git. Jobs are the writers.",
  },
  {
    role: "user",
    text: "Open a PR that documents that in knowledge/hydrate/cas.md",
  },
  {
    role: "assistant",
    text: "I can draft the file in this sandbox. Publishing is a brokered branch + PR — I will not push the default branch.",
  },
]
