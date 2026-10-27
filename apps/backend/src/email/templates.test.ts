import { render } from "@react-email/render"
import { expect, it } from "vitest"

import { AccountExistsEmail } from "./templates/account-exists.js"
import { InvitationEmail } from "./templates/invitation.js"
import { ResetPasswordEmail } from "./templates/reset-password.js"
import { VerifyEmail } from "./templates/verify-email.js"

// The templates import React types only, so the backend must compile JSX
// with the automatic runtime. Each template must render its link.
it.each([
  [
    "invitation",
    InvitationEmail({
      inviteLink: "https://app.example.com/invite",
      inviterName: "Ada",
      inviterEmail: "ada@example.com",
      organizationName: "Example Org",
    }),
    "https://app.example.com/invite",
  ],
  [
    "reset password",
    ResetPasswordEmail({
      url: "https://app.example.com/reset",
      userEmail: "ada@example.com",
    }),
    "https://app.example.com/reset",
  ],
  [
    "verify email",
    VerifyEmail({
      url: "https://app.example.com/verify",
      userEmail: "ada@example.com",
    }),
    "https://app.example.com/verify",
  ],
  [
    "account-exists",
    AccountExistsEmail({
      signInUrl: "https://app.example.com/sign-in",
      resetUrl: "https://app.example.com/forgot",
      userEmail: "ada@example.com",
    }),
    "https://app.example.com/sign-in",
  ],
])("renders the %s email with its link", async (_, template, link) => {
  expect(await render(template)).toContain(link)
})
