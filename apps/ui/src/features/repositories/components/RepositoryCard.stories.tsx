import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { RepositoryCard } from "./RepositoryCard"

const noop = () => {}

const baseRepo = {
  id: "repo_1",
  orgId: "org_acme",
  zoektRepoId: 1,
  name: "acme/web",
  gitUrl: "https://github.com/acme/web.git",
  indexReady: false,
  indexingError: null,
  indexingFailedAt: null,
  indexingReason: null,
  indexingStep: null,
  indexingStepTotal: null,
  indexingStepKey: null,
  lastIngestedHash: null,
  lastIngestedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
}

const meta = {
  title: "Components/Repositories/RepositoryCard",
  component: RepositoryCard,
  args: {
    repo: { ...baseRepo, indexingStatus: "queued" },
    onDelete: noop,
    onRetry: noop,
  },
  decorators: [
    (Story) => (
      <div className="w-full max-w-2xl">
        <ul className="w-full list-none p-0">
          <li className="w-full">
            <Story />
          </li>
        </ul>
      </div>
    ),
  ],
  parameters: {
    msw: { handlers: { session: signedInHandlers } },
    app: "root",
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
} satisfies Meta<typeof RepositoryCard>

export default meta

type Story = StoryObj<typeof meta>

export const Ready: Story = {
  parameters: {
    review: {
      purpose:
        "Repository card that shows the index state of a repository: the index is ready, from an ingest one hour ago.",
    },
  },
  render: () => (
    <RepositoryCard
      repo={{
        ...baseRepo,
        indexReady: true,
        indexingStatus: "ready",
        lastIngestedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        lastIngestedHash: "abc1234",
      }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const IndexingWithStepLabel: Story = {
  parameters: {
    review: {
      purpose:
        "Repository card that shows the index state of a repository: the first index runs at step 7 of 22.",
    },
  },
  render: () => (
    <RepositoryCard
      repo={{
        ...baseRepo,
        indexingStatus: "running",
        indexingStep: 7,
        indexingStepTotal: 22,
        indexingStepKey: "finalizing",
      }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const IndexingNoStepData: Story = {
  parameters: {
    review: {
      purpose:
        "Repository card that shows the index state of a repository: an index after a merge runs with no step data.",
    },
  },
  render: () => (
    <RepositoryCard
      repo={{
        ...baseRepo,
        indexingStatus: "running",
        indexingReason: "merge",
      }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const RefreshingWithStepLabel: Story = {
  parameters: {
    review: {
      purpose:
        "Repository card that shows the index state of a repository: a refresh of a ready index runs at step 14 of 22.",
    },
  },
  render: () => (
    <RepositoryCard
      repo={{
        ...baseRepo,
        indexingStatus: "running",
        lastIngestedHash: "abc1234",
        indexingStep: 14,
        indexingStepTotal: 22,
        indexingStepKey: "cloning",
      }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const Queued: Story = {
  parameters: {
    review: {
      purpose:
        "Repository card that shows the index state of a repository: the index waits in the queue.",
    },
  },
  render: () => (
    <RepositoryCard
      repo={{ ...baseRepo, indexingStatus: "queued" }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const Failed: Story = {
  parameters: {
    review: {
      purpose:
        "Repository card that shows the index state of a repository: the index failed because the clone timed out.",
    },
  },
  render: () => (
    <RepositoryCard
      repo={{
        ...baseRepo,
        indexingStatus: "failed",
        indexingError: "Cloning timed out after 300s",
      }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const CompleteWithIssues: Story = {
  parameters: {
    review: {
      purpose:
        "Repository card that shows the index state of a repository: the index ended with issues, and the user picked Retry in the menu.",
    },
  },
  args: {
    repo: {
      ...baseRepo,
      indexReady: true,
      indexingStatus: "complete_with_issues",
      indexingError: "Codebase didn't fit available memory",
      lastIngestedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      lastIngestedHash: "abc1234",
    },
    onDelete: fn(),
    onRetry: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Repository actions" }),
    )
    const retry = await within(canvasElement.ownerDocument.body).findByRole(
      "menuitem",
      { name: "Retry indexing" },
    )
    await userEvent.click(retry)
    await expect(args.onRetry).toHaveBeenCalledTimes(1)
  },
}
