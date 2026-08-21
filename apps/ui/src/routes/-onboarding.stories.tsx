import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import {
  organizationListEmptyHandler,
  sessionSignedInOnboardingHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OnboardingPageContent } from "./onboarding"

const meta = {
  title: "Pages/Onboarding",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "flat",
      path: "/onboarding",
    } satisfies StoryRouteParams,
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  render: () => <OnboardingPageContent urlOrgSlug={null} />,
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get("*/.auth/api/v1/auth/get-session", async () => {
            await delay("infinite")
            return HttpResponse.json(null)
          }),
          http.get("*/.auth/api/v1/auth/organization/list", async () => {
            await delay("infinite")
            return HttpResponse.json([])
          }),
        ],
      },
    },
  },
}

/** New admin user, no organisation yet — welcome slide in the carousel. */
export const AdminFlowWelcome: Story = {
  render: () => <OnboardingPageContent urlOrgSlug={null} />,
  parameters: {
    msw: {
      handlers: {
        page: [sessionSignedInOnboardingHandler, organizationListEmptyHandler],
      },
    },
  },
}
