import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { ConversationCtaActions } from "@/features/workspaces/WorkspaceChatChrome"
import { WorkspaceNavList } from "@/features/workspaces/WorkspaceNavList"
import { WorkspacePaneTriggers } from "@/features/workspaces/WorkspacePane"
import {
  docsConversations,
  docsWorkspace,
  docsWorkspaceDetail,
} from "@/features/workspaces/workspace-fixtures"
import {
  authConfigHandler,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
} from "@/mocks/handlers"
import {
  conversationsListHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"

const PREFERENCES_KEY = "ctxpipe:userPreferences"
const userId = "user_storybook"

/** A user who finished onboarding yesterday, so hints show. */
const newUserDefaults = [
  authConfigHandler,
  sessionSignedInHandler({
    id: userId,
    onboardingCompletedAt: new Date(Date.now() - 86_400_000).toISOString(),
  }),
  organizationListWithOrgHandler,
]

function seedHintsSeen(hintsSeen: string[]) {
  window.localStorage.setItem(
    PREFERENCES_KEY,
    JSON.stringify({ orgGuides: { [`${userId}:acme`]: { hintsSeen } } }),
  )
}

function storedHintsSeen(): string[] {
  const stored = JSON.parse(
    window.localStorage.getItem(PREFERENCES_KEY) ?? "{}",
  )
  return stored.orgGuides?.[`${userId}:acme`]?.hintsSeen ?? []
}

/** The hint popover renders in a portal, outside the story canvas. */
async function findHint(canvasElement: HTMLElement, text: string) {
  const body = within(canvasElement.ownerDocument.body)
  const dialog = await body.findByRole("dialog", { name: "Hint" })
  // The popover fades in.
  await waitFor(() => expect(within(dialog).getByText(text)).toBeVisible())
  return within(dialog)
}

const meta = {
  title: "Components/Onboarding/Hints",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: { handlers: { defaults: newUserDefaults } },
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

/** SideNav "Add Workspace", once at least one Workspace exists. */
export const AddWorkspaceHint: Story = {
  beforeEach: () => seedHintsSeen([]),
  render: () => (
    <ul className="w-64 bg-zinc-950 py-2">
      <WorkspaceNavList orgSlug="acme" expanded onSelectNav={() => {}} />
    </ul>
  ),
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    await findHint(canvasElement, "Add a Workspace for each team or product.")
    // Escape records the hint while focus stays on the page.
    await userEvent.keyboard("{Escape}")
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(body.queryByRole("dialog", { name: "Hint" })).toBeNull(),  // play-timing: ok findHint above waited for the hint; Escape closes it
    )
    expect(storedHintsSeen()).toContain("add-workspace")
  },
}

/** Pane triggers on the first Workspace visit with the pane closed. */
export const PanesHint: Story = {
  beforeEach: () => seedHintsSeen([]),
  render: () => (
    <div className="flex w-96 justify-end p-4">
      <WorkspacePaneTriggers
        orgSlug="acme"
        workspace={docsWorkspaceDetail}
        onOpen={() => {}}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const files = await canvas.findByRole("button", { name: "Files" })
    files.focus()
    const hint = await findHint(
      canvasElement,
      "Files is the knowledge repository. Graph shows how its files link.",
    )
    // The hint does not take focus from the page control.
    expect(files).toHaveFocus()
    // A blur and an outside click do not dismiss it.
    files.blur()
    await userEvent.click(canvasElement)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(hint.getByRole("button", { name: "Got it" })).toBeVisible()
    expect(storedHintsSeen()).not.toContain("panes")
    await userEvent.click(hint.getByRole("button", { name: "Got it" }))
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(() =>
      expect(body.queryByRole("dialog", { name: "Hint" })).toBeNull(),
    )
    expect(storedHintsSeen()).toContain("panes")
  },
}

/** Create PR, the first time it shows, after the panes hint was seen. */
export const CreatePrHint: Story = {
  beforeEach: () => seedHintsSeen(["panes"]),
  render: () => (
    <div className="flex w-96 justify-end p-4">
      <ConversationCtaActions
        hintOrgSlug="acme"
        cta={{
          commitPush: {
            visible: false,
            enabled: false,
            pending: false,
            onPress: fn(),
          },
          pullRequest: {
            visible: true,
            action: "create",
            pending: false,
            onPress: fn(),
          },
        }}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const dialog = await findHint(
      canvasElement,
      "Changes stay on this conversation's branch until you create a pull request.",
    )
    // The hint does not take focus.
    expect(
      dialog
        .getByRole("button", { name: "Got it" })
        .contains(canvasElement.ownerDocument.activeElement),
    ).toBe(false)
  },
}
