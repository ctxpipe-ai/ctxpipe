import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { DateRangeMenu } from "./WorkspaceActivity"

const meta = {
  title: "Components/Home/Date range menu",
  component: DateRangeMenu,
  parameters: {
    review: { kind: "component" },
    layout: "fullscreen",
  },
  args: { since: undefined, until: undefined, onRangeChange: () => {} },
} satisfies Meta<typeof DateRangeMenu>

export default meta

type Story = StoryObj<typeof meta>

/** Opens the menu and checks that the whole menu is in view, above or below the trigger. */
async function expectWholeMenuInView(canvasElement: HTMLElement) {
  const page = within(canvasElement.ownerDocument.body)
  await userEvent.click(
    await page.findByRole("button", { name: /Filter commits by date/ }),
  )
  const dialog = await page.findByRole("dialog", { name: "Date range" })
  await page.findByText("Custom range")
  await document.fonts.ready
  await waitFor(() => {
    const popover = dialog.closest("[data-trigger]")
    if (!popover) throw new Error("No popover")
    const box = popover.getBoundingClientRect()
    expect(box.top).toBeGreaterThanOrEqual(0)
    expect(box.bottom).toBeLessThanOrEqual(window.innerHeight)
    expect(popover.scrollHeight).toBeLessThanOrEqual(popover.clientHeight + 1)
  })
}

function AtHeight(props: { fromBottom: number }) {
  return (
    <div className="fixed right-16" style={{ bottom: props.fromBottom }}>
      <DateRangeMenu
        since={undefined}
        until={undefined}
        onRangeChange={() => {}}
      />
    </div>
  )
}

/**
 * Date range menu that filters recent commits: the trigger is far from the
 * bottom of the window, so the menu opens below it.
 */
export const TriggerHigh: Story = {
  render: () => <AtHeight fromBottom={400} />,
  play: ({ canvasElement }) => expectWholeMenuInView(canvasElement),
}

/**
 * Date range menu that filters recent commits: the trigger is near the bottom,
 * and there is not sufficient room below for the whole menu. The menu opens
 * above it.
 */
export const TriggerNearBottom: Story = {
  render: () => <AtHeight fromBottom={200} />,
  play: ({ canvasElement }) => expectWholeMenuInView(canvasElement),
}

/**
 * Date range menu that filters recent commits: the trigger is a little higher
 * than near the bottom, but there is still not sufficient room below. The menu
 * opens above it.
 */
export const TriggerNearBottomHigher: Story = {
  parameters: {
    visual: {
      skip: "The screenshot crops a component story to the menu, so it equals TriggerNearBottom. The play checks that the whole menu is in view.",
    },
  },
  render: () => <AtHeight fromBottom={225} />,
  play: ({ canvasElement }) => expectWholeMenuInView(canvasElement),
}

/**
 * Date range menu that filters recent commits: the trigger is very near the
 * bottom, with little room below and much room above. The menu opens above it
 * in full.
 */
export const TriggerWellInsideBottom: Story = {
  parameters: {
    visual: {
      skip: "The screenshot crops a component story to the menu, so it equals TriggerNearBottom. The play checks that the whole menu is in view.",
    },
  },
  render: () => <AtHeight fromBottom={150} />,
  play: ({ canvasElement }) => expectWholeMenuInView(canvasElement),
}

/**
 * Date range menu with its calendar open: the user chose a start day and has
 * not chosen the end day yet. The pointer stays on the start cell, and the
 * hover does not hide its text.
 */
export const StartChosenEndPending: Story = {
  render: () => <AtHeight fromBottom={400} />,
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body)
    await userEvent.click(
      await page.findByRole("button", { name: /Filter commits by date/ }),
    )
    await userEvent.click(
      await page.findByRole("button", { name: /calendar/i }),
    )
    const start = await page.findAllByRole("button", { name: /\b6\b/ })
    await userEvent.click(start[0])
    // The pointer still rests on the start cell: hover must not hide its text.
    await waitFor(() => {
      const cell = canvasElement.ownerDocument.querySelector(
        "[data-selection-start]",
      )
      if (!cell) throw new Error("No selected start cell")
      expect(cell).toHaveClass("text-zinc-950")
      expect(cell).not.toHaveClass("data-[hovered]:bg-zinc-800")
    })
  },
}
