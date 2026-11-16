import type { Meta, StoryObj } from "@storybook/react-vite"
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

const meta = {
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
  parameters: {
    msw: {
      handlers: {
        session: signedInHandlers,
        ingestion: workspaceIngestionHandlers({}),
      },
    },
    app: "root",
    layout: "fullscreen",
    review: { kind: "component" },
  },
} satisfies Meta<typeof SideNav>

export default meta

type Story = StoryObj<typeof meta>

export const SingleWorkspace: Story = {
  parameters: {
    review: {
      purpose:
        "Main navigation of an org: the org has one Workspace and the Workspace page is current.",
    },
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
}

export const MultipleWorkspaces: Story = {
  parameters: {
    review: {
      purpose:
        "Main navigation of an org: the org has two Workspaces, one of them read-only.",
    },
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
}

export const Collapsed: Story = {
  parameters: {
    review: {
      purpose:
        "Main navigation of an org: the user collapsed the nav to the narrow icon rail.",
    },
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace, readOnlyWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /collapse navigation/i }),
    )
  },
}

/**
 * Proof for the global story reset. The story before this one collapses the
 * nav and stores that choice. This story must still start expanded.
 */
export const ExpandedAfterCollapsedStory: Story = {
  parameters: {
    ...Collapsed.parameters,
    visual: {
      skip: "Behavior test: it ends in the same state as SingleWorkspace.",
    },
    review: {
      purpose:
        "Main navigation of an org: the nav starts expanded after the story before it collapsed it.",
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("button", { name: /collapse navigation/i })
    await expect(
      canvas.queryByRole("button", { name: /expand navigation/i }),
    ).not.toBeInTheDocument()
  },
}

/** A plain link (not a nav item) opens Connectors. The shell stays mounted, and
 * the current nav item moves from the Workspace to Connectors. */
export const PlainLinkMovesCurrentNav: Story = {
  tags: ["required"],
  render: () => (
    <AppShell>
      <Link href="/acme/connectors" className="p-6 text-sm text-teal-400">
        Connect another source
      </Link>
    </AppShell>
  ),
  parameters: {
    visual: {
      skip: "Behavior test: the page body is a test link, which the product does not render.",
    },
    review: {
      purpose:
        "App shell with the main navigation and a placeholder body link: the user clicked the link and Connectors became the current nav item.",
    },
    intent:
      "Catches a plain link in the page that does not move the current item in the main navigation. Not for nav styling or workspace list data.",
    storyRoute: {
      pattern: "flat",
      path: "/acme/ws/docs",
      alsoAt: ["/acme/connectors"],
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          conversationsListHandler(docsConversations),
          githubInstallationReposHandler(),
        ],
      },
    },
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
}

export const DocsLinkOpensProductDocs: Story = {
  parameters: {
    ...SingleWorkspace.parameters,
    visual: { skip: "Behavior test: it ends in the same state as Collapsed." },
    intent:
      "Catches a Docs link that is missing from the Help list of the main navigation. Also catches a Docs link that does not open the product docs in a new tab, or that has no name in the collapsed rail. Not for the other footer items.",
    review: {
      purpose:
        "Main navigation of an org: the nav is collapsed to the icon rail after a check of the Docs link.",
    },
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
}

export const UserMenuLinksConnectedApps: Story = {
  tags: ["required"],
  parameters: {
    visual: { allow: { contrast: "Text below WCAG AA on main (CTX-1278)." } },
    ...SingleWorkspace.parameters,
    intent:
      "Catches a user menu whose Connected apps item does not link to the connected apps page in the auth area. Not for other menu items or account data.",
    review: {
      purpose:
        "Main navigation of an org: the user menu is open with the focus on its first item.",
    },
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
}
