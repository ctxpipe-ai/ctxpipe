import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useState } from "react"
import { Heading } from "react-aria-components"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { Button } from "./Button"
import { Dialog } from "./Dialog"
import { Modal } from "./Modal"

/**
 * The page grows while the modal closes, as Home does when a block opens
 * behind a closing dialog. The overlay takes the page height when it renders,
 * so each growth is a new height on the overlay one render later:
 * 1. Close grows the page. The next render closes the modal, and the overlay
 *    height changes at the start of its exit.
 * 2. The exit animation starts and the page grows again. The overlay height
 *    changes again while the exit runs.
 */
function PageGrowsDuringExit() {
  const [isOpen, setOpen] = useState(true)
  const [growth, setGrowth] = useState(0)
  useEffect(() => {
    if (growth === 1) setOpen(false)
    if (growth === 2) setGrowth(3)
  }, [growth])
  useEffect(() => {
    if (isOpen) return
    const grow = (event: AnimationEvent) => {
      if (event.animationName === "exit") setGrowth(2)
    }
    document.addEventListener("animationstart", grow, true)
    return () => document.removeEventListener("animationstart", grow, true)
  }, [isOpen])
  return (
    <div style={{ height: 2000 + growth * 1000 }}>
      <Modal isOpen={isOpen} onOpenChange={setOpen}>
        <Dialog>
          <Heading slot="title">Page grows</Heading>
          <Button onPress={() => setGrowth(1)}>Close</Button>
        </Dialog>
      </Modal>
    </div>
  )
}

const meta = {
  title: "Components/Modal",
  component: PageGrowsDuringExit,
} satisfies Meta<typeof PageGrowsDuringExit>

export default meta

type Story = StoryObj<typeof meta>

/**
 * A modal leaves the page when the page height changes during its exit. A
 * height transition on the overlay would get a cancel from the next change,
 * and React Aria then waits for it without end.
 */
export const LeavesWhenThePageGrowsDuringExit: Story = {
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole("dialog", { name: "Page grows" })
    // The enter animation ends first, so only the exit is left.
    await waitFor(() => expect(dialog.closest("[data-entering]")).toBeNull())
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    await waitFor(() =>
      expect(
        body.queryByRole("dialog", { name: "Page grows" }),
      ).not.toBeInTheDocument(),
    )
  },
}
