import { Link } from "react-aria-components"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { AppShell } from "@/components/AppShell"
import { ShellLayoutProvider } from "@/components/ShellLayoutContext"
import { SideNav } from "@/components/SideNav"
import {
  docsConversations,
  docsWorkspace,
  readOnlyWorkspace,
} from "@/features/workspaces/workspace-fixtures"
import { signedInHandlers } from "@/mocks/handlers"
import {
  conversationsListHandler,
  githubInstallationReposHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"

const meta = preview.meta({
  title: "App/SideNav",
  component: SideNav,
  decorators: [
    // The nav reads the current org and Workspace from the shell layout, as
    // in AppShell. The story shows the nav alone, with no page beside it.
    (Story) => (
      <ShellLayoutProvider>
        <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
          <Story />
        </div>
      </ShellLayoutProvider>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, ...workspaceIngestionHandlers({}))
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    review: { kind: "component" },
  },
})

/**
 * Main navigation of an org: the org has one Workspace and the Workspace page
 * is current.
 */
export const SingleWorkspace = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      conversationsListHandler(docsConversations),
      githubInstallationReposHandler(),
    )
  },
  parameters: {
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
  },
})

/**
 * Main navigation of an org: the org has two Workspaces, one of them read-only.
 */
export const MultipleWorkspaces = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
      conversationsListHandler(docsConversations),
      githubInstallationReposHandler(),
    )
  },
  parameters: {
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
  },
})

/**
 * Main navigation of an org: the user collapsed the nav to the narrow icon
 * rail.
 */
export const Collapsed = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
      conversationsListHandler(docsConversations),
      githubInstallationReposHandler(),
    )
  },
  parameters: {
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /collapse navigation/i }),
    )
  },
})

/**
 * Main navigation of an org: the nav starts expanded, after the story before it
 * collapsed the nav and stored that choice. This story is the proof for the
 * global story reset.
 */
export const ExpandedAfterCollapsedStory = meta.story({
  beforeEach: Collapsed.input.beforeEach,
  parameters: {
    ...Collapsed.input.parameters,
    visual: {
      skip: "Behavior test: it ends in the same state as SingleWorkspace.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: /collapse navigation/i })
    await expect(
      canvas.queryByRole("button", { name: /expand navigation/i }),
    ).not.toBeInTheDocument()
  },
})

/**
 * App shell with the main navigation and a test link in the page body: the user
 * clicked the link, and Connectors became the current nav item. The shell stays
 * mounted while the current item moves from the Workspace to Connectors.
 */
export const PlainLinkMovesCurrentNav = meta.story({
  tags: ["required"],
  render: () => (
    <AppShell>
      <Link href="/acme/connectors" className="p-6 text-sm text-teal-400">
        Connect another source
      </Link>
    </AppShell>
  ),
  beforeEach: ({ msw }) => {
    msw.use(
      workspaceListHandler([docsWorkspace]),
      conversationsListHandler(docsConversations),
      githubInstallationReposHandler(),
    )
  },
  parameters: {
    visual: {
      skip: "Behavior test: the page body is a test link, which the product does not render.",
    },
    intent:
      "Catches a plain link in the page that does not move the current item in the main navigation. Not for nav styling or workspace list data.",
    storyRoute: {
      pattern: "flat",
      path: "/acme/ws/docs",
      alsoAt: ["/acme/connectors"],
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const nav = await canvas.findByRole("navigation", {
      name: "Main navigation",
    })
    const connectors = await within(nav).findByRole("link", {
      name: "Connectors",
    })
    await expect(connectors).not.toHaveAttribute("aria-current")
    await userEvent.click(
      canvas.getByRole("link", { name: "Connect another source" }),
    )
    await waitFor(() =>
      expect(
        within(nav).getByRole("link", { name: "Connectors" }),
      ).toHaveAttribute("aria-current", "page"),
    )
  },
})

/**
 * Main navigation of an org: the nav is collapsed to the icon rail after a
 * check of the Docs link.
 */
export const DocsLinkOpensProductDocs = meta.story({
  beforeEach: SingleWorkspace.input.beforeEach,
  parameters: {
    ...SingleWorkspace.input.parameters,
    visual: { skip: "Behavior test: it ends in the same state as Collapsed." },
    intent:
      "Catches a Docs link that is missing from the Help list of the main navigation. Also catches a Docs link that does not open the product docs in a new tab, or that has no name in the collapsed rail. Not for the other footer items.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const nav = await canvas.findByRole("navigation", {
      name: "Main navigation",
    })
    const help = await within(nav).findByRole("list", { name: "Help" })
    const docs = within(help).getByRole("link", { name: "Docs" })
    await expect(docs).toHaveAttribute("href", "https://docs.ctxpipe.ai")
    await expect(docs).toHaveAttribute("target", "_blank")
    await userEvent.click(
      canvas.getByRole("button", { name: /collapse navigation/i }),
    )
    await within(nav).findByRole("button", { name: /expand navigation/i })
    await expect(
      within(nav).getByRole("link", { name: "Docs" }),
    ).toHaveAttribute("href", "https://docs.ctxpipe.ai")
  },
})

/**
 * Side nav of an org: the user pressed their name at the bottom, and the user
 * menu opened with Settings, Connected apps and Sign out, the focus on
 * Settings.
 */
export const UserMenuLinksConnectedApps = meta.story({
  tags: ["required"],
  beforeEach: SingleWorkspace.input.beforeEach,
  parameters: {
    ...SingleWorkspace.input.parameters,
    // A literal: the screenshot checks read the story file, not the spread.
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    intent:
      "Catches a user menu whose Connected apps item does not link to the connected apps page in the auth area. Not for other menu items or account data.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await canvas.findByRole("button", { name: /User menu|User/ }),
    )
    const item = await body.findByRole("menuitem", { name: /Connected apps/ })
    await expect(item.closest("a")).toHaveAttribute(
      "href",
      "/.auth/account/connected-apps",
    )
    // The menu moves the focus a few times while it opens, and where it ends
    // differs from run to run. Wait for the open animation, then put the focus
    // on the first item, so the focus ring does not depend on the time of the
    // click.
    const menu = body.getByRole("menu")
    await waitFor(() =>
      expect(menu.getAnimations({ subtree: true })).toHaveLength(0),
    )
    const first = body.getByRole("menuitem", { name: /Settings/ })
    first.focus()
    await waitFor(() => expect(first).toHaveFocus())
  },
})
