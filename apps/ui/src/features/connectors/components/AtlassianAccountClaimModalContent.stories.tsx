import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { Modal } from "@/components/ui/Modal"
import { AtlassianAccountClaimModalContent } from "./AtlassianAccountClaimModalContent"

const meta = {
  title: "Components/Connections/AtlassianAccountClaimModal",
  component: AtlassianAccountClaimModalContent,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof AtlassianAccountClaimModalContent>

export default meta

type Story = StoryObj<typeof meta>

function OpenModalTrigger() {
  const [open, setOpen] = useState(true)
  return (
    <div className="min-h-[50vh] bg-zinc-950 p-6">
      <Modal isOpen={open} onOpenChange={setOpen} isDismissable>
        <AtlassianAccountClaimModalContent
          onCancel={() => setOpen(false)}
          onConfirm={() => setOpen(false)}
        />
      </Modal>
      <p className="text-sm text-zinc-500">
        Modal opens by default; dismiss or use buttons to close.
      </p>
    </div>
  )
}

export const Default: Story = {
  render: () => <OpenModalTrigger />,
}

export const ContentOnly: Story = {
  name: "Content (no overlay)",
  decorators: [
    (Story) => (
      <div className="max-w-[min(90vw,450px)] rounded-none border border-zinc-800 bg-zinc-950/95 text-left shadow-2xl">
        <Story />
      </div>
    ),
  ],
  args: {
    onCancel: () => {},
    onConfirm: () => {},
  },
}
