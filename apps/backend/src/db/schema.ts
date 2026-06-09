import { defineRelations } from "drizzle-orm"
import { agentActivityEvents } from "./schema/agent_activity_events.js"
import {
  accounts,
  deviceCodes,
  invitations,
  jwkss,
  members,
  oauthAccessTokens,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  organizations,
  passkeys,
  sessions,
  twoFactors,
  users,
  verifications,
} from "./schema/auth.js"
import { claimEvidence } from "./schema/claim_evidence.js"
import { claims } from "./schema/claims.js"
import { confluenceSpaces } from "./schema/confluenceSpaces.js"
import { confluenceSyncTargets } from "./schema/confluenceSyncTargets.js"
import { connections } from "./schema/connections.js"
import { conversations } from "./schema/conversations.js"
import { objects } from "./schema/objects.js"
import { orgOnboarding } from "./schema/org_onboarding.js"
import { pendingAccounts } from "./schema/pending_accounts.js"
import { repositories } from "./schema/repositories.js"
import { repositoryCheckouts } from "./schema/repository_checkouts.js"

const schema = {
  users,
  sessions,
  accounts,
  verifications,
  jwkss,
  twoFactors,
  organizations,
  members,
  invitations,
  passkeys,
  deviceCodes,
  oauthClients,
  oauthRefreshTokens,
  oauthAccessTokens,
  oauthConsents,
  agentActivityEvents,
  repositories,
  repositoryCheckouts,
  connections,
  confluenceSpaces,
  confluenceSyncTargets,
  conversations,
  claims,
  claimEvidence,
  objects,
  orgOnboarding,
  pendingAccounts,
} as const

const relations = defineRelations(schema)

export { schema, relations }
