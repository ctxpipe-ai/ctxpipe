import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { docsWorkspaceGitBlobs } from "./workspace-fixtures"
import { WorkspacePierreFile } from "./WorkspacePierreFile"

function findInShadows(root: ParentNode, selector: string): Element | null {
  const direct = root.querySelector(selector)
  if (direct) return direct
  for (const element of root.querySelectorAll("*")) {
    if (!element.shadowRoot) continue
    const nested = findInShadows(element.shadowRoot, selector)
    if (nested) return nested
  }
  return null
}

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

const longLine =
  "A single row that is wider than the preview so the horizontal scrollbar sits on the pane, not under the last line of text. "

export const ShortFile: Story = {
  args: {
    path: "apps/ui/src/main.tsx",
    body: 'export function boot() {\n  return "ok"\n}\n',
    cacheKey: "story:short:apps/ui/src/main.tsx",
  },
}

export const LongFile: Story = {
  args: {
    path: "knowledge/handbook.md",
    body: [
      "# Handbook",
      "",
      ...Array.from({ length: 80 }, (_, index) => `Line ${index + 1}.`),
      longLine.repeat(12).trimEnd(),
    ].join("\n"),
    cacheKey: "story:long:knowledge/handbook.md",
  },
}

const draftHead = docsWorkspaceGitBlobs["AGENTS.md"] ?? ""

/** A draft from an earlier visit; the buttons save it or put it back. */
function DraftThenNoChange() {
  const [file, setFile] = useState({
    body: `${draftHead}\nDraft line.\n`,
    oldBody: draftHead,
  })
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex gap-2 p-2">
        <button
          type="button"
          onClick={() => setFile((old) => ({ ...old, oldBody: old.body }))}
        >
          Save draft
        </button>
        <button
          type="button"
          onClick={() => setFile((old) => ({ ...old, body: old.oldBody }))}
        >
          Revert draft
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <WorkspacePierreFile
          path="AGENTS.md"
          body={file.body}
          oldBody={file.oldBody}
          cacheKey="story:draft:AGENTS.md"
          editable
        />
      </div>
    </div>
  )
}

async function expectView(canvasElement: HTMLElement, view: "diff" | "file") {
  await waitFor(() => {
    expect(Boolean(findInShadows(canvasElement, "[data-diff]"))).toBe(
      view === "diff",
    )
    expect(Boolean(findInShadows(canvasElement, "[data-file]"))).toBe(
      view === "file",
    )
  })
}

/** A draft opens as a diff; with no change left, it is a plain file again. */
export const DraftSavedShowsFile: Story = {
  parameters: {
    intent:
      "Catches a saved draft that stays in the diff view. After Save draft, the file view must show. Not for reverted drafts.",
  },
  tags: ["workspace-golden"],
  render: () => <DraftThenNoChange />,
  play: async ({ canvasElement }) => {
    await expectView(canvasElement, "diff")
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Save draft" }),
    )
    await expectView(canvasElement, "file")
  },
}

export const DraftRevertedShowsFile: Story = {
  parameters: {
    intent:
      "Catches a reverted draft that stays in the diff view. After Revert draft, the file view must show. Not for saved drafts.",
  },
  tags: ["workspace-golden"],
  render: () => <DraftThenNoChange />,
  play: async ({ canvasElement }) => {
    await expectView(canvasElement, "diff")
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Revert draft" }),
    )
    await expectView(canvasElement, "file")
  },
}
