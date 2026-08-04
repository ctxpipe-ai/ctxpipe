import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
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
  githubConnectionId: null,
}

const meta = {
  title: "Components/Repositories/RepositoryCard",
  component: RepositoryCard,
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
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof RepositoryCard>

export default meta

type Story = StoryObj<typeof meta>

export const Ready: Story = {
  render: () => (
    <RepositoryCard
      repo={{ ...baseRepo, indexReady: true, indexingStatus: "ready" }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const IndexingWithStepLabel: Story = {
  render: () => (
    <RepositoryCard
      repo={{
        ...baseRepo,
        indexingStatus: "running",
        indexingStep: 7,
        indexingStepTotal: 22,
        indexingStepKey: "embedding",
      }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const IndexingNoStepData: Story = {
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
  render: () => (
    <RepositoryCard
      repo={{
        ...baseRepo,
        indexingStatus: "running",
        lastIngestedHash: "abc1234",
        indexingStep: 14,
        indexingStepTotal: 22,
        indexingStepKey: "syncing_graph",
      }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const Queued: Story = {
  render: () => (
    <RepositoryCard
      repo={{ ...baseRepo, indexingStatus: "queued" }}
      onDelete={noop}
      onRetry={noop}
    />
  ),
}

export const Failed: Story = {
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
