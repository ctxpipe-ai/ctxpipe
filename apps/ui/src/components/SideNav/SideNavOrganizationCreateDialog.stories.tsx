import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRouterState } from "@tanstack/react-router"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { organizationCreateSuccessHandler } from "@/mocks/handlers"
import { activeMemberRoleHandler } from "@/mocks/workspace-sources-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { SideNavOrganizationCreateDialog } from "./SideNavOrganizationCreateDialog"

const meta = {
  title: "App/SideNav/Create organization",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

/** The dialog, with the current path so a play can see where it went. */
function CreateOrganizationPage() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  })
  const [open, setOpen] = useState(true)
  return (
    <>
      <p>At {pathname}</p>
      <SideNavOrganizationCreateDialog isOpen={open} onOpenChange={setOpen} />
    </>
  )
}

const completed = { org: false, user: false }

/**
 * A signed-in user creates another organization. The new organization opens
 * on Home, where the Get started guide is. There is no separate setup page.
 */
export const CreateOpensHome: Story = {
  tags: ["workspace-golden"],
  render: () => <CreateOrganizationPage />,
  beforeEach: () => {
    completed.org = false
    completed.user = false
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          organizationCreateSuccessHandler(),
          http.post("*/.auth/api/v1/auth/organization/set-active", () =>
            HttpResponse.json({}),
          ),
          activeMemberRoleHandler("owner"),
          http.post("*/beta/api/v1/onboarding/complete", () => {
            completed.org = true
            return HttpResponse.json({ completedAt: new Date().toISOString() })
          }),
          http.post("*/api/v1/onboarding/user/complete", () => {
            completed.user = true
            return HttpResponse.json({ completedAt: new Date().toISOString() })
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    await canvas.findByText("At /acme")
    await userEvent.type(
      await body.findByRole("textbox", { name: "Organization name" }),
      "Beta",
    )
    await userEvent.type(
      body.getByRole("textbox", { name: "Slug URL" }),
      "beta",
    )
    await userEvent.click(
      body.getByRole("button", { name: "Create organization" }),
    )
    await canvas.findByText("At /beta")
    // The owner completes the organization and keeps the guide on Home.
    await expect(completed).toEqual({ org: true, user: true })
  },
}
