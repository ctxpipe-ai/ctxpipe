import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"
import {
  orgApiKeysListEmptyHandler,
  orgApiKeysListForbiddenHandler,
  orgApiKeysListPopulatedHandler,
  organizationFullWithOrgHandler,
  organizationListWithOrgHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OrganizationSettingsBody } from "./$orgSlug.organization.$organizationView"

const meta = {
  title: "Pages/Organisation settings",
  component: OrganizationSettingsBody,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    organizationView: "api-keys",
    organizationId: "org_storybook",
  },
} satisfies Meta<typeof OrganizationSettingsBody>

export default meta

type Story = StoryObj<typeof meta>

export const Settings: Story = {
  args: {
    organizationView: "settings",
  },
  parameters: {
    msw: {
      handlers: {
        page: [organizationListWithOrgHandler, organizationFullWithOrgHandler],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const nav = canvas.getByRole("navigation", {
      name: "Organisation settings",
    })
    await expect(nav).toHaveTextContent("Settings")
    await expect(nav).toHaveTextContent("Members")
    await expect(nav).toHaveTextContent("API Keys")
  },
}

export const ApiKeysEmpty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          organizationListWithOrgHandler,
          organizationFullWithOrgHandler,
          orgApiKeysListEmptyHandler,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const nav = canvas.getByRole("navigation", {
      name: "Organisation settings",
    })
    await expect(nav).toHaveTextContent("API Keys")
    await expect(
      await canvas.findByText("No organisation keys yet"),
    ).toBeVisible()
  },
}

export const ApiKeysPopulated: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          organizationListWithOrgHandler,
          organizationFullWithOrgHandler,
          orgApiKeysListPopulatedHandler,
        ],
      },
    },
  },
}

export const ApiKeysMemberForbidden: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          organizationListWithOrgHandler,
          organizationFullWithOrgHandler,
          orgApiKeysListForbiddenHandler,
        ],
      },
    },
  },
}
