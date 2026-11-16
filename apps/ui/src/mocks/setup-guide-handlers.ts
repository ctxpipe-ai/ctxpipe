import type { RequestHandler } from "msw"

import {
  githubInstallationNoneHandler,
  hostedGithubAppBootstrapHandler,
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
 * connections. Each field replaces one signal. The org has one member. The
 * default is an org with no GitHub App, no connection and no invitation.
 * The sources of the landing Workspace are a read of the Workspace: add
 * `workspaceSourcesHandler`.
 */
export function setupGuideHandlers(
  input: {
    role?: MockState<string>
    invitations?: MockState<string[]>
    github?: RequestHandler
    connectors?: RequestHandler
  } = {},
): RequestHandler[] {
  return [
    activeMemberRoleHandler(input.role ?? "owner"),
    organizationMembersHandler(1),
    organizationInvitationsHandler(input.invitations ?? []),
    hostedGithubAppBootstrapHandler,
    input.github ?? githubInstallationNoneHandler,
    input.connectors ?? orgConnectionsHandler([]),
  ]
}
