import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { Modal } from "@/components/ui/Modal"
import { AtlassianAccountClaimModalContent } from "./AtlassianAccountClaimModalContent"

const meta = {
  title: "Components/Connections/Atlassian/AccountClaim",
  component: AtlassianAccountClaimModalContent,
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AtlassianAccountClaimModalContent>

export default meta

type Story = StoryObj<typeof meta>

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

export const AccountClaimModal: Story = {
  render: () => <OpenModalTrigger />,
}

export const ContentOnly: Story = {
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
}
