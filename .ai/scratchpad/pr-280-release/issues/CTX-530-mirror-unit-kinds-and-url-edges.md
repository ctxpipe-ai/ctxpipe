# CTX-530: connector-mirror units get a kind, and their URLs become edges

Status: fixed on the branch. Not merged.

## Scope

CTX-526 added only the "nodes but no edges" notice in the graph pane. This
ticket adds the graph data: a `kind` for each mirror unit, and an edge for
each link from a mirror unit to another unit of the same Workspace.

## Cause

- `hydrateKnowledgeTree` read `kind` only from front matter. Mirror files
  have no `kind`, so every mirror unit was a `KnowledgeUnit`.
- `markdownLinks` dropped each `http(s)` link, and mirror files link by URL.
- The Confluence converter removed `<a href>` anchors and `<ri:page>` links,
  so a Confluence page body had no link at all.

## Fix

- `domain/workspaces/mirror-units.ts`: `mirrorUnitKind(path)` maps the mirror
  layout to a kind: `confluence/<KEY>/…` gives `Page`. The parent directory
  of a Linear file gives `Issue`, `Project`, `Team`, `Cycle`, `Document`,
  and so on. Slack gives `Thread` and `Channel`. `pagerduty/incidents/…`
  gives `Incident`. A front-matter `kind` still wins.
- `referenceLinks` indexes each unit by keys from `referenceResolver.ts`:
  the Linear `identifier` and `url`, the Confluence page id in the file
  name, and the Slack thread in the path. It then resolves the URLs in the
  body and in the Linear `githubReferences`, the bare Linear identifiers of
  known teams, and the `github.com/<workspace repo>/blob/<ref>/<path>` URLs.
  Each resolved target becomes a Workspace-root link (`/<path>`). A
  reference to a thing that the Workspace does not hold gives no link.
- `resolveHydrateLink` reads a leading `/` as the Workspace root.
- The Confluence converter keeps an `http(s)` anchor as a Markdown link. It
  writes a `<ri:page>` link to a mirrored page of the same space as a
  relative link, and other `<ri:page>` links as text.
- Claims upgrade does not write claims into mirror files or for `/` links.

## Tests

- `apps/backend/src/domain/workspaces/mirror-graph.test.ts`: the fixtures
  come from the real `renderLinearIssue`, `renderLinearEntity`,
  `toConfluenceMarkdownFile`, and `linearRootPath`. Four of its tests fail
  on the base commit (`4273d52e`) and pass on the fix.
- Fixture graph quality: before, 6 units, 0 claims, orphan rate 100%, all
  `KnowledgeUnit`. After, 6 claims, orphan rate 0%, kinds `Issue` 2,
  `Page` 2, `Project` 1, `KnowledgeUnit` 1.

## Follow-ups

- Notion (other branch): add a `notion/…` case to `mirrorUnitKind` and a
  page-id key from the path and the Notion URL in `referenceLinks`.
- Existing Workspaces get the kinds and edges at the next hydrate.
- Front-matter relations (Linear `projectId`, `teamId`) are not edges yet.
- The code-graph extractor `extractLinear.ts` still uses the old globs
  `linear/issues/**` and `linear/teams/**`. With the new team layout,
  `linear/teams/**/*.md` also matches issues and projects.
