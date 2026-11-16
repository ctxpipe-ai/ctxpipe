import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, waitFor, within } from "storybook/test"

import { ConnectorSetupStepper } from "@/features/connectors/components/ConnectorSetupStepper"
import {
  workspaceSourceFixture,
  workspaceSourceList,
} from "@/mocks/workspace-sources-handlers"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import type { OpenedPullRequest } from "./useAddToWorkspaces"

/**
 * The merge step as a setup shows it: the last item of the setup steps, a
 * card with its marker. `ConnectorSetupStepper` frames `PullRequestsToMerge`.
 */
function MergeStepInSetup(props: {
  orgSlug: string
  pullRequests: OpenedPullRequest[]
}) {
  return (
    <ConnectorSetupStepper
      steps={[
        { id: "connect", label: "Connect Slack" },
        { id: "workspaces", label: "Add to Workspaces" },
      ]}
      currentIndex={2}
      mergeStep={{ orgSlug: props.orgSlug, pullRequests: props.pullRequests }}
    />
  )
}

const meta = {
  title: "Components/WorkspaceSources/PullRequestsToMerge",
  component: MergeStepInSetup,
  decorators: [
    (Story) => (
      <div className="max-w-xl bg-zinc-950 p-6">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    review: { kind: "component" },
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
} satisfies Meta<typeof MergeStepInSetup>

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
    review: {
      purpose:
        "Merge step at the end of a Slack connector setup, which lists the pull requests to merge: one of two pull requests is merged first, then both are merged.",
    },
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
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Merge the pull requests" }),
      ).toBeVisible(),
    )
    await waitFor(() => expect(canvas.getByText("Merged")).toBeVisible())
    await expect(canvas.getAllByText("Merged")).toHaveLength(1)

    scopeMerged = true
    await waitFor(
      () =>
        expect(
          canvas.getByRole("heading", { name: "Pull requests merged" }),
        ).toBeVisible(),
      { timeout: 10_000 },
    )
    await expect(canvas.getAllByText("Merged")).toHaveLength(2)
  },
}
