import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { Button } from "@/components/ui/Button"
import { Dialog } from "@/components/ui/Dialog"
import { Modal } from "@/components/ui/Modal"
import {
  createdWorkspace,
  createdWritableWorkspaceDetail,
  docsConversations,
  docsWorkspace,
  docsWorkspaceDetail,
} from "@/features/workspaces/workspace-fixtures"
import { ConversationCtaActions } from "@/features/workspaces/WorkspaceChatChrome"
import { WorkspaceNavList } from "@/features/workspaces/WorkspaceNavList"
import { WorkspacePaneTriggers } from "@/features/workspaces/WorkspacePane"
import { workspaceCreatedFlag } from "@/lib/session-flags"
import {
  organizationFullWithOrgHandler,
  authConfigHandler,
  githubAppInstalledHandlers,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
} from "@/mocks/handlers"
import {
  conversationsListHandler,
  githubInstallationReposHandler,
  workspaceDetailHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
  workspaceSourceList,
  workspaceSourcesHandler,
} from "@/mocks/workspace-sources-handlers"
import {
  upgradesFixture,
  workspaceUpgradesHandler,
} from "@/mocks/workspace-upgrades-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"

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
  organizationFullWithOrgHandler,
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

const meta = preview.meta({
  title: "Components/Onboarding/Hints",
  beforeEach: ({ msw }) => {
    msw.use(...newUserDefaults, ...workspaceIngestionHandlers({}))
  },
  parameters: {
    app: "root",
    layout: "centered",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
})

/**
 * Onboarding hint popover next to Add Workspace in the side nav, which shows
 * once at least one Workspace exists: the user closed the hint with Escape, and
 * ctxpipe records it as seen.
 */
export const AddWorkspaceHint = meta.story({
  render: () => (
    <ul className="w-64 bg-zinc-950 py-2">
      <WorkspaceNavList orgSlug="acme" expanded onSelectNav={() => {}} />
    </ul>
  ),
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      conversationsListHandler(docsConversations),
    )
    seedHintsSeen([])
  },
  play: async ({ canvasElement }) => {
    await findHint(canvasElement, "Add a Workspace for each team or product.")
    // Escape records the hint while focus stays on the page.
    await userEvent.keyboard("{Escape}")
    const body = within(canvasElement.ownerDocument.body)
    await waitFor(
      () => expect(body.queryByRole("dialog", { name: "Hint" })).toBeNull(), // play-timing: ok findHint above waited for the hint; Escape closes it
    )
    expect(storedHintsSeen()).toContain("add-workspace")
  },
})

/** The side nav with a modal dialog that is open when the story starts. */
function NavWithOpenDialog() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <ul className="w-64 bg-zinc-950 py-2">
        <WorkspaceNavList orgSlug="acme" expanded onSelectNav={() => {}} />
      </ul>
      <Modal isOpen={open} onOpenChange={setOpen}>
        <Dialog aria-label="Story dialog">
          <Button variant="secondary" onPress={() => setOpen(false)}>
            Close dialog
          </Button>
        </Dialog>
      </Modal>
    </>
  )
}

/**
 * Workspace list in the side nav, with the one-time hint beside its Add
 * Workspace button: a dialog was open when the hint was due, so the hint showed
 * after the dialog closed. CTX-863: no hint shows while a modal dialog is open.
 */
export const AddWorkspaceHintWaitsForDialog = meta.story({
  render: () => <NavWithOpenDialog />,
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      conversationsListHandler(docsConversations),
    )
    seedHintsSeen([])
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await body.findByRole("dialog", { name: "Story dialog" })
    // The Workspace list loaded, so the add-workspace hint is due.
    await within(canvasElement).findAllByText("Docs")
    expect(body.queryByRole("dialog", { name: "Hint" })).toBeNull()
    await waitFor(async () => {
      const close = body.queryByRole("button", { name: "Close dialog" })
      if (close) await userEvent.click(close)
      expect(body.queryByRole("dialog", { name: "Story dialog" })).toBeNull()
    })
    await findHint(canvasElement, "Add a Workspace for each team or product.")
    expect(storedHintsSeen()).not.toContain("add-workspace")
  },
})

const workspacesPath = ({ request }: { request: Request }) =>
  /\/api\/v1\/workspaces$/.test(new URL(request.url).pathname)
const createState = { created: false }

/**
 * Workspace list in the side nav: the user created a Workspace with Add
 * Workspace, so the Add Workspace hint does not show when the dialog closes.
 * CTX-863: the user just did what the tip says. The tip can show on a later
 * visit, after the session flag is gone.
 */
export const AddWorkspaceHintSkippedAfterCreating = meta.story({
  render: () => (
    <ul className="w-64 bg-zinc-950 py-2">
      <WorkspaceNavList orgSlug="acme" expanded onSelectNav={() => {}} />
    </ul>
  ),
  beforeEach: ({ msw }) => {
    msw.use(
      activeMemberRoleHandler("owner"),
      http.get(workspacesPath, () =>
        HttpResponse.json({
          items: createState.created ? [createdWorkspace] : [],
          lastUsedWorkspaceId: createState.created ? createdWorkspace.id : null,
        }),
      ),
      http.post(workspacesPath, () => {
        createState.created = true
        return HttpResponse.json(createdWorkspace, { status: 201 })
      }),
      conversationsListHandler([]),
      orgConnectionsHandler([
        { id: "con_gh", type: "github", displayName: "acme" },
      ]),
      ...githubAppInstalledHandlers,
      githubInstallationReposHandler(),
      workspaceDetailHandler(createdWritableWorkspaceDetail),
      workspaceSourcesHandler(workspaceSourceList()),
      workspaceUpgradesHandler(upgradesFixture([], { formatVersion: 3 })),
    )
    seedHintsSeen([])
    createState.created = false
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends on its control, the hint after the session flag is cleared. That is the hint state of AddWorkspaceHintWaitsForDialog.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: "Add Workspace" }),
    )
    const dialog = within(await body.findByRole("dialog"))
    await userEvent.click(
      await dialog.findByRole("radio", { name: /acme\/handbook/ }),
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Create Workspace" }),
    )
    // Step 2 has settled when its sources show.
    await dialog.findByRole("button", { name: "Add repositories" })
    await userEvent.click(dialog.getByRole("button", { name: "Close" }))
    await waitFor(() => expect(body.queryByRole("dialog")).toBeNull())
    // The nav lists the new Workspace, so the add-workspace anchor is on the
    // page and the tip would be due without the flag.
    await canvas.findByText("Handbook")
    // Open and close the dialog once more. The tip re-checks when a dialog
    // closes, so the anchor has settled when this returns.
    const cycleDialog = async () => {
      await userEvent.click(
        await canvas.findByRole("button", { name: "Add Workspace" }),
      )
      // Wait for this dialog to go, not for every dialog: the tip is a dialog.
      const dialog = await body.findByRole("dialog")
      await userEvent.click(
        await within(dialog).findByRole("button", { name: "Close" }),
      )
      await waitFor(() => expect(dialog).not.toBeInTheDocument())
    }
    await cycleDialog()
    expect(body.queryByRole("dialog", { name: "Hint" })).toBeNull()
    expect(storedHintsSeen()).not.toContain("add-workspace")
    // Control: without the flag, the same page shows the tip. So only the
    // flag held it back.
    workspaceCreatedFlag.clear()
    await cycleDialog()
    await findHint(canvasElement, "Add a Workspace for each team or product.")
  },
})

/**
 * Onboarding hint popover next to the Files and Graph pane buttons, on the
 * first Workspace visit with the pane closed: a blur or an outside click does
 * not close it. The user pressed Got it, and the hint closed.
 */
export const PanesHint = meta.story({
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
})

/**
 * Onboarding hint popover next to the Create PR button of a conversation, after
 * the user saw the panes hint: the hint shows for the first time and does not
 * take focus.
 */
export const CreatePrHint = meta.story({
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
})
