-- One-shot dest Workspace backfill. SQL rows only — do not enqueue OpenWorkflow.
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
INSERT INTO "workspaces" (
  "id",
  "org_id",
  "slug",
  "display_name",
  "workspace_repository_url",
  "github_connection_id",
  "desired_generation",
  "write_status",
  "hydrate_status",
  "read_only_reason",
  "created_at",
  "updated_at"
)
SELECT
  'ws_' || replace(gen_random_uuid()::text, '-', ''),
  s.org_id,
  CASE
    WHEN s.slug_n = 1 THEN s.desired_slug
    WHEN NOT EXISTS (
      SELECT 1
      FROM "workspaces" w
      WHERE w."org_id" = s.org_id
        AND lower(w."slug") = s.numbered_slug
    ) THEN s.numbered_slug
    ELSE left(s.desired_slug, 55) || '-' || substr(md5(s.org_id || '|' || s.git_url), 1, 8)
  END,
  s.name,
  s.git_url,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM "connections" c WHERE c."id" = s.github_connection_id
    ) THEN s.github_connection_id
    ELSE NULL
  END,
  1,
  CASE
    WHEN s.git_url NOT LIKE 'https://github.com/%' THEN 'read_only'
    WHEN s.github_connection_id IS NULL THEN 'read_only'
    ELSE 'unknown'
  END,
  'pending',
  CASE
    WHEN s.git_url NOT LIKE 'https://github.com/%' THEN
      'This remote is not GitHub. v1 can hydrate, search, and chat, but cannot commit or push. Relink to a GitHub repository the App can write.'
    WHEN s.github_connection_id IS NULL THEN
      'GitHub is not connected for this organisation. An owner or admin must install the GitHub App and add this repository to the installation.'
    ELSE NULL
  END,
  now(),
  now()
FROM (
  SELECT
    d.org_id,
    d.git_url,
    d.name,
    d.github_connection_id,
    d.desired_slug,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM "workspaces" w
        WHERE w."org_id" = d.org_id
          AND lower(w."slug") = d.desired_slug
      ) THEN d.seq + 1
      ELSE d.seq
    END AS slug_n,
    left(
      d.desired_slug,
      64 - length(
        '-' || (
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM "workspaces" w
              WHERE w."org_id" = d.org_id
                AND lower(w."slug") = d.desired_slug
            ) THEN d.seq + 1
            ELSE d.seq
          END
        )::text
      )
    ) || '-' || (
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM "workspaces" w
          WHERE w."org_id" = d.org_id
            AND lower(w."slug") = d.desired_slug
        ) THEN d.seq + 1
        ELSE d.seq
      END
    )::text AS numbered_slug
  FROM (
    SELECT
      dest.org_id,
      dest.git_url,
      dest.name,
      dest.github_connection_id,
      left(
        coalesce(
          nullif(
            trim(both '-' FROM regexp_replace(lower(dest.name), '[^a-z0-9]+', '-', 'g')),
            ''
          ),
          'workspace'
        ),
        64
      ) AS desired_slug,
      row_number() OVER (
        PARTITION BY dest.org_id,
          left(
            coalesce(
              nullif(
                trim(both '-' FROM regexp_replace(lower(dest.name), '[^a-z0-9]+', '-', 'g')),
                ''
              ),
              'workspace'
            ),
            64
          )
        ORDER BY dest.git_url
      ) AS seq
    FROM (
      SELECT DISTINCT ON (src.org_id, src.git_url)
        src.org_id,
        src.git_url,
        src.name,
        src.github_connection_id
      FROM (
        SELECT
          r."org_id" AS org_id,
          tmp_normalize_workspace_repository_url(r."git_url") AS git_url,
          r."name" AS name,
          r."github_connection_id" AS github_connection_id,
          r."created_at" AS created_at,
          r."id" AS repository_id
        FROM "confluence_sync_targets" t
        INNER JOIN "repositories" r
          ON r."id" = t."repository_id"
          AND r."org_id" = t."org_id"
        WHERE t."enabled" IS TRUE
        UNION ALL
        SELECT
          r."org_id",
          tmp_normalize_workspace_repository_url(r."git_url"),
          r."name",
          r."github_connection_id",
          r."created_at",
          r."id"
        FROM "connections" c
        INNER JOIN "repositories" r
          ON r."org_id" = c."org_id"
          AND r."id" = (c."config"->>'repositoryId')
        WHERE c."type" IN ('linear', 'notion', 'slack')
          AND (c."config"->>'enabled')::boolean IS TRUE
          AND nullif(btrim(c."config"->>'repositoryId'), '') IS NOT NULL
      ) src
      WHERE src.git_url <> ''
      ORDER BY src.org_id, src.git_url, src.created_at, src.repository_id
    ) dest
    WHERE NOT EXISTS (
      SELECT 1
      FROM "workspaces" w
      WHERE w."org_id" = dest.org_id
        AND w."workspace_repository_url" = dest.git_url
    )
  ) d
) s
ON CONFLICT ON CONSTRAINT "workspaces_org_id_repository_url_uidx" DO NOTHING;
--> statement-breakpoint
INSERT INTO "workspace_linked_repositories" (
  "id",
  "workspace_id",
  "git_url",
  "created_at"
)
SELECT
  'wlr_' || replace(gen_random_uuid()::text, '-', ''),
  w."id",
  tmp_normalize_workspace_repository_url(r."git_url"),
  now()
FROM "workspaces" w
INNER JOIN (
  SELECT DISTINCT
    src.org_id,
    src.git_url
  FROM (
    SELECT
      r."org_id" AS org_id,
      tmp_normalize_workspace_repository_url(r."git_url") AS git_url
    FROM "confluence_sync_targets" t
    INNER JOIN "repositories" r
      ON r."id" = t."repository_id"
      AND r."org_id" = t."org_id"
    WHERE t."enabled" IS TRUE
    UNION ALL
    SELECT
      r."org_id",
      tmp_normalize_workspace_repository_url(r."git_url")
    FROM "connections" c
    INNER JOIN "repositories" r
      ON r."org_id" = c."org_id"
      AND r."id" = (c."config"->>'repositoryId')
    WHERE c."type" IN ('linear', 'notion', 'slack')
      AND (c."config"->>'enabled')::boolean IS TRUE
      AND nullif(btrim(c."config"->>'repositoryId'), '') IS NOT NULL
  ) src
  WHERE src.git_url <> ''
) d
  ON d.org_id = w."org_id"
  AND d.git_url = w."workspace_repository_url"
INNER JOIN "repositories" r
  ON r."org_id" = w."org_id"
WHERE tmp_normalize_workspace_repository_url(r."git_url") <> ''
  AND tmp_normalize_workspace_repository_url(r."git_url") <> w."workspace_repository_url"
ON CONFLICT ON CONSTRAINT "workspace_linked_repositories_workspace_id_git_url_uidx" DO NOTHING;
--> statement-breakpoint
DROP FUNCTION tmp_normalize_workspace_repository_url(text);
--> statement-breakpoint
DROP TABLE "org_workspace_cutover";
