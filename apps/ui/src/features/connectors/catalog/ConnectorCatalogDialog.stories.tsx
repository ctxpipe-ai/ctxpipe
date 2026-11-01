import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { githubConnectorBootstrapHandler } from "../mocks/github-bootstrap-msw"
import type { OrgConnectionListItem } from "../queries/org-connections"
import { ConnectorCatalogDialog } from "./ConnectorCatalogDialog"
import { CONNECTOR_GROUPS, CONNECTOR_REGISTRY } from "./registry"

const orgSlug = "acme"

function connection(
  id: string,
  type: OrgConnectionListItem["type"],
  status: OrgConnectionListItem["status"],
): OrgConnectionListItem {
  return {
    id,
    type,
    displayName: null,
    status,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

const meta = {
  title: "Components/Connections/ConnectorCatalog",
  component: ConnectorCatalogDialog,
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster richColors position="top-center" />
      </>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: { pattern: "orgIndex", orgSlug } satisfies StoryRouteParams,
    msw: {
      handlers: {
        // The GitHub row reads the org's installation and the deployment's App.
        page: [
          http.get(
            ({ request }) =>
              new URL(request.url).pathname.endsWith(
                "/api/v1/github/installation",
              ),
            () => HttpResponse.json(null),
          ),
          githubConnectorBootstrapHandler({
            orgSlug,
            hostedDefaultAppInstallUrl:
              "https://github.com/apps/ctxpipe-agent/installations/new",
          }),
        ],
      },
    },
  },
  args: {
    orgSlug,
    connections: [],
    isOpen: true,
    onOpenChange: fn(),
    onOpenSetup: fn(),
    onFix: fn(),
  },
} satisfies Meta<typeof ConnectorCatalogDialog>

export default meta

type Story = StoryObj<typeof meta>

/** The org connected GitHub during onboarding and nothing else. */
export const NewOrg: Story = {
  args: {
    connections: [connection("con_gh", "github", "connected")],
  },
  play: async ({ canvasElement, args }) => {
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "Add connection",
      }),
    )
    await expect(
      dialog.getByRole("tab", { name: `All, ${CONNECTOR_REGISTRY.length}` }),
    ).toHaveAttribute("aria-selected", "true")
    await expect(
      dialog.getByRole("tab", { name: "Connected, 1" }),
    ).toBeInTheDocument()
    await expect(
      dialog.getByRole("button", { name: "Add another GitHub connection" }),
    ).toBeInTheDocument()
    const [github] = within(
      dialog.getByRole("list", { name: "All" }),
    ).getAllByRole("listitem")
    await expect(github).toHaveTextContent(/^GitHub.*Connected/)
    await userEvent.click(
      dialog.getByRole("button", { name: "Connect Buildkite" }),
    )
    await expect(args.onOpenChange).toHaveBeenCalledWith(false)
    await expect(args.onOpenSetup).toHaveBeenCalledWith({ type: "buildkite" })
  },
}

/**
 * Two Linear connections: one needs a reconnect and one has an unfinished
 * setup. The row shows the worst state and offers Fix next to Add another.
 */
export const BusyOrg: Story = {
  args: {
    connections: [
      connection("con_gh_1", "github", "connected"),
      connection("con_gh_2", "github", "connected"),
      connection("con_li_draft", "linear", "setup_pending"),
      connection("con_li_revoked", "linear", "needs_reconnect"),
      connection("con_no", "notion", "setup_pending"),
      connection("con_sl", "slack", "connected"),
    ],
  },
  play: async ({ canvasElement, args }) => {
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "Add connection",
      }),
    )
    await userEvent.click(dialog.getByRole("tab", { name: "Connected, 4" }))
    const rows = await dialog.findByRole("list", { name: "Connected" })
    await expect(
      within(rows)
        .getAllByRole("listitem")
        .map((row) => row.textContent),
    ).toEqual([
      expect.stringContaining("2 connected"),
      expect.stringContaining("Setup not finished"),
      expect.stringContaining("Needs reconnect"),
      expect.stringContaining("Connected"),
    ])
    await expect(
      dialog.getByRole("button", { name: "Fix Linear" }),
    ).toBeInTheDocument()
    await expect(
      dialog.getByRole("button", { name: "Add another Linear connection" }),
    ).toBeInTheDocument()
    await expect(
      dialog.getByRole("button", { name: "Fix Notion" }),
    ).toBeInTheDocument()
    await expect(
      dialog.queryByRole("button", { name: "Fix GitHub" }),
    ).not.toBeInTheDocument()
    await userEvent.click(dialog.getByRole("button", { name: "Fix Linear" }))
    await expect(args.onOpenChange).toHaveBeenCalledWith(false)
    await expect(args.onFix).toHaveBeenCalledWith("con_li_revoked")
  },
}

/** The planned connectors, each with "Ask for it". */
export const ComingSoon: Story = {
  play: async ({ canvasElement }) => {
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "Add connection",
      }),
    )
    const soon = CONNECTOR_REGISTRY.filter(
      (entry) => entry.availability === "coming_soon",
    )
    await userEvent.click(
      dialog.getByRole("tab", { name: `Coming soon, ${soon.length}` }),
    )
    await dialog.findByText("Tell us which one you need first.")
    for (const { name } of soon) {
      await expect(
        dialog.getByRole("button", { name: `Ask for ${name}` }),
      ).toBeInTheDocument()
    }
    await expect(
      dialog.queryByRole("button", { name: /^Connect / }),
    ).not.toBeInTheDocument()
  },
}

/** A search looks in every group, and says when nothing matches. */
export const SearchNoMatch: Story = {
  play: async ({ canvasElement }) => {
    const dialog = within(
      await within(canvasElement.ownerDocument.body).findByRole("dialog", {
        name: "Add connection",
      }),
    )
    const support = CONNECTOR_GROUPS.find((group) => group.id === "support")
    const supportCount = CONNECTOR_REGISTRY.filter(
      (entry) => entry.group === "support",
    ).length
    await userEvent.click(
      dialog.getByRole("tab", { name: `${support?.name}, ${supportCount}` }),
    )
    const search = dialog.getByRole("searchbox", { name: "Search connectors" })
    await userEvent.type(search, "incident")
    await waitFor(() =>
      expect(
        dialog.getByRole("button", { name: "Connect PagerDuty" }),
      ).toBeVisible(),
    )
    await userEvent.clear(search)
    await userEvent.type(search, "mainframe")
    await waitFor(() =>
      expect(
        dialog.getByText("No connector matches “mainframe”."),
      ).toBeVisible(),
    )
    await expect(
      dialog.queryByRole("button", { name: /^Connect / }),
    ).not.toBeInTheDocument()
  },
}

/** "Ask for it" records the request and thanks the user in a toast. */
export const AskForIt: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const dialog = within(
      await body.findByRole("dialog", { name: "Add connection" }),
    )
    await userEvent.click(
      dialog.getByRole("button", { name: "Ask for Backstage" }),
    )
    await waitFor(() =>
      expect(
        body.getByText("Thanks. We noted that you want Backstage."),
      ).toBeVisible(),
    )
  },
}
