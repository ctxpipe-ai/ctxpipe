import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import {
  organizationListEmptyHandler,
  sessionSignedOutHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
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
