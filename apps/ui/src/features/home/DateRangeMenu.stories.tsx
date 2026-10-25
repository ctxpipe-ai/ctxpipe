import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { DateRangeMenu } from "./WorkspaceActivity"

const meta = {
  title: "Components/Home/Date range menu",
  component: DateRangeMenu,
  parameters: { layout: "fullscreen" },
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

/** The trigger is far from the bottom: the menu opens below. */
export const TriggerHigh: Story = {
  render: () => <AtHeight fromBottom={400} />,
  play: ({ canvasElement }) => expectWholeMenuInView(canvasElement),
}

/** Not enough room below for the whole menu: it opens above. */
export const TriggerNearBottom: Story = {
  render: () => <AtHeight fromBottom={200} />,
  play: ({ canvasElement }) => expectWholeMenuInView(canvasElement),
}

/** A little higher than that: still not enough room below. */
export const TriggerNearBottomHigher: Story = {
  render: () => <AtHeight fromBottom={225} />,
  play: ({ canvasElement }) => expectWholeMenuInView(canvasElement),
}

/** Little room below and plenty above. */
export const TriggerWellInsideBottom: Story = {
  render: () => <AtHeight fromBottom={150} />,
  play: ({ canvasElement }) => expectWholeMenuInView(canvasElement),
}

/** The user chose a start date and has not chosen the end date yet. */
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
