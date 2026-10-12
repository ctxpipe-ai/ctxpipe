import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRouterState } from "@tanstack/react-router"
import { delay, HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceCommandPalette } from "./WorkspaceCommandPalette"
import { docsWorkspace, readOnlyWorkspace } from "./workspace-fixtures"

const longNameWorkspace = {
  ...docsWorkspace,
  id: "ws_long",
  slug: "platform-infrastructure-runbooks-and-incident-reviews",
  displayName:
    "Platform infrastructure runbooks, incident reviews and on-call guide",
}

/**
 * Owns the open state like `SideNav` does, with a trigger so a play can
 * check that focus goes back to it, and the router location so a play can
 * check that `?pane=` stays.
 */
function PaletteHarness(props: ComponentProps<typeof WorkspaceCommandPalette>) {
  const [isOpen, setIsOpen] = useState(props.isOpen)
  const href = useRouterState({ select: (state) => state.location.href })
  return (
    <div className="p-6">
      <button type="button" onClick={() => setIsOpen(true)}>
        Search
      </button>
      <output data-testid="location">{href}</output>
      <WorkspaceCommandPalette
        {...props}
        isOpen={isOpen}
        onOpenChange={(open) => {
          props.onOpenChange(open)
          setIsOpen(Boolean(open))
        }}
      />
    </div>
  )
}

const meta = {
  title: "Components/Workspaces/CommandPalette",
  component: WorkspaceCommandPalette,
  decorators: entryPageInnerDecorators,
  render: (args) => <PaletteHarness {...args} />,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      pane: "files",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([
            docsWorkspace,
            readOnlyWorkspace,
            longNameWorkspace,
          ]),
        ],
      },
    },
  },
  args: {
    orgSlug: "acme",
    isOpen: true,
    onOpenChange: fn(),
    onSelectNav: fn(),
  },
} satisfies Meta<typeof WorkspaceCommandPalette>

export default meta

type Story = StoryObj<typeof meta>

const searchField = () =>
  screen.findByRole("searchbox", { name: "Search workspaces and pages" })

const focusedItem = () =>
  screen.getByRole("menu", { name: "Results" }).querySelector("[data-focused]")

export const Open: Story = {}

export const PaletteShortcutTogglesAndRestoresFocus: Story = {
  tags: ["workspace-golden"],
  args: { isOpen: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = canvas.getByRole("button", { name: "Search" })
    trigger.focus()
    await userEvent.keyboard("{Meta>}k{/Meta}")
    const field = await searchField()
    await waitFor(() => expect(field).toHaveFocus())
    await expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument()
    await userEvent.keyboard("{Control>}k{/Control}")
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(trigger).toHaveFocus())
  },
}

export const PaletteFiltersAtOnce: Story = {
  tags: ["workspace-golden"],
  play: async () => {
    await screen.findByRole("menuitem", { name: /Handbook/ })
    await userEvent.type(await searchField(), "hand")
    const menu = screen.getByRole("menu", { name: "Results" })
    await waitFor(() =>
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Handbookhandbook"]),
    )
    // The slug matches too, and the first match is active for Enter.
    await userEvent.clear(await searchField())
    await userEvent.type(await searchField(), "runbooks")
    await waitFor(() =>
      expect(focusedItem()?.textContent).toMatch(/^Platform infrastructure/),
    )
  },
}

export const PaletteArrowKeysAndEnterKeepPane: Story = {
  tags: ["workspace-golden"],
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await screen.findByRole("menuitem", { name: /Handbook/ })
    const field = await searchField()
    await waitFor(() => expect(field).toHaveFocus())
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(focusedItem()?.textContent).toMatch(/^Docs/))
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(focusedItem()?.textContent).toMatch(/^Handbook/))
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(canvas.getByTestId("location")).toHaveTextContent(
        "/acme/ws/handbook?pane=files",
      ),
    )
    await expect(args.onSelectNav).toHaveBeenCalledWith({
      orgSlug: "acme",
      primary: "workspace",
      workspaceSlug: "handbook",
    })
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    )
  },
}

export const PaletteEscapeClearsThenCloses: Story = {
  tags: ["workspace-golden"],
  play: async ({ args }) => {
    const field = await searchField()
    await userEvent.type(field, "docs")
    await userEvent.keyboard("{Escape}")
    await expect(field).toHaveValue("")
    await expect(screen.getByRole("dialog")).toBeInTheDocument()
    await userEvent.keyboard("{Escape}")
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    )
    await expect(args.onOpenChange).toHaveBeenLastCalledWith(false)
  },
}

export const PaletteNoResults: Story = {
  tags: ["workspace-golden"],
  play: async () => {
    await screen.findByRole("menuitem", { name: /Handbook/ })
    await userEvent.type(await searchField(), "zzzz-no-match")
    await expect(await screen.findByText(/No results for/)).toHaveTextContent(
      "No results for “zzzz-no-match”",
    )
    await expect(
      screen.queryByRole("menuitem", { name: /Docs|Handbook|Home/ }),
    ).not.toBeInTheDocument()
  },
}

export const PaletteLoadingKeepsPages: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get("*/api/v1/workspaces", async () => {
            await delay("infinite")
            return HttpResponse.json({ items: [] })
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(
      await screen.findByRole("region", { name: "Loading workspaces" }),
    ).toHaveAttribute("aria-busy", "true")
    // Pages do not need the workspace list, so they stay usable.
    await expect(
      screen.getByRole("menuitem", { name: "Home" }),
    ).toBeInTheDocument()
    await userEvent.type(await searchField(), "conn")
    await waitFor(() => expect(focusedItem()?.textContent).toBe("Connectors"))
    // The empty state waits for the workspace list.
    await userEvent.clear(await searchField())
    await userEvent.type(await searchField(), "zzzz")
    await expect(screen.queryByText(/No results for/)).not.toBeInTheDocument()
    await expect(
      within(canvasElement).getByTestId("location"),
    ).toHaveTextContent("/acme/ws/docs?pane=files")
  },
}
