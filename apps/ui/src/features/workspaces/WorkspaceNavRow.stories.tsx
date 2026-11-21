import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { signedInHandlers } from "@/mocks/handlers"
import {
  conversationDetailHandler,
  conversationGitTreeHandler,
  conversationsListHandler,
  workspaceDetailHandler,
} from "@/mocks/workspace-handlers"
import {
  ingestionItemFixture,
  workspaceIngestionHandlers,
} from "@/mocks/workspace-ingestion-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import {
  docsConversationDetail,
  docsConversations,
  docsWorkspace,
  docsWorkspaceDetail,
  readOnlyWorkspace,
} from "./workspace-fixtures"
import { WorkspaceNavRow } from "./WorkspaceNavRow"

const meta = preview.meta({
  title: "Components/Workspaces/NavRow",
  component: WorkspaceNavRow,
  decorators: [
    (Story) => (
      <ul className="w-64 bg-zinc-950 py-2">
        <Story />
      </ul>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, ...workspaceIngestionHandlers({}))
  },
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspace,
    workspaceCount: 2,
    navExpanded: true,
    collapsible: true,
    open: false,
    current: false,
    onToggle: fn(),
    onExpand: fn(),
    onSelectNav: fn(),
  },
})

/**
 * Workspace row in the side nav, which opens a Workspace: two rows, the current
 * Workspace and a read-only one.
 */
export const MultipleWorkspaces = meta.story({
  render: (args) => (
    <>
      <WorkspaceNavRow {...args} current />
      <WorkspaceNavRow
        {...args}
        workspace={readOnlyWorkspace}
        current={false}
      />
    </>
  ),
})

/**
 * Workspace row in the side nav, which opens a Workspace: the only Workspace of
 * the org, current and not collapsible.
 */
export const SingleWorkspace = meta.story({
  args: {
    workspaceCount: 1,
    collapsible: false,
    current: true,
  },
})

/**
 * Workspace row in the collapsed side nav rail, which opens a Workspace: the
 * current Workspace as an icon with no name.
 */
export const CollapsedNav = meta.story({
  args: {
    navExpanded: false,
    current: true,
  },
})

/**
 * Workspace row in the side nav, which opens a Workspace: the member opened the
 * Workspace, so the row lists its chats and the open chat is selected.
 */
export const OpenWithConversations = meta.story({
  args: {
    open: true,
    current: true,
    currentConversationId: "conv_1",
  },
  beforeEach: ({ msw }) => {
    msw.use(conversationsListHandler(docsConversations))
  },
})

const ingestingDocs = workspaceIngestionHandlers({
  docs: [
    ingestionItemFixture(),
    ingestionItemFixture({
      id: "run_linear",
      kind: "source_sync",
      name: "Linear",
      stage: null,
      progress: null,
    }),
  ],
})

/**
 * Two Workspace rows in the side nav, which open a Workspace. ctxpipe ingests
 * only the second Workspace, so only its row has a pulsing teal dot. The Docs
 * row has no pulse and names only the Workspace. The second row lets the play
 * know that the read is applied.
 */
export const NotIngesting = meta.story({
  render: (args) => (
    <>
      <WorkspaceNavRow {...args} />
      <WorkspaceNavRow {...args} workspace={readOnlyWorkspace} />
    </>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("link", {
      name: "Open Handbook. Ingesting 1 source",
    })
    await waitFor(() => {
      const docs = canvas.getByRole("link", { name: "Open Docs" })
      expect(docs.querySelector("[data-ingesting]")).not.toBeInTheDocument()
    })
  },
  beforeEach: ({ msw }) => {
    msw.use(
      ...workspaceIngestionHandlers({
        handbook: [ingestionItemFixture()],
      }),
    )
  },
})

/**
 * Workspace row in the side nav, which opens a Workspace. ctxpipe ingests two
 * of its sources, so a teal dot pulses after the name. The pointer on the row
 * opens a tooltip with "Ingesting 2 sources", and the row name has the same
 * text (CTX-959).
 */
export const Ingesting = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...ingestingDocs,
      // The hover preloads the Workspace and its last conversation.
      workspaceDetailHandler(docsWorkspaceDetail),
      conversationDetailHandler(docsConversationDetail),
      conversationGitTreeHandler(),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("link", {
      name: "Open Docs. Ingesting 2 sources",
    })
    const dot = await waitFor(() => {
      const found = row.querySelector<HTMLElement>("[data-ingesting] > span")
      expect(found).not.toBeNull()
      expect(getComputedStyle(found as HTMLElement).animationName).toBe(
        "ctx-status-pulse",
      )
      return found as HTMLElement
    })
    await userEvent.hover(dot)
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).getByText(
          "Ingesting 2 sources",
        ),
      ).toBeVisible(),
    )
  },
})

/**
 * Workspace row in the side nav, which opens a Workspace. ctxpipe ingests two
 * of its sources with reduced motion, so the dot stays but does not pulse. The
 * play runner opens this story with `prefers-reduced-motion: reduce`.
 */
export const IngestingReducedMotion = meta.story({
  tags: ["required", "reduced-motion"],
  beforeEach: ({ msw }) => {
    msw.use(...ingestingDocs)
  },
  parameters: {
    intent:
      "Catches an ingesting dot in the workspace nav row that keeps animating when the user prefers reduced motion. The dot must not animate. Not for the row label or link.",
  },
  play: async ({ canvasElement }) => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(
      true,
    )
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("link", {
      name: "Open Docs. Ingesting 2 sources",
    })
    await waitFor(() => {
      const dot = row.querySelector<HTMLElement>("[data-ingesting] > span")
      expect(dot).not.toBeNull()
      expect(getComputedStyle(dot as HTMLElement).animationName).toBe("none")
    })
  },
})

/**
 * Workspace row in the collapsed side nav rail. ctxpipe ingests two of its
 * sources, so a dot sits on the folder icon, and the open row tooltip gives the
 * text.
 */
export const IngestingCollapsed = meta.story({
  args: { navExpanded: false, current: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const row = await canvas.findByRole("button", {
      name: "Expand Docs. Ingesting 2 sources",
    })
    await waitFor(() =>
      expect(row.querySelector("[data-ingesting]")).not.toBeNull(),
    )
    await userEvent.hover(row)
    await waitFor(() =>
      expect(
        within(canvasElement.ownerDocument.body).getByText(
          "Docs: Ingesting 2 sources",
        ),
      ).toBeVisible(),
    )
  },
  beforeEach: ({ msw }) => {
    msw.use(...ingestingDocs)
  },
})
