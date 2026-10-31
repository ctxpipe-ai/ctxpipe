import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import {
  workspaceSourceFixture,
  workspaceSourceList,
} from "@/mocks/workspace-sources-handlers"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { ConnectorSetupStepper } from "../connectors/components/ConnectorSetupStepper"
import { PullRequestsToMerge, useMergeStep } from "./PullRequestsToMerge"
import type { OpenedPullRequest } from "./useAddToWorkspaces"

/** The merge step as a setup dialog shows it: the stepper and the body. */
function MergeStep(props: {
  pullRequests: OpenedPullRequest[]
  onDone: () => void
}) {
  const merge = useMergeStep({
    orgSlug: "acme",
    steps: [{ id: "workspaces", label: "Choose Workspaces" }],
    pullRequests: props.pullRequests,
  })
  return (
    <div className="space-y-6">
      <ConnectorSetupStepper
        steps={merge.steps}
        currentIndex={merge.currentIndex ?? 0}
      />
      <PullRequestsToMerge
        pullRequests={props.pullRequests}
        merged={merge.merged}
        onDone={props.onDone}
      />
    </div>
  )
}

const meta = {
  title: "Components/WorkspaceSources/PullRequestsToMerge",
  component: PullRequestsToMerge,
  render: (args) => (
    <MergeStep pullRequests={args.pullRequests} onDone={args.onDone} />
  ),
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
    merged: [],
    onDone: fn(),
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
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Merge the pull requests" }),
      ).toBeVisible(),
    )
    await expect(
      canvas.getByRole("listitem", { current: "step" }),
    ).toHaveTextContent("Merge pull requests")
    await waitFor(() => expect(canvas.getByText("Merged")).toBeVisible())
    await expect(canvas.getAllByText("Merged")).toHaveLength(1)
    // One "Review pull request" for each pull request that is not merged.
    const reviews = canvas.getAllByRole("link", {
      name: /^Review pull request/,
    })
    await expect(reviews.map((link) => link.getAttribute("href"))).toEqual([
      "https://github.com/acme/eng/pull/9",
    ])
    await expect(canvas.getByText("Awaiting merge")).toBeVisible()

    scopeMerged = true
    await waitFor(
      () =>
        expect(
          canvas.getByRole("heading", { name: "Pull requests merged" }),
        ).toBeVisible(),
      // The step reads the sources again every 5 seconds.
      { timeout: 10_000 },
    )
    await expect(canvas.getAllByText("Merged")).toHaveLength(2)
    // The stepper shows each step done.
    await expect(canvas.queryByRole("listitem", { current: "step" })).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Done" }))
    await waitFor(() => expect(args.onDone).toHaveBeenCalled())
  },
}
