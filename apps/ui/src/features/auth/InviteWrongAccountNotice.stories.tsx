import type { Meta, StoryObj } from "@storybook/react-vite"
import { InviteWrongAccountNotice } from "./InviteWrongAccountNotice"

const meta = {
  title: "Components/Auth/InviteWrongAccountNotice",
  component: InviteWrongAccountNotice,
  parameters: {
    layout: "centered",
  },
} satisfies Meta<typeof InviteWrongAccountNotice>

export default meta

type Story = StoryObj<typeof meta>

export const WrongAccount: Story = {
  args: {
    sessionEmail: "other@example.com",
    invitationEmail: "member@example.com",
    signOutHref:
      "/.auth/sign-out?redirectTo=%2F.auth%2Faccept-invitation%3FinvitationId%3Dinvitation_1",
  },
  decorators: [
    (Story) => (
      <div className="ctx-border ctx-surface w-[22rem] px-6 py-6">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">
          Join organisation
        </h2>
        <Story />
      </div>
    ),
  ],
}
