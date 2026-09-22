import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
import {
  orgApiKeysCreateHandler,
  orgApiKeysDeleteHandler,
  orgApiKeysListEmptyHandler,
  orgApiKeysListForbiddenHandler,
  orgApiKeysListPopulatedHandler,
  orgApiKeysUpdateHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { OrganizationApiKeysCard } from "./OrganizationApiKeysCard"

const meta = {
  title: "Components/Organization/ApiKeys",
  component: OrganizationApiKeysCard,
  decorators: [
    (Story) => (
      <div className="w-full max-w-xl p-6">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    organizationId: "org_storybook",
  },
} satisfies Meta<typeof OrganizationApiKeysCard>

export default meta

type Story = StoryObj<typeof meta>

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [orgApiKeysListEmptyHandler],
      },
    },
  },
}

export const Populated: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          orgApiKeysListPopulatedHandler,
          orgApiKeysCreateHandler(),
          orgApiKeysUpdateHandler(),
          orgApiKeysDeleteHandler(),
        ],
      },
    },
  },
}

export const Forbidden: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [orgApiKeysListForbiddenHandler],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText("Admin or owner required"),
    ).toBeVisible()
    await expect(canvas.queryByText("ci-mcp")).toBeNull()
  },
}

/**
 * MSW org-key handlers reject any non-`organization` configId (400). A
 * successful create/revoke here proves the card never mint/lists/revokes with
 * the personal `"default"` configId.
 */
export const CreateNamedKey: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          orgApiKeysListEmptyHandler,
          orgApiKeysCreateHandler(),
          orgApiKeysUpdateHandler(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText(/For CI and shared agents\./)).toBeVisible()
    await expect(canvas.getByText("No organisation keys")).toBeVisible()
    await expect(
      canvas.getByRole("link", { name: "Use a personal key instead." }),
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Create API key" }),
    )
    const dialog = await canvas.findByRole("dialog")
    const nameField = within(dialog).getByLabelText("Name")
    await userEvent.type(nameField, "ci-mcp")
    await expect(within(dialog).getByText("30 days")).toBeVisible()
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create API key" }),
    )
    await expect(await canvas.findByText("API key created")).toBeVisible()
    await expect(canvas.getByText("org_plaintext_shown_once")).toBeVisible()
    await expect(canvas.getAllByText(/CTXPIPE_API_KEY/).length).toBeGreaterThan(
      0,
    )
  },
}

export const RevokeKey: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [orgApiKeysListPopulatedHandler, orgApiKeysDeleteHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText("ci-mcp")).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: /Revoke/i }))
    const dialog = await canvas.findByRole("alertdialog")
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke key" }),
    )
    // Handler only succeeds for configId=organization; errors would stay visible.
    await expect(canvas.queryByText(/Expected configId/)).toBeNull()
  },
}
