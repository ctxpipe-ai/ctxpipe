import { useState } from "react"

import { Modal } from "@/components/ui/Modal"

import preview from "../../../../.storybook/preview"
import { AtlassianAccountClaimModalContent } from "./AtlassianAccountClaimModalContent"

const meta = preview.meta({
  title: "Components/Connections/Atlassian/AccountClaim",
  component: AtlassianAccountClaimModalContent,
  parameters: {
    layout: "padded",
    review: { kind: "component" },
  },
})

function OpenModalTrigger() {
  const [open, setOpen] = useState(true)
  return (
    <>
      <Modal isOpen={open} onOpenChange={setOpen} isDismissable>
        <AtlassianAccountClaimModalContent
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      </Modal>
      <p className="text-sm text-muted-foreground">
        Modal opens by default; dismiss or use buttons to close.
      </p>
    </>
  )
}

/**
 * Modal that asks a user to take over an Atlassian account linked to another
 * user: the modal is open over the page.
 */
export const AccountClaimModal = meta.story({
  render: () => <OpenModalTrigger />,
})

/**
 * Modal that asks a user to take over an Atlassian account linked to another
 * user: the modal content alone in a card, with no overlay.
 */
export const ContentOnly = meta.story({
  parameters: {
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="max-w-[min(90vw,450px)] rounded-none border border-border bg-card/95 text-left shadow-2xl">
        <Story />
      </div>
    ),
  ],
  args: {
    onCancel: () => {},
    onConfirm: () => {},
  },
})
