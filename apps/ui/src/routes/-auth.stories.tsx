import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  organizationFullWithOrgHandler,
  authConfigHandler,
  organizationListEmptyHandler,
  organizationListHandler,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
  sessionSignedOutHandler,
  signedInHandlers,
} from "@/mocks/handlers"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import preview from "../../.storybook/preview"
import { InviteAcceptSignUp } from "./[.]auth.$authView"
import { DeviceAuthorizationPage } from "./[.]auth.device"
import { ResetPasswordPage } from "./[.]auth.reset-password"
import { OAuthOrganizationSelectionRoutePage } from "./[.]auth.select-organization"
import { SignInRoutePage } from "./[.]auth.sign-in"

const meta = preview.meta({
  title: "Pages/Auth",
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    review: { kind: "page" },
  },
})

/**
 * Device sign-in screen, where a user confirms the code of a CLI or agent: the
 * session and the device code are still loading.
 */
export const DeviceLoading = meta.story({
  tags: ["page"],
  render: () => <DeviceAuthorizationPage />,
  beforeEach: ({ msw }) => {
    // These handlers come after the session of the meta, so they win: the
    // session never loads.
    msw.use(
      authConfigHandler,
      http.get("*/.auth/api/v1/auth/get-session", async () => {
        await delay("infinite")
        return HttpResponse.json(null)
      }),
      // The device code request of the device plugin (`authClient.device`).
      http.get("*/.auth/api/v1/auth/device", async () => {
        await delay("infinite")
        return HttpResponse.json({})
      }),
      // The org list of the user can load while the session loads.
      organizationListWithOrgHandler,
      organizationFullWithOrgHandler,
    )
  },
  parameters: {
    route: "/.auth/device",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/device",
      search: "?user_code=ABCD-1234",
    } satisfies StoryRouteParams,
  },
})

let deviceApprovals = 0

/**
 * Device sign-in screen opened from the CLI's link while signed in: the page
 * shows the request code and a warning to compare it with the terminal, and
 * waits for the person to press Approve or Deny. It never approves by itself.
 */
export const DevicePendingFromLink = meta.story({
  tags: ["page"],
  render: () => <DeviceAuthorizationPage />,
  beforeEach: ({ msw }) => {
    deviceApprovals = 0
    // The meta's handlers sign the user in.
    msw.use(
      authConfigHandler,
      http.get("*/.auth/api/v1/auth/device", () =>
        HttpResponse.json({ user_code: "ABCD1234", status: "pending" }),
      ),
      http.post("*/.auth/api/v1/auth/device/approve", () => {
        deviceApprovals += 1
        return HttpResponse.json({ success: true })
      }),
      organizationListWithOrgHandler,
      organizationFullWithOrgHandler,
    )
  },
  parameters: {
    route: "/.auth/device",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/device",
      search: "?user_code=ABCD-1234",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Approve" })).toBeVisible(),
    )
    await expect(canvas.getByRole("button", { name: "Deny" })).toBeVisible()
    await expect(canvas.getByText("ABCD1234")).toBeVisible()
    await expect(
      canvas.getByText(/Approve only if you started the sign-in/),
    ).toBeVisible()
    await expect(deviceApprovals).toBe(0)
  },
})

/**
 * Sign-in page, where a user signs in with email and password: the user is
 * signed out and the form is empty, with links to reset the password and to
 * sign up.
 */
export const SignIn = meta.story({
  tags: ["page"],
  name: "Sign-in",
  render: () => <SignInRoutePage />,
  beforeEach: ({ msw }) => {
    msw.use(sessionSignedOutHandler, organizationListEmptyHandler)
  },
  parameters: {
    route: "/.auth/sign-in",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/sign-in",
    } satisfies StoryRouteParams,
  },
})

/**
 * Sign-in screen, where a user signs in with email and password: the email is
 * not verified, so a notice toast says that a new link was sent. Better Auth
 * sends the link (`sendOnSignIn`) and answers 403, so the toast is a notice,
 * not an error.
 */
export const SignInUnverifiedEmail = meta.story({
  tags: ["page"],
  name: "Sign-in, unverified email",
  render: () => <SignInRoutePage />,
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster richColors position="top-center" />
      </>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(
      sessionSignedOutHandler,
      organizationListEmptyHandler,
      organizationFullWithOrgHandler,
      http.post("*/.auth/api/v1/auth/sign-in/email", () =>
        HttpResponse.json(
          { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
          { status: 403 },
        ),
      ),
    )
  },
  parameters: {
    route: "/.auth/sign-in",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/sign-in",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByLabelText("Email"),
      "member@example.com",
    )
    await userEvent.type(canvas.getByLabelText("Password"), "password-1234")
    const login = canvas.getByRole("button", { name: "Sign in" })
    await userEvent.click(login)
    await waitFor(() =>
      expect(
        within(document.body)
          .getByText(
            "Verify your email to sign in. We sent a new link to your inbox.",
          )
          .closest("[data-sonner-toast]"),
      ).toHaveAttribute("data-type", "info"),
    )
    // End with the pointer and the focus off the button, so it has no focus
    // ring and its color is the idle one.
    await userEvent.unhover(login)
    login.blur()
  },
})

/**
 * Sign-up form of an organization invitation: the email already has an account,
 * so the form tells the user to sign in. Better Auth answers 422 on a PR
 * preview, and the form does not show that code.
 */
export const InviteAcceptAccountExists = meta.story({
  render: () => (
    <div className="mx-auto max-w-sm px-6 py-16">
      <InviteAcceptSignUp invitationId="invitation_1" />
    </div>
  ),
  beforeEach: ({ msw }) => {
    msw.use(
      // Wins over the signed-in session of the meta: the invitee is new here.
      authConfigHandler,
      sessionSignedOutHandler,
      organizationListEmptyHandler,
      organizationFullWithOrgHandler,
      http.get("*/.auth/api/v1/public/invitations/:id", () =>
        HttpResponse.json({
          email: "member@example.com",
          organizationName: "Example Org",
        }),
      ),
      http.post("*/.auth/api/v1/auth/sign-up/email", () =>
        HttpResponse.json(
          {
            code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
            message: "User already exists. Use another email.",
          },
          { status: 422 },
        ),
      ),
    )
  },
  parameters: {
    review: { kind: "component" },
    storyRoute: {
      pattern: "flat",
      path: "/.auth/accept-invitation",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(await canvas.findByLabelText("Name"), "Member")
    await userEvent.type(canvas.getByLabelText("Password"), "password-1234")
    await userEvent.type(
      canvas.getByLabelText("Confirm password"),
      "password-1234",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "Create account" }),
    )
    await waitFor(() =>
      expect(
        canvas.getByText("You already have an account"),
      ).toBeInTheDocument(),
    )
    await expect(canvas.queryByText(/\b422\b/)).toBeNull()
    await expect(canvas.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      `/.auth/sign-in?redirectTo=${encodeURIComponent(
        "/.auth/accept-invitation?invitationId=invitation_1&email=member%40example.com",
      )}`,
    )
  },
})

/**
 * Reset password screen, which a reset email opens: the token is in the
 * address, and the form asks for a new password.
 */
export const ResetPassword = meta.story({
  tags: ["page"],
  name: "Reset password",
  // The form reads the token from window.location, not from the story router.
  // Without a token it leaves for sign-in.
  render: () => {
    const url = new URL(window.location.href)
    url.searchParams.set("token", "story-token")
    window.history.replaceState(null, "", url)
    return <ResetPasswordPage />
  },
  beforeEach: ({ msw }) => {
    msw.use(
      // Wins over the signed-in session of the meta: the user follows an email link.
      authConfigHandler,
      sessionSignedOutHandler,
      organizationListEmptyHandler,
      organizationFullWithOrgHandler,
    )
  },
  parameters: {
    route: "/.auth/reset-password",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/reset-password",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByLabelText("New Password")).toBeVisible(),
    )
  },
})

/**
 * OAuth page where a signed-in user picks the organization that an app such as
 * Claude can read: the user has two organizations and none is picked yet, so
 * Continue is off.
 */
export const SelectOrganization = meta.story({
  tags: ["page"],
  name: "Select organization",
  render: () => <OAuthOrganizationSelectionRoutePage />,
  beforeEach: ({ msw }) => {
    msw.use(
      authConfigHandler,
      sessionSignedInHandler({
        id: "user_storybook",
        onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
      }),
      organizationListHandler([
        { id: "org_north", name: "North Labs", slug: "north-labs" },
        {
          id: "org_harbor",
          name: "Harbor Systems",
          slug: "harbor-systems",
        },
      ]),
      organizationFullWithOrgHandler,
    )
  },
  parameters: {
    route: "/.auth/select-organization",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/select-organization",
    } satisfies StoryRouteParams,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Choose an organization" }),
      ).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByRole("radio", { name: /North Labs/ })).toBeVisible(),
    )
    await waitFor(() =>
      expect(
        canvas.getByRole("radio", { name: /Harbor Systems/ }),
      ).toBeVisible(),
    )
  },
})
