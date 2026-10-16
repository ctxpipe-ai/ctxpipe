import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRouterState } from "@tanstack/react-router"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { organizationCreateSuccessHandler } from "@/mocks/handlers"
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

const userOnboardingCompleted = { value: false }

/**
 * A signed-in user creates another organization. The slug follows the name
 * until the user edits it. The new organization opens on Home, where the
 * Get started guide is. There is no separate setup page.
 */
export const CreateOpensHome: Story = {
  tags: ["workspace-golden"],
  render: () => <CreateOrganizationPage />,
  beforeEach: () => {
    userOnboardingCompleted.value = false
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          organizationCreateSuccessHandler(),
          http.post("*/.auth/api/v1/auth/organization/set-active", () =>
            HttpResponse.json({}),
          ),
          http.post("*/api/v1/onboarding/user/complete", () => {
            userOnboardingCompleted.value = true
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
      "Beta Team",
    )
    const slug = body.getByRole("textbox", { name: "Slug URL" })
    await expect(slug).toHaveValue("beta-team")
    await userEvent.clear(slug)
    await userEvent.type(slug, "beta")
    await userEvent.click(
      body.getByRole("button", { name: "Create organization" }),
    )
    await canvas.findByText("At /beta")
    // The guide of the new organization counts from its creation, so the
    // user's own onboarding date stays as it is.
    expect(userOnboardingCompleted.value).toBe(false)
  },
}
