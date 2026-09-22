/** Copy for Better Auth API-key cards. UK English. */

export const personalApiKeyLocalization = {
  API_KEYS: "API Keys",
  API_KEYS_DESCRIPTION:
    "For your own scripts and agents. Requests use your membership and permissions.",
  CREATE_API_KEY: "Create API key",
  CREATE_API_KEY_DESCRIPTION:
    "Name the key and choose an expiry. The secret is shown once.",
  API_KEY_CREATED: "API key created",
  CREATE_API_KEY_SUCCESS:
    "Copy this secret now. Store it in CTXPIPE_API_KEY and never commit it; it will not be shown again.",
} as const

export const organizationApiKeyLocalization = {
  API_KEYS: "API Keys",
  API_KEYS_DESCRIPTION:
    "For CI and shared agents. Requests are tied to this organisation, not a person.",
} as const
