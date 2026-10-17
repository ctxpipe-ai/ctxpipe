import type { Meta, StoryObj } from "@storybook/react-vite"
import { useParams } from "@tanstack/react-router"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { PageBodySkeleton } from "@/components/ui/Skeleton"
import {
  orgApiKeysListEmptyHandler,
  orgApiKeysListForbiddenHandler,
  orgApiKeysListPopulatedHandler,
  organizationFullWithOrgHandler,
  organizationListWithOrgHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import {
  OrganizationSettingsBody,
  OrganizationSettingsShell,
} from "./$orgSlug.organization.$organizationView"

const meta = {
  title: "Pages/Organization settings",
  component: OrganizationSettingsBody,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    organizationView: "api-keys",
    organizationId: "org_storybook",
  },
} satisfies Meta<typeof OrganizationSettingsBody>

export default meta

type Story = StoryObj<typeof meta>

export const Settings: Story = {
  args: {
    organizationView: "settings",
  },
  parameters: {
    msw: {
      handlers: {
        page: [organizationListWithOrgHandler, organizationFullWithOrgHandler],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The nav shows after the organization loads.
    const nav = await canvas.findByRole("navigation", {
      name: "Organization settings",
    })
    await expect(nav).toHaveTextContent("Settings")
    await expect(nav).toHaveTextContent("Members")
    await expect(nav).toHaveTextContent("API Keys")
  },
}

export const ApiKeysEmpty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          organizationListWithOrgHandler,
          organizationFullWithOrgHandler,
          orgApiKeysListEmptyHandler,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The nav shows after the organization loads.
    const nav = await canvas.findByRole("navigation", {
      name: "Organization settings",
    })
    await expect(nav).toHaveTextContent("API Keys")
    await waitFor(() =>
      expect(canvas.getByText("No organization keys")).toBeVisible(),
    )
  },
}

export const ApiKeysPopulated: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          organizationListWithOrgHandler,
          organizationFullWithOrgHandler,
          orgApiKeysListPopulatedHandler,
        ],
      },
    },
  },
}

export const ApiKeysMemberForbidden: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          organizationListWithOrgHandler,
          organizationFullWithOrgHandler,
          orgApiKeysListForbiddenHandler,
        ],
      },
    },
  },
}

const subPageHandlers = [
  organizationListWithOrgHandler,
  organizationFullWithOrgHandler,
  orgApiKeysListEmptyHandler,
]

/** The frame that every sub-page and the loading state share. */
function expectedFrame(canvasElement: HTMLElement) {
  const main = canvasElement.querySelector("main")
  if (!main) throw new Error("Organization settings frame is missing")
  const rem = Number.parseFloat(
    getComputedStyle(canvasElement.ownerDocument.documentElement).fontSize,
  )
  const main_ = main.getBoundingClientRect()
  const padding = Number.parseFloat(getComputedStyle(main).paddingLeft)
  const title = main.querySelector("h1")?.getBoundingClientRect()
  const nav = main.querySelector("nav")?.getBoundingClientRect()
  return {
    // `max-w-4xl` is 56rem.
    mainWidth: Math.min(56 * rem, canvasElement.ownerDocument.body.clientWidth),
    actualMainWidth: main_.width,
    titleLeft: main_.left + padding,
    title,
    nav,
  }
}

function expectSharedFrame(canvasElement: HTMLElement) {
  const frame = expectedFrame(canvasElement)
  expect(frame.actualMainWidth).toBeCloseTo(frame.mainWidth, 0)
  expect(frame.title?.left).toBeCloseTo(frame.titleLeft, 0)
  expect(frame.nav?.left).toBeCloseTo(frame.titleLeft, 0)
}

/** Moves between sub-pages with the real sub-menu. The frame stays the same. */
export const SubPagesKeepOnePosition: Story = {
  parameters: {
    storyRoute: {
      pattern: "orgOrganizationView",
      orgSlug: "acme",
      view: "settings",
    } satisfies StoryRouteParams,
    msw: { handlers: { page: subPageHandlers } },
  },
  render: (args) => {
    const { organizationView } = useParams({ strict: false })
    return (
      <OrganizationSettingsBody
        {...args}
        organizationView={organizationView ?? args.organizationView}
      />
    )
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await document.fonts.ready
    const measure = () => {
      const title = canvas.getByRole("heading", { level: 1 })
      const nav = canvas.getByRole("navigation", {
        name: "Organization settings",
      })
      const box = (el: Element) => {
        const { left, top, width } = el.getBoundingClientRect()
        return { left, top, width }
      }
      return { title: box(title), nav: box(nav) }
    }
    let first: ReturnType<typeof measure> | undefined
    for (const label of ["Settings", "Members", "API Keys", "Settings"]) {
      if (first) {
        await userEvent.click(
          within(
            canvas.getByRole("navigation", { name: "Organization settings" }),
          ).getByRole("link", { name: label }),
        )
      }
      // The active link and the page body show that the sub-page has loaded.
      await waitFor(() => {
        expect(
          within(
            canvas.getByRole("navigation", { name: "Organization settings" }),
          ).getByRole("link", { name: label }),
        ).toHaveAttribute("aria-current", "page")
        expect(canvas.queryByText("Loading organization settings")).toBeNull()
        expectSharedFrame(canvasElement)
        if (label === "API Keys") {
          expect(canvas.getByText("No organization keys")).toBeVisible()
        }
      })
      await waitFor(() => {
        const now = measure()
        first ??= now
        expect(now).toEqual(first)
      })
    }
  },
}

/** The loading state uses the same frame as the loaded sub-pages. */
export const LoadingKeepsFrame: Story = {
  args: { organizationView: "members" },
  render: (args) => (
    <OrganizationSettingsShell
      orgSlug={args.orgSlug}
      current={args.organizationView}
    >
      <PageBodySkeleton label="Loading organization settings" />
    </OrganizationSettingsShell>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await document.fonts.ready
    await canvas.findByText("Loading organization settings")
    await waitFor(() => expectSharedFrame(canvasElement))
  },
}
