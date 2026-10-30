import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { OAuthConsent } from "./OAuthConsent"

const organizations = [
  { id: "org_north", name: "North Labs", slug: "north-labs" },
  { id: "org_south", name: "South Works", slug: "south-works" },
]

const meta = {
  title: "Components/Auth/OAuth Consent",
  component: OAuthConsent,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "flat",
      path: "/.auth/consent",
    } satisfies StoryRouteParams,
  },
  args: {
    clientId: "claude-plugin",
    scopes: ["ctxpipe:read", "offline_access"],
    organizations,
    defaultOrganizationIds: ["org_north"],
    onAllow: fn(),
    onDeny: fn(),
  },
} satisfies Meta<typeof OAuthConsent>

export default meta

type Story = StoryObj<typeof meta>

export const ConsentOrgPicker: Story = {
  parameters: {
    intent:
      "Catches an OAuth consent screen that does not tick the current organization, or does not send the chosen organizations on Allow. Not for scope text or sign-in.",
  },
  tags: ["workspace-golden"],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const north = await canvas.findByRole("checkbox", { name: /North Labs/ })
    const south = canvas.getByRole("checkbox", { name: /South Works/ })
    // The current org is ticked; the other org is not.
    await expect(north).toBeChecked()
    await expect(south).not.toBeChecked()
    await userEvent.click(south)
    await userEvent.click(canvas.getByRole("button", { name: "Allow" }))
    await expect(args.onAllow).toHaveBeenCalledWith(
      ["ctxpipe:read", "offline_access"],
      ["org_north", "org_south"],
    )
  },
}

export const ConsentNeedsOneOrg: Story = {
  parameters: {
    intent:
      "Catches consent that allows access with no organization selected. Allow stays disabled and shows a message. Not for scope choice or the organization list.",
  },
  tags: ["workspace-golden"],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("checkbox", { name: /North Labs/ }),
    )
    await expect(
      canvas.getByText("Select at least one organization."),
    ).toBeVisible()
    const allow = canvas.getByRole("button", { name: "Allow" })
    await expect(allow).toBeDisabled()
    await userEvent.click(allow)
    await expect(args.onAllow).not.toHaveBeenCalled()
  },
}

export const ConsentReadOnly: Story = {
  args: { scopes: ["ctxpipe:read"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Allow" })).toBeEnabled(),
    )
  },
}

export const ConsentOrgsUnavailable: Story = {
  args: { organizations: [], defaultOrganizationIds: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Organizations unavailable")).toBeVisible(),
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Allow" })).toBeDisabled(),
    )
  },
}
