import type { Meta, StoryObj } from "@storybook/react-vite"
import { OrgDashboardPage } from "@/features/dashboard/OrgDashboardPage"
import { githubInstallationNoneHandler } from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"

const meta = {
  title: "Pages/Dashboard",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Start: Story = {
  render: () => <OrgDashboardPage orgSlug="acme" />,
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [githubInstallationNoneHandler],
      },
    },
  },
}
