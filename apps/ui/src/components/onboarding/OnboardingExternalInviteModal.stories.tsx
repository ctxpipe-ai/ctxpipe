import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn } from "storybook/test"
import { OnboardingExternalInviteModal } from "@/components/onboarding/OnboardingExternalInviteModal"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"

const meta = {
  title: "Components/Onboarding/ExternalInviteModal",
  component: OnboardingExternalInviteModal,
  decorators: [...entryPageInnerDecorators],
  parameters: {
    layout: "centered",
  },
  args: {
    onOpenChange: fn(),
    onCancel: fn(),
    onConfirmSend: fn(),
  },
} satisfies Meta<typeof OnboardingExternalInviteModal>

export default meta

type Story = StoryObj<typeof meta>

export const SingleRecipient: Story = {
  args: {
    isOpen: true,
    pendingExternalRecipients: ["pat@other.com"],
  },
}

export const MultipleRecipients: Story = {
  args: {
    isOpen: true,
    pendingExternalRecipients: ["a@ext.com", "b@ext.com", "c@ext.com"],
  },
}

export const LongList: Story = {
  args: {
    isOpen: true,
    pendingExternalRecipients: Array.from(
      { length: 12 },
      (_, i) => `user${i}@external.example`,
    ),
  },
}

export const Closed: Story = {
  args: {
    isOpen: false,
    pendingExternalRecipients: ["pat@other.com"],
  },
}
