import { useParams } from "@tanstack/react-router"
import { expect, userEvent, waitFor, within } from "storybook/test"

import { PageBodySkeleton } from "@/components/ui/Skeleton"
import {
  orgApiKeysListEmptyHandler,
  orgApiKeysListForbiddenHandler,
  orgApiKeysListPopulatedHandler,
  organizationFullWithOrgHandler,
  organizationInvitationsHandler,
  organizationListWithOrgHandler,
  organizationMembersHandler,
  organizationPermissionHandler,
  signedInHandlers,
} from "@/mocks/handlers"
import { sideNavHandlers } from "@/mocks/workspace-handlers"
import { workspaceIngestionHandlers } from "@/mocks/workspace-ingestion-handlers"

import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import preview from "../../.storybook/preview"
import {
  OrganizationSettingsBody,
  OrganizationSettingsShell,
} from "./$orgSlug.organization.$organizationView"

const meta = preview.meta({
  title: "Pages/Organization settings",
  component: OrganizationSettingsBody,
  beforeEach: ({ msw }) => {
    msw.use(...signedInHandlers, ...workspaceIngestionHandlers({}))
  },
  parameters: {
    app: "root",
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    review: { kind: "component" },
  },
  args: {
    orgSlug: "acme",
    organizationView: "api-keys",
    organizationId: "org_storybook",
  },
})

/**
 * Organization settings page with the org shell, where an admin manages the
 * organization: the Settings view is open, with the org shell, the settings
 * frame and the sub-menu.
 */
export const Settings = meta.story({
  tags: ["page"],
  args: {
    organizationView: "settings",
  },
  beforeEach: ({ msw }) => {
    msw.use(
      organizationListWithOrgHandler,
      organizationFullWithOrgHandler,
      // The admin may change the org.
      organizationPermissionHandler(true),
      ...sideNavHandlers(),
    )
  },
  parameters: {
    app: "org",
    review: { kind: "page" },
    route: "/$orgSlug/organization/$organizationView",
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
})

/**
 * Body of the organization settings page, where an admin manages the org API
 * keys: the org has no API keys yet.
 */
export const ApiKeysEmpty = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      organizationListWithOrgHandler,
      organizationFullWithOrgHandler,
      orgApiKeysListEmptyHandler,
    )
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
})

/**
 * Body of the organization settings page, where an admin manages the org API
 * keys: the org has a list of API keys.
 */
export const ApiKeysPopulated = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      organizationListWithOrgHandler,
      organizationFullWithOrgHandler,
      orgApiKeysListPopulatedHandler,
    )
  },
})

/**
 * Body of the organization settings page, where an admin manages the org API
 * keys: the user is a member and may not see the keys.
 */
export const ApiKeysMemberForbidden = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(
      organizationListWithOrgHandler,
      organizationFullWithOrgHandler,
      orgApiKeysListForbiddenHandler,
    )
  },
})

const subPageHandlers = [
  organizationListWithOrgHandler,
  organizationFullWithOrgHandler,
  orgApiKeysListEmptyHandler,
  organizationPermissionHandler(true),
  organizationMembersHandler(1),
  organizationInvitationsHandler([]),
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

/**
 * Body of the organization settings page, with a sub-menu for each view: the
 * user moved from Settings to Members to API Keys and back to Settings. The
 * play proves that the title and the sub-menu stay in the same position.
 */
export const SubPagesKeepOnePosition = meta.story({
  beforeEach: ({ msw }) => {
    msw.use(...subPageHandlers)
  },
  parameters: {
    storyRoute: {
      pattern: "orgOrganizationView",
      orgSlug: "acme",
      view: "settings",
    } satisfies StoryRouteParams,
  },
  render: (args) => {
    // oxlint-disable-next-line react-hooks/rules-of-hooks -- a Storybook render function, not a component
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
})

/**
 * Frame of the organization settings page, with the title and the sub-menu: the
 * Members view is still loading and shows a skeleton. The loading state uses
 * the same frame as the loaded views.
 */
export const LoadingKeepsFrame = meta.story({
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
})
