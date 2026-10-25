import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { Suspense, useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { ConversationTurnChangesCard } from "./ConversationTurnChangesCard"
import type { ConversationTurnChanges } from "./types"
import { WorkspaceConversationDiffPane } from "./WorkspaceConversationDiff"

const changes: ConversationTurnChanges = {
  runId: "run_turn_2",
  turn: 2,
  files: [
    {
      path: ".ai/scratchpad/release/issues/34-diff.md",
      status: "added",
      additions: 49,
      deletions: 0,
    },
    {
      path: "apps/ui/src/Diff.tsx",
      status: "modified",
      additions: 70,
      deletions: 5,
    },
    {
      path: "apps/ui/src/pane.ts",
      status: "modified",
      additions: 8,
      deletions: 2,
    },
    {
      path: "scripts/ci/old.sh",
      status: "deleted",
      additions: 0,
      deletions: 1,
    },
  ],
}

const meta = {
  title: "Components/Workspaces/ConversationTurnChangesCard",
  component: ConversationTurnChangesCard,
  decorators: [
    (Story) => (
      <div className="w-[40rem] bg-background p-4">
        <Story />
      </div>
    ),
  ],
  args: { changes, onOpenDiff: fn() },
} satisfies Meta<typeof ConversationTurnChangesCard>

export default meta

type Story = StoryObj<typeof meta>

export const TurnCardCollapsed: Story = {
  tags: ["workspace-golden"],
  args: { defaultCollapsed: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = canvas.getByRole("region", { name: "4 changed files" })
    await expect(
      within(card).getByText("127 added, 8 removed"),
    ).toBeInTheDocument()
    await expect(canvas.queryByText("apps/ui/src")).not.toBeInTheDocument()

    await userEvent.click(
      canvas.getByRole("button", { name: "Show changed files" }),
    )
    await waitFor(() => expect(canvas.getByText("apps/ui/src")).toBeVisible())
    await expect(canvas.getByText("scripts/ci")).toBeVisible()
    await expect(
      canvas.getByText(".ai/scratchpad/release/issues"),
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Hide changed files" }),
    )
    await expect(canvas.queryByText("apps/ui/src")).not.toBeInTheDocument()
  },
}

export const TurnCardExpanded: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const folder = canvas.getByRole("button", { name: /apps\/ui\/src/ })
    await expect(folder).toHaveAttribute("aria-expanded", "false")
    // The folder adds up its files.
    await expect(canvas.getByText("78 added, 7 removed")).toBeInTheDocument()
    await userEvent.click(folder)
    await waitFor(() => expect(folder).toHaveAttribute("aria-expanded", "true"))
    await expect(
      canvas.getByRole("button", { name: "Open diff of apps/ui/src/Diff.tsx" }),
    ).toBeVisible()
    await expect(canvas.getByText("70 added, 5 removed")).toBeInTheDocument()

    await userEvent.click(canvas.getByRole("button", { name: "Open diff" }))
    await expect(args.onOpenDiff).toHaveBeenCalledWith()
  },
}

function CardAndPane() {
  const [open, setOpen] = useState<{ path?: string } | null>(null)
  return (
    <div className="flex gap-4">
      <div className="w-[28rem]">
        <ConversationTurnChangesCard
          changes={changes}
          onOpenDiff={(path) => setOpen({ path })}
        />
      </div>
      <div className="flex h-[30rem] w-[32rem] flex-col bg-card">
        {open ? (
          <Suspense fallback={<p>Loading</p>}>
            <WorkspaceConversationDiffPane
              orgSlug="acme"
              conversationId="conv_turn_card"
              turn={changes.runId}
              focusPath={open.path}
              onShowAll={() => setOpen(null)}
            />
          </Suspense>
        ) : null}
      </div>
    </div>
  )
}

export const TurnCardOpensDiff: Story = {
  tags: ["workspace-golden"],
  decorators: [() => <CardAndPane />],
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            /\/conversations\/conv_turn_card\/files\/diff$/,
            ({ request }) => {
              if (
                new URL(request.url).searchParams.get("turn") !== "run_turn_2"
              )
                return HttpResponse.json(
                  { error: "Not found" },
                  { status: 404 },
                )
              return HttpResponse.json({
                base: "main",
                items: [
                  {
                    path: "apps/ui/src/Diff.tsx",
                    status: "modified",
                    additions: 2,
                    deletions: 1,
                    oldBody: "a\nb\n",
                    body: "a\nB\nc\n",
                  },
                  {
                    path: "apps/ui/src/pane.ts",
                    status: "modified",
                    additions: 1,
                    deletions: 1,
                    oldBody: "x\n",
                    body: "y\n",
                  },
                ],
              })
            },
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: /apps\/ui\/src/ }))
    await userEvent.click(
      canvas.getByRole("button", { name: "Open diff of apps/ui/src/Diff.tsx" }),
    )
    const row = await canvas.findByRole("button", {
      name: "apps/ui/src/Diff.tsx, Modified",
    })
    await expect(row).toHaveAttribute("aria-expanded", "true")
    await expect(
      canvas.getByRole("button", { name: "apps/ui/src/pane.ts, Modified" }),
    ).toHaveAttribute("aria-expanded", "false")
    await expect(canvas.getByText("One turn")).toBeVisible()
    await waitFor(() =>
      expect(canvasElement.querySelector("diffs-container")).not.toBeNull(),
    )
  },
}
