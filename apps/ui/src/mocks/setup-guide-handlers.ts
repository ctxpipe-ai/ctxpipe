import type { RequestHandler } from "msw"

import { githubConnectorBootstrapHandler } from "@/features/connectors/mocks/github-bootstrap-msw"

import {
  githubInstallationNoneHandler,
  organizationInvitationsHandler,
  organizationMembersHandler,
} from "./handlers"
import type { MockState } from "./mock-state"
import {
  activeMemberRoleHandler,
  orgConnectionsHandler,
} from "./workspace-sources-handlers"

/**
 * The signals of the setup guide on the org home (`useSetupGuide`) for an
 * admin: the role, the members and invitations, the GitHub App and the
 * connections. Each field replaces one signal. The default is an org with
 * no GitHub App, no connection, one member and no invitation. The sources
 * of the landing Workspace are a read of the Workspace: add
 * `workspaceSourcesHandler`.
 */
export function setupGuideHandlers(
  input: {
    role?: MockState<string>
    members?: MockState<number>
    invitations?: MockState<string[]>
    github?: RequestHandler
    connectors?: RequestHandler
  } = {},
): RequestHandler[] {
  return [
    activeMemberRoleHandler(input.role ?? "owner"),
    organizationMembersHandler(input.members ?? 1),
    organizationInvitationsHandler(input.invitations ?? []),
    githubConnectorBootstrapHandler({
      orgSlug: "acme",
      hostedDefaultAppInstallUrl:
        "https://github.com/apps/ctxpipe-agent/installations/new",
    }),
    input.github ?? githubInstallationNoneHandler,
    input.connectors ?? orgConnectionsHandler([]),
  ]
}
