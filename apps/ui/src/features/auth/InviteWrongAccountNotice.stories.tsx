import preview from "../../../.storybook/preview"
import { InviteWrongAccountNotice } from "./InviteWrongAccountNotice"

const meta = preview.meta({
  title: "Components/Auth/InviteWrongAccountNotice",
  component: InviteWrongAccountNotice,
  parameters: {
    layout: "centered",
    review: { kind: "component" },
  },
})

/**
 * Notice on the join organization card: the user is signed in with an email
 * other than the invited one.
 */
export const WrongAccount = meta.story({
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
          Join organization
        </h2>
        <Story />
      </div>
    ),
  ],
})
