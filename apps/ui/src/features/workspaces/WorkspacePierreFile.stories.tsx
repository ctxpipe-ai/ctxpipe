import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import preview from "../../../.storybook/preview"
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

const meta = preview.meta({
  title: "Components/Workspaces/FilePreview",
  component: WorkspacePierreFile,
  decorators: [
    (Story) => (
      <div className="flex h-96 w-[36rem] flex-col overflow-hidden bg-card">
        <Story />
      </div>
    ),
  ],
  parameters: { review: { kind: "component" }, layout: "centered" },
  args: {
    path: "knowledge/billing/ledger.md",
    body: docsWorkspaceGitBlobs["knowledge/billing/ledger.md"] ?? "",
    cacheKey: "story:knowledge/billing/ledger.md",
  },
})

/**
 * File preview of a Workspace, where a member reads a file: a Markdown file.
 */
export const Markdown = meta.story()

/**
 * File preview of a Workspace, where a member reads a file: a short TypeScript
 * file with syntax colors.
 */
export const TypeScript = meta.story({
  args: {
    path: "apps/ui/src/main.tsx",
    body: 'export function boot() {\n  return "ok"\n}\n',
    cacheKey: "story:apps/ui/src/main.tsx",
  },
})

/**
 * File preview of a Workspace, where a member reads a file: a local edit shows
 * as a diff against the head version.
 */
export const DiffVsHead = meta.story({
  parameters: {
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
  },
  args: {
    path: "knowledge/billing/ledger.md",
    body: `${docsWorkspaceGitBlobs["knowledge/billing/ledger.md"] ?? ""}\nLocal edit.\n`,
    oldBody: docsWorkspaceGitBlobs["knowledge/billing/ledger.md"] ?? "",
    cacheKey: "story:diff:knowledge/billing/ledger.md",
  },
})

/**
 * File preview of a Workspace, where a member reads and edits a file: the
 * member opened a short Markdown file that the conversation can change, so it
 * opens in the editor.
 */
export const Editable = meta.story({
  args: {
    path: "AGENTS.md",
    body: docsWorkspaceGitBlobs["AGENTS.md"] ?? "",
    cacheKey: "story:edit:AGENTS.md",
    editable: true,
  },
})

/** A handbook page that is longer and wider than the preview. */
const handbookBody = [
  "# Handbook",
  "",
  "This page tells a new engineer how the team works.",
  "",
  "## First week",
  "",
  "- Get access to GitHub, the cloud console, and the on-call tool.",
  "- Read knowledge/org/architecture.md and the decisions in knowledge/adr/.",
  "- Pair with your buddy on one small change and ship it to production.",
  "- Join the team channel and the incident channel.",
  "",
  "## How we plan",
  "",
  "We plan in two-week cycles. Each cycle starts on a Monday.",
  "The team lead writes the cycle goal in the planning doc.",
  "Each ticket has an owner, an estimate, and a link to its design.",
  "We keep ten percent of each cycle for bugs and support.",
  "",
  "## How we review code",
  "",
  "- Each pull request has one reviewer from the owning team.",
  "- A reviewer answers within one working day.",
  "- Keep a pull request under 400 changed lines when you can.",
  "- A change to billing or auth needs a second reviewer.",
  "",
  "## How we deploy",
  "",
  "Main deploys to production after CI passes.",
  "A failed deploy rolls back by itself.",
  "Use a feature flag for a change that users can see.",
  "Remove the flag within two cycles after the full rollout.",
  "",
  "## On-call",
  "",
  "Each engineer is on call for one week in each rotation.",
  "The on-call engineer answers a page within 15 minutes.",
  "Write each incident in knowledge/incidents/ within two days.",
  "",
  "## Contacts",
  "",
  "| Area | Owner | Channel | Runbook | Escalation | Notes |",
  "| --- | --- | --- | --- | --- | --- |",
  "| Billing | Payments team | #team-payments | knowledge/billing/runbook.md | Page the payments on-call engineer, then the engineering manager of payments | Refunds above 1,000 USD need a second approval from finance before the ledger posts them |",
].join("\n")

/**
 * File preview of a Workspace, where a member reads a file: a long handbook
 * page with a wide table at its end, so the preview scrolls down and across.
 */
export const LongFile = meta.story({
  args: {
    path: "knowledge/handbook.md",
    body: handbookBody,
    cacheKey: "story:long:knowledge/handbook.md",
  },
})

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

/**
 * File preview of a Workspace, where a member edits a file. A draft opens as a
 * diff. The member saved the draft, so no change is left, and the diff view
 * changed back to the plain file view.
 */
export const DraftSavedShowsFile = meta.story({
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a test harness with Save draft and Revert draft buttons, which the product does not render.",
    },
    intent:
      "Catches a saved draft that stays in the diff view. After Save draft, the file view must show. Not for reverted drafts.",
  },
  tags: ["required"],
  render: () => <DraftThenNoChange />,
  play: async ({ canvasElement }) => {
    await expectView(canvasElement, "diff")
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Save draft" }),
    )
    await expectView(canvasElement, "file")
  },
})

/**
 * File preview of a Workspace, where a member edits a file: the member reverted
 * a draft, so the diff view changed back to the file view.
 */
export const DraftRevertedShowsFile = meta.story({
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a test harness with Save draft and Revert draft buttons, which the product does not render.",
    },
    intent:
      "Catches a reverted draft that stays in the diff view. After Revert draft, the file view must show. Not for saved drafts.",
  },
  tags: ["required"],
  render: () => <DraftThenNoChange />,
  play: async ({ canvasElement }) => {
    await expectView(canvasElement, "diff")
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Revert draft" }),
    )
    await expectView(canvasElement, "file")
  },
})
