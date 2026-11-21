import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  orgApiKeysCreateHandler,
  orgApiKeysDeleteHandler,
  orgApiKeysListEmptyHandler,
  orgApiKeysListForbiddenHandler,
  orgApiKeysListPopulatedHandler,
  orgApiKeysUpdateHandler,
  signedInHandlers,
} from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"
import { OrganizationApiKeysCard } from "./OrganizationApiKeysCard"

const meta = preview.meta({
  title: "Components/Organization/ApiKeys",
  component: OrganizationApiKeysCard,
  decorators: [
    (Story) => (
      <div className="w-full max-w-xl p-6">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
  args: {
    organizationId: "org_storybook",
  },
})

/**
 * Organization API keys card, where an admin makes keys for CI and shared
 * agents: the org has no keys yet.
 */
export const Empty = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(orgApiKeysListEmptyHandler)
  },
})

/**
 * Organization API keys card, where an admin makes keys for CI and shared
 * agents: the org has keys in the list.
 */
export const Populated = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      orgApiKeysListPopulatedHandler,
      orgApiKeysCreateHandler(),
      orgApiKeysUpdateHandler(),
      orgApiKeysDeleteHandler(),
    )
  },
})

/**
 * Organization API keys card, where an admin makes keys for CI and shared
 * agents: the user is not an admin or owner.
 */
export const Forbidden = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(orgApiKeysListForbiddenHandler)
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Admin or owner required")).toBeVisible(),
    )
    await expect(canvas.queryByText("ci-mcp")).toBeNull()
  },
})

/**
 * Organization API keys card, where an admin makes keys for CI and shared
 * agents: a new key was made, and its secret shows once. The MSW handlers
 * reject a configId that is not `organization` (400), so a create here proves
 * that the card never uses the personal `"default"` configId.
 */
export const CreateNamedKey = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      orgApiKeysListEmptyHandler,
      orgApiKeysCreateHandler(),
      orgApiKeysUpdateHandler(),
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The card renders after the organization loads, and the key list after its skeleton.
    await waitFor(() =>
      expect(canvas.getByText(/For CI and shared agents\./)).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByText("No organization keys")).toBeVisible(),
    )
    await expect(
      canvas.getByRole("link", { name: "Use a personal key instead." }),
    ).toBeVisible()
    await userEvent.click(
      canvas.getByRole("button", { name: "Create API key" }),
    )
    // A modal renders in a portal outside the canvas element.
    const page = within(canvasElement.ownerDocument.body)
    const dialog = await page.findByRole("dialog")
    const nameField = within(dialog).getByLabelText("Name")
    await userEvent.type(nameField, "ci-mcp")
    // The select also renders a hidden native option, so query the visible button.
    // The dialog fades in, so wait for the button to show.
    await waitFor(() =>
      expect(
        within(dialog).getByRole("button", { name: /30 days/ }),
      ).toBeVisible(),
    )
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create API key" }),
    )
    // The secret modal fades in; wait until it is visible.
    const created = await page.findByText("API key created")
    await waitFor(() => expect(created).toBeVisible())
    await expect(page.getByText("org_plaintext_shown_once")).toBeVisible()
    await expect(page.getAllByText(/CTXPIPE_API_KEY/).length).toBeGreaterThan(0)
  },
})

/**
 * Organization API keys card, where an admin makes keys for CI and shared
 * agents: the admin revoked a key from the list.
 */
export const RevokeKey = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(orgApiKeysListPopulatedHandler, orgApiKeysDeleteHandler())
  },
  parameters: {
    visual: { skip: "Behavior test: it ends in the same state as Populated." },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => expect(canvas.getByText("ci-mcp")).toBeVisible())
    await userEvent.click(canvas.getByRole("button", { name: /Revoke/i }))
    // A modal renders in a portal outside the canvas element.
    const page = within(canvasElement.ownerDocument.body)
    const dialog = await page.findByRole("alertdialog")
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Revoke key" }),
    )
    // Handler only succeeds for configId=organization; errors would stay visible.
    await expect(canvas.queryByText(/Expected configId/)).toBeNull()
  },
})
