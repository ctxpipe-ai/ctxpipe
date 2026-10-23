import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { Toaster } from "sonner"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  authConfigHandler,
  organizationListEmptyHandler,
  sessionSignedOutHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { InviteAcceptSignUp } from "./[.]auth.$authView"
import { DeviceAuthorizationPage } from "./[.]auth.device"
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
  render: () => <DeviceAuthorizationPage />,
  parameters: {
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
  name: "Sign-in",
  render: () => <SignInRoutePage />,
  parameters: {
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
  render: () => (
    <div className="mx-auto max-w-sm px-6 py-16">
      <InviteAcceptSignUp invitationId="invitation_1" />
    </div>
  ),
  parameters: {
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
