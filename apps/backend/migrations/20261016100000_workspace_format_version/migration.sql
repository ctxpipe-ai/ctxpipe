-- A cache of the Workspace format file `.ctxpipe/workspace.yaml` (CTX-740).
-- Git is the source of truth. Hydrate writes the value for each projection.
ALTER TABLE "workspaces" ADD COLUMN "format_version" integer;
