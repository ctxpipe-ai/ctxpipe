import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useState } from "react"
import { Heading } from "react-aria-components"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { Button } from "./Button"
import { Dialog } from "./Dialog"
import { Modal } from "./Modal"

/**
 * Closes the modal as soon as its enter animation starts, as a fast request
 * does when it ends before the 100 ms enter animation.
 */
function CloseDuringEnter() {
  const [isOpen, setOpen] = useState(false)
  const [closedDuringEnter, setClosedDuringEnter] = useState(false)
  useEffect(() => {
    if (!isOpen) return
    const close = (event: AnimationEvent) => {
      if (event.animationName !== "enter") return
      setOpen(false)
      setClosedDuringEnter(true)
    }
    document.addEventListener("animationstart", close, true)
    return () => document.removeEventListener("animationstart", close, true)
  }, [isOpen])
  return (
    <>
      <Button onPress={() => setOpen(true)}>Open</Button>
      {closedDuringEnter ? <p>Closed during enter</p> : null}
      <Modal isOpen={isOpen} onOpenChange={setOpen}>
        <Dialog>
          <Heading slot="title">Closes while it enters</Heading>
        </Dialog>
      </Modal>
    </>
  )
}

const meta = {
  title: "Components/Modal",
  component: CloseDuringEnter,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof CloseDuringEnter>

export default meta

type Story = StoryObj<typeof meta>

/** A modal that closes during its enter animation leaves the page. */
export const ClosesDuringEnter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(canvas.getByRole("button", { name: "Open" }))
    await canvas.findByText("Closed during enter")
    await waitFor(() =>
      expect(
        body.queryByRole("dialog", { name: "Closes while it enters" }),
      ).not.toBeInTheDocument(),
    )
  },
}
