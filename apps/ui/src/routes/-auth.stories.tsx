import type { Meta, StoryObj } from "@storybook/react-vite"
import { OAuthConsent } from "@/features/auth/OAuthConsent"
import { OAuthOrganizationSelector } from "@/features/auth/OAuthOrganizationSelector"
import {
  organizationListEmptyHandler,
  sessionSignedOutHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { SignInRoutePage } from "./[.]auth.sign-in"

const meta = {
  title: "Pages/Auth",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const SignIn: Story = {
  name: "Sign-in",
  render: () => <SignInRoutePage />,
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/sign-in",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [sessionSignedOutHandler, organizationListEmptyHandler],
      },
    },
  },
}

export const ChooseOAuthOrganization: Story = {
  name: "Choose OAuth organization",
  render: () => (
    <OAuthOrganizationSelector
      organizations={[
        { id: "org_acme", name: "Acme Engineering", slug: "acme" },
        {
          id: "org_consulting",
          name: "Peterson Advisory",
          slug: "peterson-advisory",
        },
      ]}
      onContinue={() => undefined}
    />
  ),
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/select-organization",
    } satisfies StoryRouteParams,
  },
}

export const AuthorizeOAuthClient: Story = {
  name: "Authorize OAuth client",
  render: () => (
    <OAuthConsent
      clientId="claude-plugin"
      scopes={["openid", "offline_access"]}
      organization={{
        name: "Peterson Advisory",
        slug: "peterson-advisory",
      }}
      changeOrganizationHref="/.auth/select-organization?client_id=claude-plugin&sig=abc.def"
      onAllow={() => undefined}
      onDeny={() => undefined}
    />
  ),
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/.auth/consent",
    } satisfies StoryRouteParams,
  },
}
