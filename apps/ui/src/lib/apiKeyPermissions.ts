/**
 * Default scopes for new API keys (Better Auth `permissions` shape).
 * Keep aligned with server enforcement in apps/backend/src/auth/apiKeyScopes.ts.
 */
export const defaultApiKeyPermissions: Record<string, string[]> = {
  mcp: ["read"],
  repositories: ["read", "write"],
  conversations: ["read", "write"],
  github_installation: ["read", "write"],
  connectors: ["read", "write"],
  connectors_atlassian: ["read", "write"],
  pending_atlassian_claim: ["read", "write"],
  onboarding: ["read", "write"],
  knowledge_graph: ["read", "write"],
  me: ["read", "write"],
  health: ["read"],
}
