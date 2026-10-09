import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceHydrateProgress } from "./WorkspaceHydrateProgress"
import {
  failedHydrateWorkspace,
  hydratingWorkspace,
} from "./workspace-fixtures"

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
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+\/retry-prepare$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json({
                ...hydratingWorkspace,
                desiredSha: "abc123def456",
                hydrateStatus: "pending",
                hydrateError: null,
              }),
          ),
        ],
      },
    },
  },
}

export const PrepareFailed: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(await canvas.findByText("Prepare failed")).toBeVisible()
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
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(
            ({ request }) =>
              /\/api\/v1\/workspaces\/[^/]+\/retry-prepare$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json({
                ...failedHydrateWorkspace,
                hydrateStatus: "pending",
                hydrateError: null,
              }),
          ),
        ],
      },
    },
  },
}

/** A pending row that already has an error shows the failed panel. */
export const PreparePendingWithError: Story = {
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
    expect(await canvas.findByText("Prepare failed")).toBeVisible()
    expect(
      canvas.getByText(
        "Could not resolve the git tip for this workspace repository.",
      ),
    ).toBeVisible()
    expect(canvas.getByRole("button", { name: "Try again" })).toBeVisible()
    expect(canvas.queryByRole("listitem")).toBeNull()
  },
}
