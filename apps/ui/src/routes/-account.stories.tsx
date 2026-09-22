import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, within } from "storybook/test"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { AccountSettingsBody } from "./[.]auth.account.$accountView"

const meta = {
  title: "Pages/User account",
  component: AccountSettingsBody,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/account/api-keys",
    } satisfies StoryRouteParams,
  },
  args: {
    accountView: "api-keys",
  },
} satisfies Meta<typeof AccountSettingsBody>

export default meta

type Story = StoryObj<typeof meta>

export const ApiKeysEmpty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get("*/.auth/api/v1/auth/api-key/list", () =>
            HttpResponse.json({ apiKeys: [], total: 0 }),
          ),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText(/For your own scripts and agents\./),
    ).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Use an organisation key instead." }),
    ).toBeVisible()
    const createButton = canvas.getByRole("button", {
      name: "Create API key",
    })
    await expect(createButton).toBeVisible()
    await expect(
      createButton.closest('[data-slot="card-footer"]'),
    ).not.toBeNull()
  },
}
