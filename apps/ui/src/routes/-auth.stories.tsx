import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  authConfigHandler,
  organizationListEmptyHandler,
  sessionSignedOutHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
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

export const Default: Story = {
  render: () => <SignInRoutePage />,
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/sign-in",
    } satisfies StoryRouteParams,
    msw: {
      handlers: [
        authConfigHandler,
        sessionSignedOutHandler,
        organizationListEmptyHandler,
      ],
    },
  },
}
