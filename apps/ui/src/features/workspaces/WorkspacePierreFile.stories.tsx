import type { Meta, StoryObj } from "@storybook/react-vite"
import { WorkspacePierreFile } from "./WorkspacePierreFile"
import { docsWorkspaceGitBlobs } from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/FilePreview",
  component: WorkspacePierreFile,
  decorators: [
    (Story) => (
      <div className="flex h-96 w-[36rem] flex-col overflow-hidden bg-card">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "centered" },
  args: {
    path: "knowledge/billing/ledger.md",
    body: docsWorkspaceGitBlobs["knowledge/billing/ledger.md"] ?? "",
    cacheKey: "story:knowledge/billing/ledger.md",
  },
} satisfies Meta<typeof WorkspacePierreFile>

export default meta

type Story = StoryObj<typeof meta>

export const Markdown: Story = {}

export const TypeScript: Story = {
  args: {
    path: "apps/ui/src/main.tsx",
    body: 'export function boot() {\n  return "ok"\n}\n',
    cacheKey: "story:apps/ui/src/main.tsx",
  },
}

export const DiffVsHead: Story = {
  args: {
    path: "knowledge/billing/ledger.md",
    body: `${docsWorkspaceGitBlobs["knowledge/billing/ledger.md"] ?? ""}\nLocal edit.\n`,
    oldBody: docsWorkspaceGitBlobs["knowledge/billing/ledger.md"] ?? "",
    cacheKey: "story:diff:knowledge/billing/ledger.md",
  },
}

export const Editable: Story = {
  args: {
    path: "AGENTS.md",
    body: docsWorkspaceGitBlobs["AGENTS.md"] ?? "",
    cacheKey: "story:edit:AGENTS.md",
    editable: true,
  },
}
