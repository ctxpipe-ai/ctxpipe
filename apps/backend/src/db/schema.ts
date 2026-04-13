import { defineRelations } from "drizzle-orm"
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
import { forgeInstallations } from "./schema/forgeInstallations.js"
import { conversations } from "./schema/conversations.js"
import { githubInstallations } from "./schema/github.js"
import { objects } from "./schema/objects.js"
import { onboardingOrgCreationRequests } from "./schema/onboarding_org_creation_requests.js"
import { orgOnboarding } from "./schema/org_onboarding.js"
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
  repositories,
  repositoryCheckouts,
  githubInstallations,
  forgeInstallations,
  conversations,
  claims,
  claimEvidence,
  objects,
  orgOnboarding,
  onboardingOrgCreationRequests,
} as const

const relations = defineRelations(schema)

export { schema, relations }
