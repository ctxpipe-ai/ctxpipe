import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  authConfigHandler,
  organizationListEmptyHandler,
  organizationListHandler,
  sessionSignedInHandler,
  sessionSignedOutHandler,
} from "@/mocks/handlers"

import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { InviteAcceptSignUp } from "./[.]auth.$authView"
import { DeviceAuthorizationPage } from "./[.]auth.device"
import { ResetPasswordPage } from "./[.]auth.reset-password"
import { OAuthOrganizationSelectionRoutePage } from "./[.]auth.select-organization"
import { SignInRoutePage } from "./[.]auth.sign-in"

const meta = {
  title: "Pages/Auth",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const DeviceLoading: Story = {
  tags: ["page"],
  render: () => <DeviceAuthorizationPage />,
  parameters: {
    route: "/.auth/device",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/device?user_code=ABCD-1234",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get("*/.auth/api/v1/auth/get-session", async () => {
            await delay("infinite")
            return HttpResponse.json(null)
          }),
          http.get("*/.auth/api/v1/device-authorization/*", async () => {
            await delay("infinite")
            return HttpResponse.json({})
          }),
        ],
      },
    },
  },
}

export const SignIn: Story = {
  tags: ["page"],
  name: "Sign-in",
  render: () => <SignInRoutePage />,
  parameters: {
    route: "/.auth/sign-in",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/sign-in",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [sessionSignedOutHandler, organizationListEmptyHandler],
      },
    },
  },
}

/**
 * Sign-in with an email that is not verified. Better Auth sends a new link
 * (sendOnSignIn) and answers 403, so the toast is a notice, not an error.
 */
export const SignInUnverifiedEmail: Story = {
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
  parameters: {
    route: "/.auth/sign-in",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/sign-in",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          sessionSignedOutHandler,
          organizationListEmptyHandler,
          http.post("*/.auth/api/v1/auth/sign-in/email", () =>
            HttpResponse.json(
              { code: "EMAIL_NOT_VERIFIED", message: "Email not verified" },
              { status: 403 },
            ),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByLabelText("Email"),
      "member@example.com",
    )
    await userEvent.type(canvas.getByLabelText("Password"), "password-1234")
    await userEvent.click(canvas.getByRole("button", { name: "Login" }))
    await waitFor(() =>
      expect(
        within(document.body)
          .getByText(
            "Verify your email to sign in. We sent a new link to your inbox.",
          )
          .closest("[data-sonner-toast]"),
      ).toHaveAttribute("data-type", "info"),
    )
  },
}

/**
 * The real invitation page: sign-up for an email that already has an account
 * gets Better Auth's 422 on a PR preview, and the page says to sign in.
 */
export const InviteAcceptAccountExists: Story = {
  tags: ["page"],
  render: () => (
    <div className="mx-auto max-w-sm px-6 py-16">
      <InviteAcceptSignUp invitationId="invitation_1" />
    </div>
  ),
  parameters: {
    route: "/.auth/$authView",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/accept-invitation",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        // Replaces the preview's signed-in session: the invitee is new here.
        defaults: [
          authConfigHandler,
          sessionSignedOutHandler,
          organizationListEmptyHandler,
        ],
        page: [
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
        ],
      },
    },
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
}

/** The page that a reset-password email opens, with the token in the URL. */
export const ResetPassword: Story = {
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
  parameters: {
    route: "/.auth/reset-password",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/reset-password",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [sessionSignedOutHandler, organizationListEmptyHandler],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByLabelText("New Password")).toBeVisible(),
    )
  },
}

/** The OAuth step where a signed-in user picks the organization for the connection. */
export const SelectOrganization: Story = {
  tags: ["page"],
  name: "Select organization",
  render: () => <OAuthOrganizationSelectionRoutePage />,
  parameters: {
    route: "/.auth/select-organization",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/select-organization",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInHandler({
            id: "user_storybook",
            onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
          }),
          organizationListHandler([
            { id: "org_north", name: "North Labs", slug: "north-labs" },
            { id: "org_south", name: "South Works", slug: "south-works" },
          ]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Choose an organization" }),
      ).toBeVisible(),
    )
    await expect(
      canvas.getByRole("radio", { name: /North Labs/ }),
    ).toBeVisible()
    await expect(
      canvas.getByRole("radio", { name: /South Works/ }),
    ).toBeVisible()
  },
}
