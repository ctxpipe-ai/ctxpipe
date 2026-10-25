import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, within } from "storybook/test"

import { InviteAcceptErrorNotice } from "./InviteAcceptErrorNotice"

const acceptPath =
  "/.auth/accept-invitation?invitationId=invitation_1&email=member%40example.com"

const meta = {
  title: "Components/Auth/InviteAcceptErrorNotice",
  component: InviteAcceptErrorNotice,
  parameters: {
    layout: "centered",
  },
  args: {
    error: { kind: "failed" },
    invitationId: "invitation_1",
    invitationEmail: "member@example.com",
    onRetry: fn(),
  },
  decorators: [
    (Story) => (
      <div className="ctx-border ctx-surface w-[22rem] px-6 py-6">
        <h2 className="mb-3 text-lg font-semibold text-zinc-100">
          Accept invitation
        </h2>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InviteAcceptErrorNotice>

export default meta

type Story = StoryObj<typeof meta>

export const AccountExists: Story = {
  args: { error: { kind: "account-exists" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("You already have an account"),
    ).toBeInTheDocument()
    await expect(canvas.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      `/.auth/sign-in?redirectTo=${encodeURIComponent(acceptPath)}`,
    )
  },
}

export const InvitationUnavailable: Story = {
  args: { error: { kind: "invitation-unavailable" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("This invitation is not available"),
    ).toBeInTheDocument()
    await expect(
      canvas.getByText(/Ask an admin of the organization/),
    ).toBeInTheDocument()
    await expect(
      canvas.getByRole("link", { name: "Go to sign in" }),
    ).toHaveAttribute("href", "/.auth/sign-in")
  },
}

export const WrongRecipient: Story = {
  args: {
    error: { kind: "wrong-recipient" },
    sessionEmail: "other@example.com",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("Signed in with a different account"),
    ).toBeInTheDocument()
    await expect(canvas.getByText("other@example.com")).toBeInTheDocument()
    await expect(
      canvas.getByRole("button", { name: "Sign out to continue" }),
    ).toBeInTheDocument()
  },
}

export const Refused: Story = {
  args: { error: { kind: "refused" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("We could not accept this invitation"),
    ).toBeInTheDocument()
    await expect(
      canvas.getByText(/Ask an admin of the organization/),
    ).toBeInTheDocument()
    await expect(
      canvas.getByRole("link", { name: "Go to sign in" }),
    ).toHaveAttribute("href", "/.auth/sign-in")
    await expect(canvas.queryByRole("button", { name: "Try again" })).toBeNull()
  },
}

export const Failed: Story = {
  args: { error: { kind: "failed" } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("We could not accept the invitation"),
    ).toBeInTheDocument()
    await expect(canvas.queryByText(/\b(4|5)\d\d\b/)).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Try again" }))
    await expect(args.onRetry).toHaveBeenCalledOnce()
  },
}
