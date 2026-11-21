import { expect, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import {
  failedHydrateWorkspace,
  hydratingWorkspace,
} from "./workspace-fixtures"
import { WorkspaceHydrateProgress } from "./WorkspaceHydrateProgress"

const orgSlug = "acme"

const meta = preview.meta({
  title: "Components/Workspaces/HydrateProgress",
  component: WorkspaceHydrateProgress,
  decorators: [
    (Story) => (
      <div className="flex min-h-[24rem] bg-zinc-950">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
  args: { orgSlug, workspace: hydratingWorkspace },
})

/**
 * Prepare panel of a new Workspace, which shows the setup steps: the repository
 * was fetched, and Reading knowledge is the current step.
 */
export const PrepareReadingKnowledge = meta.story({
  parameters: {
    intent:
      "Catches a prepare panel that shows the wrong step. It lists fetch then read, marks Reading knowledge as current, and avoids the word hydrate. Not for errors.",
  },
  tags: ["required"],
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
})

/**
 * Prepare panel of a new Workspace, which shows the setup steps: the latest
 * commit is not known yet, so Try again shows.
 */
export const PrepareWaitingForTip = meta.story({
  parameters: {
    intent:
      "Catches a prepare panel with no known commit that gives no next step. It explains the latest commit is unknown and offers Try again. Not for a known commit.",
  },
  tags: ["required"],
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
})

/**
 * Prepare panel of a new Workspace, which shows the setup steps: the prepare
 * failed, so the error, a settings hint, and Try again show.
 */
export const PrepareFailed = meta.story({
  parameters: {
    intent:
      "Catches a failed prepare that shows no cause or retry. It shows the error, a settings hint, and Try again, with no step list. Not for a prepare in progress.",
  },
  tags: ["required"],
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
})

/**
 * Prepare panel of a new Workspace, which shows the setup steps. The prepare is
 * pending but already has a stored error, so the failed panel shows.
 */
export const PreparePendingWithError = meta.story({
  parameters: {
    intent:
      "Catches a pending workspace with a stored error that shows the step list. The failed panel must show the error and Try again. Not for a clean pending state.",
  },
  tags: ["required"],
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
})

/**
 * Prepare panel of a new Workspace, which shows the setup steps. ctxpipe cannot
 * read the repository, so a link opens Connectors to fix the access.
 */
export const PrepareNoAccess = meta.story({
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
})
