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
import { githubInstallations } from "./schema/github.js"
import { conversations } from "./schema/conversations.js"
import { repositories } from "./schema/repositories.js"
import { repositoryCheckouts } from "./schema/repository_checkouts.js"
import { objects } from "./schema/objects.js"

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
  conversations,
  claims,
  claimEvidence,
  objects,
} as const

const relations = defineRelations(schema)

export { schema, relations }
