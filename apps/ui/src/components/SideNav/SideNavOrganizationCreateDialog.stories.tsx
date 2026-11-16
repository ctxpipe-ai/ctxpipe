import type { Meta, StoryObj } from "@storybook/react-vite"
import { useRouterState } from "@tanstack/react-router"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"

import {
  organizationCreateSuccessHandler,
  organizationSetActiveHandler,
} from "@/mocks/handlers"

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
    review: { kind: "component" },
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
  tags: ["required"],
  render: () => <CreateOrganizationPage />,
  beforeEach: () => {
    userOnboardingCompleted.value = false
  },
  parameters: {
    visual: {
      skip: "Behavior test: it ends on a story route marker, which the product does not render.",
    },
    intent:
      "Catches organization creation that does not open the new organization home, or that marks the user's own onboarding as complete. Not for form validation or slug rules.",
    msw: {
      handlers: {
        page: [
          organizationCreateSuccessHandler(),
          organizationSetActiveHandler(),
          http.post("*/api/v1/onboarding/user/complete", () => {
            userOnboardingCompleted.value = true
            return HttpResponse.json({ completedAt: new Date().toISOString() })
          }),
        ],
      },
    },
    review: {
      purpose:
        "Dialog where a signed-in user creates another organization: the user edits the slug, creates the org, and the app opens its Home.",
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
