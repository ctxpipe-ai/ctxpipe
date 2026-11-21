import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import { OnboardingCreateOrgSlide } from "@/components/onboarding/OnboardingCreateOrgSlide"
import {
  organizationCreateErrorHandler,
  organizationCreateSlowSuccessHandler,
  organizationListEmptyHandler,
  organizationSetActiveHandler,
  sessionSignedInOnboardingHandler,
  signedInHandlers,
} from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import preview from "../../../.storybook/preview"

const createOrgBaseMsw = [
  sessionSignedInOnboardingHandler,
  organizationListEmptyHandler,
]

const meta = preview.meta({
  title: "Components/Onboarding/Slides/CreateOrg",
  component: OnboardingCreateOrgSlide,
  decorators: [
    (Story) => (
      <div className="max-w-xl rounded-none border border-border bg-zinc-950 p-8 text-left">
        <Story />
      </div>
    ),
  ],
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers)
  },
  parameters: {
    app: "root",
    layout: "centered",
    storyRoute: {
      pattern: "flat",
      path: "/onboarding",
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
  args: {
    onFinish: fn(),
  },
})

/**
 * Onboarding slide where a new user creates the first organization: the form is
 * empty.
 */
export const Empty = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...createOrgBaseMsw)
  },
})

/**
 * Onboarding slide where a new user creates the first organization: the user
 * submitted with no name, and the form asks for one.
 */
export const ValidationError = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...createOrgBaseMsw)
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
})

/**
 * Onboarding slide where a new user creates the first organization: the slug
 * starts with a hyphen, and the create button is disabled.
 */
export const InvalidSlug = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...createOrgBaseMsw)
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
})

/**
 * Onboarding slide where a new user creates the first organization: the create
 * request failed, and an error shows.
 */
export const CreateFailed = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...createOrgBaseMsw, organizationCreateErrorHandler())
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
})

/** Records `set-active` calls. Create already makes the new org active. */
const setActive = fn()
/**
 * Onboarding slide where a new user creates the first organization: the slow
 * create request succeeded and the slide finished.
 */
export const CreatingOrganization = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      ...createOrgBaseMsw,
      organizationCreateSlowSuccessHandler(),
      organizationSetActiveHandler(setActive),
    )

    setActive.mockClear()
  },
  parameters: {
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
})

/**
 * Onboarding slide where a new user creates the first organization: a work
 * email filled the name, and the user then edited the slug. The slug follows
 * the name until the user edits it, and then the slug stays.
 */
export const PrefilledFromWorkEmail = meta.story({
  args: { userEmail: "pat@initech.io" },
  beforeEach: ({ msw }) => {
    msw.use(...createOrgBaseMsw)
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
})
