import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { OnboardingCreateOrgSlide } from "@/components/onboarding/OnboardingCreateOrgSlide"
import {
  organizationCreateErrorHandler,
  organizationCreateSlowSuccessHandler,
  organizationListEmptyHandler,
  sessionSignedInOnboardingHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"

const createOrgBaseMsw = [
  sessionSignedInOnboardingHandler,
  organizationListEmptyHandler,
]

const meta = {
  title: "Components/Onboarding/Slides/CreateOrg",
  component: OnboardingCreateOrgSlide,
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-none border border-border bg-zinc-950 p-8 text-left">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "flat",
      path: "/onboarding",
    } satisfies StoryRouteParams,
  },
  args: {
    onFinish: fn(),
  },
} satisfies Meta<typeof OnboardingCreateOrgSlide>

export default meta

type Story = StoryObj<typeof meta>

export const Empty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: createOrgBaseMsw,
      },
    },
  },
}

export const ValidationError: Story = {
  parameters: {
    msw: {
      handlers: {
        page: createOrgBaseMsw,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /create organization/i }),
    )
    // The slide fades in, so wait until the message is visible.
    await waitFor(() =>
      expect(
        canvas.getByText(/enter a name for your organization/i),
      ).toBeVisible(),
    )
  },
}

export const InvalidSlug: Story = {
  parameters: {
    msw: {
      handlers: {
        page: createOrgBaseMsw,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: /organization name/i }),
      "Acme Labs",
    )
    const slug = canvas.getByRole("textbox", { name: /slug url/i })
    // The slug follows the name until the user types in it.
    await expect(slug).toHaveValue("acme-labs")
    await expect(
      canvas.getByRole("button", { name: /create organization/i }),
    ).toBeEnabled()
    await userEvent.clear(slug)
    await userEvent.type(slug, "-acme")
    await waitFor(() =>
      expect(
        canvas.getByText(/do not start or end with a hyphen/i),
      ).toBeVisible(),
    )
    await expect(
      canvas.getByRole("button", { name: /create organization/i }),
    ).toBeDisabled()
  },
}

export const CreateFailed: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [...createOrgBaseMsw, organizationCreateErrorHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: /organization name/i }),
      "Acme Labs",
    )
    await userEvent.type(
      canvas.getByRole("textbox", { name: /slug url/i }),
      "acme-labs",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /create organization/i }),
    )
    await waitFor(() =>
      expect(canvas.getByText(/failed to create organization/i)).toBeVisible(),
    )
  },
}

/** Records `set-active` calls. Create already makes the new org active. */
const setActive = fn()
export const CreatingOrganization: Story = {
  beforeEach: () => {
    setActive.mockClear()
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          ...createOrgBaseMsw,
          organizationCreateSlowSuccessHandler(),
          http.post("*/.auth/api/v1/auth/organization/set-active", () => {
            setActive()
            return HttpResponse.json({})
          }),
        ],
      },
    },
    docs: {
      description: {
        story:
          'Create uses MSW `delay("real")`, then returns success — run **Interactions** to see `onFinish` after submit.',
      },
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: /organization name/i }),
      "Acme Labs",
    )
    await userEvent.type(
      canvas.getByRole("textbox", { name: /slug url/i }),
      "acme-labs",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /create organization/i }),
    )
    await waitFor(() => expect(args.onFinish).toHaveBeenCalled(), {
      timeout: 4000,
    })
    // Each auth round trip costs seconds on a hosted deploy (ONB-2).
    await expect(setActive).not.toHaveBeenCalled()
  },
}

/** A work email prefills the name. The slug follows the name until edited. */
export const PrefilledFromWorkEmail: Story = {
  args: { userEmail: "pat@initech.io" },
  parameters: {
    msw: {
      handlers: {
        page: createOrgBaseMsw,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const name = await canvas.findByRole("textbox", {
      name: /organization name/i,
    })
    const slug = canvas.getByRole("textbox", { name: /slug url/i })
    await expect(name).toHaveValue("Initech")
    await expect(slug).toHaveValue("initech")
    await userEvent.type(name, " Labs")
    await waitFor(() =>
      expect(canvas.getByRole("textbox", { name: /slug url/i })).toHaveValue(
        "initech-labs",
      ),
    )
    await userEvent.clear(slug)
    await userEvent.type(slug, "initech-hq")
    await userEvent.type(name, " East")
    await waitFor(() =>
      expect(canvas.getByRole("textbox", { name: /slug url/i })).toHaveValue(
        "initech-hq",
      ),
    )
  },
}
