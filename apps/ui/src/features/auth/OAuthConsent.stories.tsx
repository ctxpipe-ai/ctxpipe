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
    scopes: ["ctxpipe:read", "ctxpipe:write", "offline_access"],
    organizations,
    defaultOrganizationIds: ["org_north"],
    onAllow: fn(),
    onDeny: fn(),
  },
} satisfies Meta<typeof OAuthConsent>

export default meta

type Story = StoryObj<typeof meta>

export const ConsentOrgPicker: Story = {
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

export const ConsentWriteOffByDefault: Story = {
  tags: ["workspace-golden"],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const write = await canvas.findByRole("checkbox", {
      name: /Also allow changes/,
    })
    await expect(write).not.toBeChecked()
    await userEvent.click(canvas.getByRole("button", { name: "Allow" }))
    await expect(args.onAllow).toHaveBeenLastCalledWith(
      ["ctxpipe:read", "offline_access"],
      ["org_north"],
    )
    await userEvent.click(write)
    await userEvent.click(canvas.getByRole("button", { name: "Allow" }))
    await expect(args.onAllow).toHaveBeenLastCalledWith(
      ["ctxpipe:read", "ctxpipe:write", "offline_access"],
      ["org_north"],
    )
  },
}

export const ConsentReadOnly: Story = {
  args: { scopes: ["ctxpipe:read"] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Allow" })).toBeEnabled(),
    )
    await expect(
      canvas.queryByRole("checkbox", { name: /Also allow changes/ }),
    ).toBeNull()
  },
}

export const ConsentWriteOnly: Story = {
  args: { scopes: ["ctxpipe:write"] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement)
    const allow = await canvas.findByRole("button", { name: "Allow" })
    await expect(allow).toBeDisabled()
    await userEvent.click(
      canvas.getByRole("checkbox", { name: /Also allow changes/ }),
    )
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Allow" })).toBeEnabled(),
    )
    await userEvent.click(allow)
    await expect(args.onAllow).toHaveBeenCalledWith(
      ["ctxpipe:write"],
      ["org_north"],
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
