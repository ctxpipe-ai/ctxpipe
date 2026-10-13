-- Give each OAuth client registered before the MCP scopes the right to ask
-- for them. The user still chooses ctxpipe:write at consent. A client with
-- NULL scopes already uses the server list, so it needs no change.
UPDATE "oauth_clients"
SET "scopes" = "scopes" || ARRAY(
  SELECT "scope"
  FROM unnest(ARRAY['ctxpipe:read', 'ctxpipe:write']::text[]) AS "scope"
  WHERE NOT ("scope" = ANY ("scopes"))
)
WHERE "scopes" IS NOT NULL
  AND NOT ("scopes" @> ARRAY['ctxpipe:read', 'ctxpipe:write']::text[]);
