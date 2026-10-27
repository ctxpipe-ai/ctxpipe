import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor, within } from "storybook/test"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import {
  failedHydrateWorkspace,
  hydratingWorkspace,
} from "./workspace-fixtures"
import { WorkspaceHydrateProgress } from "./WorkspaceHydrateProgress"

const orgSlug = "acme"

const meta = {
  title: "Components/Workspaces/HydrateProgress",
  component: WorkspaceHydrateProgress,
  decorators: [
    (Story) => (
      <div className="flex min-h-[24rem] bg-zinc-950">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
  args: { orgSlug, workspace: hydratingWorkspace },
} satisfies Meta<typeof WorkspaceHydrateProgress>

export default meta

type Story = StoryObj<typeof meta>

export const PrepareReadingKnowledge: Story = {
  parameters: {
    intent:
      "Catches a prepare panel that shows the wrong step. It lists fetch then read, marks Reading knowledge as current, and avoids the word hydrate. Not for errors.",
  },
  tags: ["workspace-golden"],
  args: { workspace: { ...hydratingWorkspace, desiredSha: "87797371c413" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const steps = await canvas.findAllByRole("listitem")
    expect(steps.map((step) => step.textContent)).toEqual([
      "Fetching repository",
      "Reading knowledge",
    ])
    expect(steps[1]).toHaveAttribute("aria-current", "step")
    expect(steps[1]?.querySelector(".ctx-indexing-dot")).not.toBeNull()
    expect(steps[0]).not.toHaveAttribute("aria-current")
    expect(canvasElement.textContent).not.toMatch(/hydrate/i)
  },
}

export const PrepareWaitingForTip: Story = {
  parameters: {
    intent:
      "Catches a prepare panel with no known commit that gives no next step. It explains the latest commit is unknown and offers Try again. Not for a known commit.",
  },
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect((await canvas.findAllByRole("listitem"))[0]).toHaveAttribute(
      "aria-current",
      "step",
    )
    expect(
      canvas.getByText(
        "The latest commit of this repository is not known yet. Select Try again to check the repository.",
      ),
    ).toBeVisible()
    expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible()
  },
  args: {
    workspace: { ...hydratingWorkspace, desiredSha: null },
  },
}

export const PrepareFailed: Story = {
  parameters: {
    intent:
      "Catches a failed prepare that shows no cause or retry. It shows the error, a settings hint, and Try again, with no step list. Not for a prepare in progress.",
  },
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Prepare failed")).toBeVisible(),
    )
    expect(
      canvas.getByText(/Change the Workspace repository in settings/),
    ).toBeVisible()
    expect(
      canvas.getByText(failedHydrateWorkspace.hydrateError ?? ""),
    ).toBeVisible()
    expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible()
    expect(canvas.queryByRole("listitem")).toBeNull()
    expect(canvasElement.textContent).not.toMatch(/hydrate/i)
  },
  args: {
    workspace: failedHydrateWorkspace,
  },
}

/** A pending row that already has an error shows the failed panel. */
export const PreparePendingWithError: Story = {
  parameters: {
    intent:
      "Catches a pending workspace with a stored error that shows the step list. The failed panel must show the error and Try again. Not for a clean pending state.",
  },
  tags: ["workspace-golden"],
  args: {
    workspace: {
      ...hydratingWorkspace,
      hydrateStatus: "pending",
      desiredSha: "87797371c413",
      hydrateError:
        "Could not resolve the git tip for this workspace repository.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Prepare failed")).toBeVisible(),
    )
    expect(
      canvas.getByText(
        "Could not resolve the git tip for this workspace repository.",
      ),
    ).toBeVisible()
    expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible()
    expect(canvas.queryByRole("listitem")).toBeNull()
  },
}

/** A Workspace that ctxpipe cannot read links to Connectors to fix the access. */
export const PrepareNoAccess: Story = {
  args: {
    workspace: {
      ...failedHydrateWorkspace,
      hydrateError:
        "ctxpipe has no access to this repository. Connect GitHub to this Workspace, then retry.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Prepare failed")).toBeVisible(),
    )
    expect(
      canvas.getByText(/Connect GitHub to this Workspace, then retry/),
    ).toBeVisible()
    expect(
      canvas.getByRole("link", { name: "Open Connectors" }),
    ).toHaveAttribute("href", `/${orgSlug}/connectors`)
    expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible()
  },
}
