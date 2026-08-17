import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
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

export const Hydrating: Story = {}

export const WaitingForTip: Story = {
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

export const Failed: Story = {
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
