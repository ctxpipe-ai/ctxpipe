/** Copy for Better Auth API-key cards. UK English. */

export const personalApiKeyLocalization = {
  API_KEYS: "API Keys",
  API_KEYS_DESCRIPTION:
    "Personal keys authenticate you as a member. Organisation keys live under Organisation settings.",
  API_KEYS_INSTRUCTIONS:
    "Create a named key for MCP with the x-api-key header. Point client config at CTXPIPE_API_KEY — do not put the key value in repository files. Keys last 30 days by default. No expiration is allowed; treat a never-expiring key as a long-lived secret. The secret is shown once.",
  CREATE_API_KEY_DESCRIPTION:
    "Give the key a name so you can tell it apart later. Keys last 30 days unless you pick another expiry. Choosing no expiration is allowed; treat that key as a long-lived secret.",
  CREATE_API_KEY_SUCCESS:
    "Copy the secret now — it is shown once. Interpolate CTXPIPE_API_KEY in MCP client config. Do not put the key value in repository files.",
} as const

export const organizationApiKeyLocalization = {
  API_KEYS: "API Keys",
  API_KEYS_DESCRIPTION:
    "Organisation keys authenticate MCP as this organisation, not the person who minted them.",
  API_KEYS_INSTRUCTIONS:
    "Name each key. Keys last 30 days by default. Never-expiring keys are allowed; treat them as long-lived secrets. Copy the secret once. Interpolate CTXPIPE_API_KEY in client config; do not put the key value in repository files.",
} as const
