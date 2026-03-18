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
import { connectors } from "./schema/connectors.js"
import { connectorSpaces } from "./schema/connector-spaces.js"
import { connectorSyncLogs } from "./schema/connector-sync-logs.js"
import { repositories } from "./schema/repositories.js"
import { conversations } from "./schema/conversations.js"

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
  connectors,
  connectorSpaces,
  connectorSyncLogs,
  repositories,
  conversations,
} as const

const relations = defineRelations(schema)

export { schema, relations }
