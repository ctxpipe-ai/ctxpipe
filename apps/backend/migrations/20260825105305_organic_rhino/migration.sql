CREATE TABLE "org_first_workspaces" (
	"org_id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"source_repository_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_first_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_first_workspaces" ADD CONSTRAINT "org_first_workspaces_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_first_workspaces" AS PERMISSIVE FOR ALL TO public USING ("org_first_workspaces"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("org_first_workspaces"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE OR REPLACE FUNCTION tmp_normalize_workspace_repository_url(raw text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  trimmed text;
  host text;
  path text;
BEGIN
  IF raw IS NULL THEN
    RETURN '';
  END IF;
  trimmed := btrim(raw);
  IF trimmed = '' THEN
    RETURN '';
  END IF;
  IF trimmed ~ '^git@[^:]+:.+$' THEN
    host := lower(substring(trimmed FROM '^git@([^:]+):'));
    path := substring(trimmed FROM '^git@[^:]+:(.+)$');
    path := regexp_replace(path, '\.git$', '', 'i');
    path := regexp_replace(path, '/+$', '');
    IF host = 'github.com' THEN
      RETURN 'https://github.com/' || path;
    END IF;
    RETURN 'https://' || host || '/' || path;
  END IF;
  trimmed := regexp_replace(trimmed, '[?#].*$', '');
  IF trimmed ~* '^https?://([^/]*@)?github\.com/' THEN
    path := regexp_replace(trimmed, '^https?://([^/]*@)?github\.com/', '', 'i');
    path := regexp_replace(path, '\.git$', '', 'i');
    path := regexp_replace(path, '/+$', '');
    RETURN 'https://github.com/' || path;
  END IF;
  trimmed := regexp_replace(trimmed, '\.git$', '', 'i');
  trimmed := regexp_replace(trimmed, '/+$', '');
  RETURN trimmed;
END;
$$;
--> statement-breakpoint
-- One row per org: the Workspace of the first connector target (created_at,
-- then id), as the dest Workspace backfill chose it.
INSERT INTO "org_first_workspaces" ("org_id", "workspace_id", "source_repository_id")
SELECT DISTINCT ON (t.org_id)
  t.org_id,
  w."id",
  t.repository_id
FROM (
  SELECT
    r."org_id" AS org_id,
    tmp_normalize_workspace_repository_url(r."git_url") AS git_url,
    r."created_at" AS created_at,
    r."id" AS repository_id
  FROM "confluence_sync_targets" ct
  INNER JOIN "repositories" r
    ON r."id" = ct."repository_id"
    AND r."org_id" = ct."org_id"
  WHERE ct."enabled" IS TRUE
  UNION ALL
  SELECT
    r."org_id",
    tmp_normalize_workspace_repository_url(r."git_url"),
    r."created_at",
    r."id"
  FROM "connections" c
  INNER JOIN "repositories" r
    ON r."org_id" = c."org_id"
    AND r."id" = (c."config"->>'repositoryId')
  WHERE c."type" IN ('linear', 'notion', 'slack')
    AND (c."config"->>'enabled')::boolean IS TRUE
    AND nullif(btrim(c."config"->>'repositoryId'), '') IS NOT NULL
) t
INNER JOIN "workspaces" w
  ON w."org_id" = t.org_id
  AND w."workspace_repository_url" = t.git_url
WHERE t.git_url <> ''
ORDER BY t.org_id, t.created_at, t.repository_id
ON CONFLICT ("org_id") DO NOTHING;
--> statement-breakpoint
DROP FUNCTION tmp_normalize_workspace_repository_url(text);
