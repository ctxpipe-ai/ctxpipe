import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import { OnboardingInviteSlide } from "@/components/onboarding/OnboardingInviteSlide"
import {
  organizationInviteErrorHandler,
  organizationInviteSlowSuccessHandler,
  organizationInviteSuccessHandler,
  organizationListWithOrgHandler,
  sessionSignedInOnboardingHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"

const inviteBaseMsw = [
  sessionSignedInOnboardingHandler,
  organizationListWithOrgHandler,
]

const meta = {
  title: "Components/Onboarding/Slides/Invite",
  component: OnboardingInviteSlide,
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
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    userEmail: "owner@story.example",
    onCompleteOnboarding: fn(),
  },
} satisfies Meta<typeof OnboardingInviteSlide>

export default meta

type Story = StoryObj<typeof meta>

export const Empty: Story = {
  args: {
    completing: false,
  },
  parameters: {
    msw: {
      handlers: {
        page: inviteBaseMsw,
      },
    },
  },
}

export const ValidationError: Story = {
  args: {
    completing: false,
  },
  parameters: {
    msw: {
      handlers: {
        page: [...inviteBaseMsw, organizationInviteSuccessHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: /send invites/i }))
    expect(
      canvas.getByText(/add at least one valid email address/i),
    ).toBeVisible()
  },
}

export const SendingInvites: Story = {
  args: {
    completing: false,
  },
  parameters: {
    msw: {
      handlers: {
        page: [...inviteBaseMsw, organizationInviteSlowSuccessHandler()],
      },
    },
    docs: {
      description: {
        story:
          'Invite POST uses MSW `delay("real")`, then succeeds — run **Interactions** to see “Sending…” then the success banner.',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: /email/i }),
      "teammate@story.example",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send invites/i }))
    await waitFor(() =>
      expect(canvas.getByText(/sending invites/i)).toBeVisible(),
    )
    await waitFor(
      () =>
        expect(canvas.getByText(/invites sent to your team/i)).toBeVisible(),
      { timeout: 5000 },
    )
  },
}

export const SendFailed: Story = {
  args: {
    completing: false,
  },
  parameters: {
    msw: {
      handlers: {
        page: [...inviteBaseMsw, organizationInviteErrorHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: /email/i }),
      "teammate@story.example",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send invites/i }))
    await waitFor(() =>
      expect(canvas.getByText(/failed to send invites/i)).toBeVisible(),
    )
  },
}

export const InvitesSent: Story = {
  args: {
    completing: false,
  },
  parameters: {
    msw: {
      handlers: {
        page: [...inviteBaseMsw, organizationInviteSuccessHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: /email/i }),
      "teammate@story.example",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send invites/i }))
    await waitFor(() =>
      expect(canvas.getByText(/invites sent to your team/i)).toBeVisible(),
    )
  },
}

export const Completing: Story = {
  args: {
    completing: true,
  },
  parameters: {
    msw: {
      handlers: {
        page: inviteBaseMsw,
      },
    },
  },
}

export const ExternalConfirm: Story = {
  args: {
    userEmail: "owner@story.example",
    completing: false,
  },
  parameters: {
    msw: {
      handlers: {
        page: [...inviteBaseMsw, organizationInviteSuccessHandler()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByRole("textbox", { name: /email/i }),
      "outsider@other.org",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send invites/i }))
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: /invite external users/i }),
      ).toBeVisible(),
    )
  },
}
