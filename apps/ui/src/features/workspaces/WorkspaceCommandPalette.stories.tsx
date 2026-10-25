import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRouterState } from "@tanstack/react-router"
import { delay, HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { flushSync } from "react-dom"
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test"

import { workspaceListHandler } from "@/mocks/workspace-handlers"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { docsWorkspace, readOnlyWorkspace } from "./workspace-fixtures"
import { WorkspaceCommandPalette } from "./WorkspaceCommandPalette"

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
function PaletteHarness(
  props: ComponentProps<typeof WorkspaceCommandPalette> & {
    /** Re-render at once, as the app shell does when the palette opens. */
    syncRender?: boolean
  },
) {
  const { syncRender, ...paletteProps } = props
  const [isOpen, setIsOpen] = useState(props.isOpen)
  const href = useRouterState({ select: (state) => state.location.href })
  return (
    <div className="p-6">
      <button type="button" onClick={() => setIsOpen(true)}>
        Search
      </button>
      <span data-testid="location">{href}</span>
      <WorkspaceCommandPalette
        {...paletteProps}
        isOpen={isOpen}
        onOpenChange={(open) => {
          props.onOpenChange(open)
          if (syncRender) flushSync(() => setIsOpen(Boolean(open)))
          else setIsOpen(Boolean(open))
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

const liveStatus = () => within(screen.getByRole("dialog")).getByRole("status")

/** Visibility of an element, as the skeleton delay sets it. */
const visibility = (element: Element) => getComputedStyle(element).visibility

export const Open: Story = {}

export const PaletteShortcutTogglesAndRestoresFocus: Story = {
  tags: ["workspace-golden"],
  args: { isOpen: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const trigger = await canvas.findByRole("button", { name: "Search" })
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
    await expect(liveStatus()).toHaveTextContent("1 result")
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
    await expect(screen.getByText("Close")).toBeInTheDocument()
    await userEvent.type(field, "docs")
    await expect(screen.getByText("Clear")).toBeInTheDocument()
    // Tab keeps focus in the field, and Escape still clears first.
    await userEvent.keyboard("{Tab}")
    await expect(field).toHaveFocus()
    await userEvent.keyboard("{Escape}")
    await expect(field).toHaveValue("")
    await expect(screen.getByText("Close")).toBeInTheDocument()
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
    await waitFor(() =>
      expect(
        screen.getByText(/No results for/, { selector: "p" }),
      ).toHaveTextContent("No results for “zzzz-no-match”"),
    )
    await expect(liveStatus()).toHaveTextContent(
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
    const loading = await screen.findByRole("region", {
      name: "Loading workspaces",
    })
    await expect(loading).toHaveAttribute("aria-busy", "true")
    await expect(liveStatus()).toHaveTextContent("Loading workspaces")
    // The section header waits for the same delay as the bones, so the
    // region does not show a lone header over blank space.
    const header = within(loading).getByText("Workspaces")
    const bone = loading.querySelector("[data-skeleton]")
    if (!bone) throw new Error("No skeleton bone")
    await expect(visibility(header)).toBe("hidden")
    await expect(visibility(bone)).toBe("hidden")
    await waitFor(() => expect(visibility(bone)).toBe("visible"), {
      timeout: 2000,
    })
    await expect(visibility(header)).toBe("visible")
    // Pages do not need the workspace list, so they stay usable.
    await expect(
      screen.getByRole("menuitem", { name: "Home" }),
    ).toBeInTheDocument()
    await userEvent.type(await searchField(), "conn")
    await waitFor(() => expect(focusedItem()?.textContent).toBe("Connectors"))
    // Arrow keys move through the pages and wrap while the list loads.
    await userEvent.clear(await searchField())
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(focusedItem()?.textContent).toBe("Home"))
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(focusedItem()?.textContent).toBe("Connectors"))
    await userEvent.keyboard("{ArrowDown}")
    await waitFor(() => expect(focusedItem()?.textContent).toBe("Home"))
    // The empty state waits for the workspace list.
    await userEvent.clear(await searchField())
    await userEvent.type(await searchField(), "zzzz")
    await expect(
      // play-timing: ok the handler holds the list pending, so absence is the state under test
      screen.queryByText(/No results for/, { selector: "p" }),
    ).not.toBeInTheDocument()
    await expect(
      within(canvasElement).getByTestId("location"),
    ).toHaveTextContent("/acme/ws/docs?pane=files")
  },
}

export const PaletteSkeletonHandsOverOnce: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get("*/api/v1/workspaces", async () => {
            // Past the skeleton delay, so the bones show and then hold.
            await delay(1200)
            return HttpResponse.json({
              items: [docsWorkspace, readOnlyWorkspace, longNameWorkspace],
            })
          }),
        ],
      },
    },
  },
  play: async () => {
    await screen.findByRole("region", { name: "Loading workspaces" })
    await screen.findByRole("menuitem", { name: /Handbook/ }, { timeout: 4000 })
    // The list replaces the skeleton in one step: one Workspaces header.
    await expect(
      screen.queryByRole("region", { name: "Loading workspaces" }),
    ).not.toBeInTheDocument()
    await expect(screen.getAllByText("Workspaces")).toHaveLength(1)
    await expect(liveStatus()).toHaveTextContent("5 results")
  },
}

const manyWorkspaces = Array.from({ length: 20 }, (_, index) => {
  const number = String(index + 1).padStart(2, "0")
  return {
    ...docsWorkspace,
    id: `ws_team_${number}`,
    slug: `team-${number}`,
    displayName: `Team ${number}`,
  }
})

/** The active item is fully inside the scroll area of the list. */
const activeInView = () => {
  const item = focusedItem()
  const scroller = item?.closest(".overflow-y-auto")
  if (!item || !scroller) return false
  const box = item.getBoundingClientRect()
  const area = scroller.getBoundingClientRect()
  return box.top >= area.top - 1 && box.bottom <= area.bottom + 1
}

/**
 * The field points at the active item (`aria-activedescendant`), and the
 * item is in view. React Aria scrolls after it marks the item, so wait for
 * both.
 */
const expectActiveSettled = async (name?: RegExp) => {
  // A busy CI runner can take more than the default 1 s to render and
  // scroll; the wait ends as soon as both are true.
  await waitFor(
    async () => {
      const item = focusedItem()
      if (!item) throw new Error("No active item")
      if (name) expect(item.textContent).toMatch(name)
      expect((await searchField()).getAttribute("aria-activedescendant")).toBe(
        item.id,
      )
      expect(activeInView(), `${item.textContent} is in view`).toBe(true)
    },
    { timeout: 5_000 },
  )
}

const pressAndExpect = async (key: string, name: RegExp) => {
  await userEvent.keyboard(key)
  await expectActiveSettled(name)
}

export const PaletteArrowKeysWalkEveryItem: Story = {
  tags: ["workspace-golden"],
  parameters: {
    msw: { handlers: { page: [workspaceListHandler(manyWorkspaces)] } },
  },
  play: async () => {
    await screen.findByRole(
      "menuitem",
      { name: /Team 20/ },
      { timeout: 15_000 },
    )
    const field = await searchField()
    await waitFor(() => expect(field).toHaveFocus())
    // Down through each workspace, over the section boundary, to the pages.
    for (const workspace of manyWorkspaces)
      await pressAndExpect(
        "{ArrowDown}",
        new RegExp(`^${workspace.displayName}`),
      )
    await pressAndExpect("{ArrowDown}", /^Home$/)
    await pressAndExpect("{ArrowDown}", /^Connectors$/)
    // The list wraps at both ends.
    await pressAndExpect("{ArrowDown}", /^Team 01/)
    await pressAndExpect("{ArrowUp}", /^Connectors$/)
    await pressAndExpect("{ArrowUp}", /^Home$/)
    await pressAndExpect("{ArrowUp}", /^Team 20/)
    // Home and End go to the first and the last item.
    await pressAndExpect("{Home}", /^Team 01/)
    await pressAndExpect("{End}", /^Connectors$/)
    // Page keys keep an item active and do not close the dialog.
    await userEvent.keyboard("{PageUp}")
    await expectActiveSettled()
    await userEvent.keyboard("{PageDown}")
    await expectActiveSettled()
    // Tab does not leave the dialog.
    await userEvent.keyboard("{Tab}")
    await expect(field).toHaveFocus()
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}")
    await expect(field).toHaveFocus()
    // Typing after an arrow press makes the first match active.
    await userEvent.type(field, "1")
    await waitFor(() => expect(focusedItem()?.textContent).toMatch(/^Team 01/))
    await expect(screen.getByRole("dialog")).toBeInTheDocument()
  },
}

export const PaletteHoverAndKeysShareOneHighlight: Story = {
  tags: ["workspace-golden"],
  play: async () => {
    const home = await screen.findByRole("menuitem", { name: "Home" })
    // The pointer lands on the hover layer that covers the item.
    const layer = home.querySelector(".absolute")
    if (!layer) throw new Error("No hover layer")
    await userEvent.hover(layer)
    await waitFor(() => expect(focusedItem()).toBe(home))
    await userEvent.keyboard("{ArrowDown}")
    const connectors = screen.getByRole("menuitem", { name: "Connectors" })
    await waitFor(() => expect(focusedItem()).toBe(connectors))
    // The pointer is still on Home, but only the active item has a fill.
    await expect(
      screen.getByRole("menu").querySelectorAll("[data-focused]"),
    ).toHaveLength(1)
    await expect(getComputedStyle(home).backgroundColor).toBe(
      "rgba(0, 0, 0, 0)",
    )
    await expect(getComputedStyle(connectors).backgroundColor).not.toBe(
      "rgba(0, 0, 0, 0)",
    )
  },
}

export const PaletteEnterAfterDeleteRunsFirstMatch: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement }) => {
    await screen.findByRole("menuitem", { name: /Handbook/ })
    const field = await searchField()
    await userEvent.type(field, "hand")
    await waitFor(() => expect(focusedItem()?.textContent).toMatch(/^Handbook/))
    // React Aria clears the active item when text is deleted.
    await userEvent.keyboard("{Backspace}")
    await waitFor(() => expect(focusedItem()).toBeNull())
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(within(canvasElement).getByTestId("location")).toHaveTextContent(
        "/acme/ws/handbook?pane=files",
      ),
    )
  },
}

export const PaletteShortcutClosesAfterSyncRender: Story = {
  tags: ["workspace-golden"],
  args: { isOpen: false },
  render: (args) => <PaletteHarness {...args} syncRender />,
  play: async ({ canvasElement }) => {
    const trigger = await within(canvasElement).findByRole("button", {
      name: "Search",
    })
    trigger.focus()
    await userEvent.keyboard("{Meta>}k{/Meta}")
    await searchField()
    // A shortcut listener that re-registers in the same key press must not
    // open the palette again after it closes it.
    await userEvent.keyboard("{Meta>}k{/Meta}")
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    )
    await userEvent.keyboard("{Control>}k{/Control}")
    await searchField()
    await userEvent.keyboard("{Control>}k{/Control}")
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    )
    await waitFor(() => expect(trigger).toHaveFocus())
  },
}
