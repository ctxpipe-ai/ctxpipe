import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, waitFor, within } from "storybook/test"
import {
  ingestionItemFixture,
  workspaceIngestionHandlers,
} from "@/mocks/workspace-ingestion-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceIngestingNow } from "./WorkspaceIngestingNow"

const meta = {
  title: "Components/Workspaces/IngestingNow",
  component: WorkspaceIngestingNow,
  decorators: [
    (Story) => (
      <div className="w-[40rem] bg-zinc-950 p-6">
        <Story />
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
  args: { orgSlug: "acme", workspaceSlug: "docs" },
} satisfies Meta<typeof WorkspaceIngestingNow>

export default meta

type Story = StoryObj<typeof meta>

function withItems(items: ReturnType<typeof ingestionItemFixture>[]) {
  return {
    msw: {
      handlers: { ingestion: workspaceIngestionHandlers({ docs: items }) },
    },
  }
}

export const NothingIngests: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText(
      "Nothing ingests now. ctxpipe ingests a source when it changes.",
    )
  },
}

/** A repository in its shards: the stage, "3 of 8 parts done" and a bar at 3/8. */
export const RunningRepository: Story = {
  parameters: withItems([ingestionItemFixture()]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("acme/web")
    await waitFor(() => {
      expect(canvas.getByText("Reading the code")).toBeVisible()
      expect(canvas.getByText("3 of 8 parts done")).toBeVisible()
      expect(
        canvas.getByRole("progressbar", { name: "Reading the code" }),
      ).toHaveAttribute("aria-valuenow", "37.5")
      expect(canvas.getByText(/Time so far:/)).toBeVisible()
    })
  },
}

export const ConnectorSync: Story = {
  parameters: withItems([
    ingestionItemFixture({
      id: "run_linear",
      kind: "source_sync",
      name: "Linear",
      stage: "syncing",
      progress: null,
      minutesAgo: 1,
    }),
  ]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Linear sources")
    await waitFor(() =>
      expect(canvas.getByText("Syncing the sources")).toBeVisible(),
    )
  },
}

/** A later run of a repository waits for the earlier run (CTX-964). */
export const WaitingRun: Story = {
  parameters: withItems([
    ingestionItemFixture({ minutesAgo: 20 }),
    ingestionItemFixture({
      id: "run_web_2",
      stage: "waiting",
      progress: null,
      minutesAgo: 6,
    }),
  ]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Waiting for an earlier run of this repository")
    await waitFor(() => {
      expect(canvas.getAllByText("acme/web")).toHaveLength(2)
      expect(
        canvas.getByRole("progressbar", {
          name: "Waiting for an earlier run of this repository",
        }),
      ).toHaveAttribute("aria-valuenow", "0")
    })
  },
}

/** A hydrate of the newest commit that takes long is one line under the list. */
export const SlowHydrate: Story = {
  parameters: withItems([
    ingestionItemFixture({
      id: "run_hydrate",
      kind: "hydrate",
      name: "Newest commit",
      stage: "hydrating",
      progress: null,
      minutesAgo: 1,
    }),
  ]),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByText("Indexing the newest commit…")
    await expect(canvas.queryByRole("list")).not.toBeInTheDocument()
  },
}
