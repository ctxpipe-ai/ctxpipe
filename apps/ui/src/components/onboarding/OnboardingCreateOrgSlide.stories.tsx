import type { Meta, StoryObj } from "@storybook/react-vite"
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
    onOrgCreated: fn(),
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
      canvas.getByRole("button", { name: /create organisation/i }),
    )
    expect(
      canvas.getByText(/enter a name for your organisation/i),
    ).toBeVisible()
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
      canvas.getByRole("textbox", { name: /organisation name/i }),
      "Acme Labs",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /create organisation/i }),
    )
    await waitFor(() =>
      expect(canvas.getByText(/failed to create organisation/i)).toBeVisible(),
    )
  },
}

export const CreatingOrganization: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [...createOrgBaseMsw, organizationCreateSlowSuccessHandler()],
      },
    },
    docs: {
      description: {
        story:
          'Create uses MSW `delay("real")`, then returns success — run **Interactions** to see `onOrgCreated` after submit.',
      },
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: /organisation name/i }),
      "Acme Labs",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: /create organisation/i }),
    )
    await waitFor(() => expect(args.onOrgCreated).toHaveBeenCalled(), {
      timeout: 4000,
    })
  },
}
