import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  authConfigHandler,
  githubInstallationNoneHandler,
  organizationCreateSuccessHandler,
  organizationListEmptyHandler,
  organizationListWithOrgHandler,
  sessionSignedInOnboardingHandler,
  userOnboardingHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OnboardingPageContent } from "./onboarding"

const noRepositoriesHandler = http.get(
  ({ request }) =>
    new URL(request.url).pathname.endsWith("/api/v1/repositories"),
  () => HttpResponse.json({ items: [] }),
)

const meta = {
  title: "Pages/Onboarding",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "flat",
      path: "/onboarding",
    } satisfies StoryRouteParams,
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

/** New admin, no organisation yet. Typing the name fills the slug and the frame label. */
export const AdminCreateOrganisation: Story = {
  render: () => <OnboardingPageContent urlOrgSlug={null} />,
  parameters: {
    msw: {
      handlers: {
        // `defaults` replaces the preview's onboarded user and `acme` org.
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListEmptyHandler,
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const name = await canvas.findByRole("textbox", {
      name: /organisation name/i,
    })
    await userEvent.type(name, "Acme Engineering")
    await expect(canvas.getByRole("textbox", { name: /slug/i })).toHaveValue(
      "acme-engineering",
    )
  },
}

/** Joiner: org lit, GitHub not connected by an admin, agent step listening. */
export const JoinerListening: Story = {
  render: () => <OnboardingPageContent urlOrgSlug="acme" />,
  parameters: {
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListWithOrgHandler,
          githubInstallationNoneHandler,
          noRepositoriesHandler,
          userOnboardingHandler(null),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText(/listening for your agent’s first call/i),
    ).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: /open ctx\|/i }),
    ).not.toBeInTheDocument()
  },
}

/** The backend recorded the first MCP call, so the agent beat is done. */
export const JoinerConnected: Story = {
  render: () => <OnboardingPageContent urlOrgSlug="acme" />,
  parameters: {
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListWithOrgHandler,
          githubInstallationNoneHandler,
          noRepositoriesHandler,
          userOnboardingHandler({
            at: "2026-09-28T09:00:00.000Z",
            client: "claude-code",
            tool: "ctx_advisor",
          }),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /open ctx\|/i })).toBeVisible(),
    )
    // Going back: a done step's title reopens it without undoing anything.
    await userEvent.click(
      canvas.getByRole("button", { name: "Connect an agent" }),
    )
    await expect(
      await canvas.findByText(/add ctx\| to another agent/i),
    ).toBeVisible()
    await expect(canvas.getByRole("button", { name: "Back" })).toBeVisible()
  },
}

/** Repositories are indexing: the header pill says so on every step. */
export const JoinerWhileRepositoriesIndex: Story = {
  render: () => <OnboardingPageContent urlOrgSlug="acme" />,
  parameters: {
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListWithOrgHandler,
          http.get(
            ({ request }) =>
              new URL(request.url).pathname ===
              "/acme/api/v1/github/installation",
            () =>
              HttpResponse.json({
                id: "github_connection_1",
                appSlug: "ctxpipe",
                accountSlug: "acme",
              }),
          ),
          http.get(
            ({ request }) =>
              new URL(request.url).pathname === "/acme/api/v1/repositories",
            () =>
              HttpResponse.json({
                items: [
                  {
                    id: "repo_1",
                    name: "acme/api",
                    gitUrl: "https://github.com/acme/api.git",
                    indexReady: false,
                    indexingStatus: "running",
                    indexingStep: 7,
                    indexingStepTotal: 22,
                    indexingStepKey: "embedding",
                  },
                  {
                    id: "repo_2",
                    name: "acme/web",
                    gitUrl: "https://github.com/acme/web.git",
                    indexReady: false,
                    indexingStatus: "queued",
                    indexingStep: null,
                    indexingStepTotal: null,
                    indexingStepKey: null,
                  },
                ],
              }),
          ),
          userOnboardingHandler(null),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      await canvas.findByText(/indexing 2 repositories/i),
    ).toBeVisible()
  },
}

/** Creating the org keeps the same picture on screen: no remount, no second fade-in. */
export const AdminCreateThenGithub: Story = {
  render: () => <OnboardingPageContent urlOrgSlug={null} />,
  parameters: {
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListEmptyHandler,
          organizationCreateSuccessHandler(),
          http.post("*/.auth/api/v1/auth/organization/set-active", () =>
            HttpResponse.json({ id: "org_acme_engineering" }),
          ),
          githubInstallationNoneHandler,
          noRepositoriesHandler,
          userOnboardingHandler(null),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByRole("textbox", { name: /organisation name/i }),
      "Acme Engineering",
    )
    const picture = canvasElement.querySelector("figure")
    await userEvent.click(
      canvas.getByRole("button", { name: /create organisation/i }),
    )
    await canvas.findByRole("button", { name: /connect github/i })
    await expect(picture?.isConnected).toBe(true)
  },
}

/** Two repositories failed: the pill names them, says why, and retries here. */
export const RepositoriesFailed: Story = {
  render: () => <OnboardingPageContent urlOrgSlug="acme" />,
  parameters: {
    msw: {
      handlers: {
        defaults: [
          authConfigHandler,
          sessionSignedInOnboardingHandler,
          organizationListWithOrgHandler,
          githubInstallationNoneHandler,
          http.get(
            ({ request }) =>
              new URL(request.url).pathname === "/acme/api/v1/repositories",
            () =>
              HttpResponse.json({
                items: [
                  {
                    id: "repo_api",
                    name: "acme/api",
                    gitUrl: "https://github.com/acme/api.git",
                    indexReady: false,
                    indexingStatus: "failed",
                    indexingError:
                      "Code search did not respond while indexing (timed out after 11 attempts).",
                    indexingStep: null,
                    indexingStepTotal: null,
                    indexingStepKey: null,
                  },
                  {
                    id: "repo_web",
                    name: "acme/web",
                    gitUrl: "https://github.com/acme/web.git",
                    indexReady: true,
                    indexingStatus: "complete_with_issues",
                    indexingError: "3 files could not be parsed.",
                    indexingStep: null,
                    indexingStepTotal: null,
                    indexingStepKey: null,
                  },
                ],
              }),
          ),
          userOnboardingHandler(null),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      await canvas.findByRole("button", { name: /did not finish indexing/i }),
    )
    const popover = within(document.body)
    await expect(
      await popover.findByText(/code search did not respond/i),
    ).toBeVisible()
    await expect(popover.getByRole("button", { name: "Retry 2" })).toBeVisible()
  },
}
