import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, within } from "storybook/test"
import {
  workspaceSourceFixture,
  workspaceSourceList,
} from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { PullRequestsToMerge } from "./PullRequestsToMerge"

const meta = {
  title: "Components/WorkspaceSources/PullRequestsToMerge",
  component: PullRequestsToMerge,
  decorators: [
    (Story) => (
      <div className="max-w-xl bg-zinc-950 p-4">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    pullRequests: [
      {
        url: "https://github.com/acme/docs/pull/8",
        workspaceSlug: "docs",
        path: "slack",
        scope: null,
      },
      {
        url: "https://github.com/acme/eng/pull/9",
        workspaceSlug: "eng",
        path: "slack",
        scope: { channels: ["C2"] },
      },
    ],
  },
} satisfies Meta<typeof PullRequestsToMerge>

export default meta

type Story = StoryObj<typeof meta>

/** Whether the story user merged the scope change on GitHub. */
let scopeMerged = false

/**
 * A save removed the source of one Workspace and changed the scope in
 * another. The remove is merged first, then the scope change.
 */
export const RemoveAndScopeChange: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get("/acme/api/v1/workspaces/docs/sources", () =>
            HttpResponse.json(workspaceSourceList()),
          ),
          http.get("/acme/api/v1/workspaces/eng/sources", () =>
            HttpResponse.json(
              workspaceSourceList({
                items: [
                  workspaceSourceFixture({
                    path: "slack",
                    provider: "slack",
                    scope: { channels: [scopeMerged ? "C2" : "C1"] },
                  }),
                ],
              }),
            ),
          ),
        ],
      },
    },
  },
  beforeEach: () => {
    scopeMerged = false
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByRole("heading", { name: "Merge the pull requests" }),
    ).toBeVisible()
    await expect(await canvas.findByText("Merged")).toBeVisible()
    await expect(canvas.getAllByText("Merged")).toHaveLength(1)

    scopeMerged = true
    await expect(
      await canvas.findByRole(
        "heading",
        { name: "Pull requests merged" },
        { timeout: 10_000 },
      ),
    ).toBeVisible()
    await expect(canvas.getAllByText("Merged")).toHaveLength(2)
  },
}
