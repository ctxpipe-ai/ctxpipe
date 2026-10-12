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
  body, the bare Linear identifiers of
  known teams, and the `github.com/<workspace repo>/blob/<ref>/<path>` URLs.
  Each resolved target becomes a `workspace:<path>` link. A reference to a
  thing that the Workspace does not hold gives no link. A `/` link that a
  person wrote keeps its old meaning.
- The Confluence converter keeps an `http(s)` anchor as a Markdown link. It
  writes a `<ri:page>` link to a mirrored page of the same space as a
  relative link, and other `<ri:page>` links as text.
- Claims upgrade does not write claims into mirror files or for
  `workspace:` links.

## Review fixes

- A reference that fails to parse is skipped with a warning, so hydrate
  cannot fail on one bad URL (for example `…/blob/main/50%.md`).
- A blob URL joins only the path after a one-segment ref. A ref that holds
  `/` stays external, so no shorter path matches by mistake.
- A Confluence URL joins only on the site host of the org's Confluence
  connection (its display name, step `list-confluence-sites`). With no
  site host, or with two or more, Confluence URLs make no edges, because
  a page id is unique only in its site. Relative page links from the
  converter do not need a site host.
- A Linear link whose URL is in another Linear workspace makes no edge,
  also when its text is an identifier such as `[ENG-2](…)`.
- A Linear URL joins only in a Linear workspace that the Linear mirror
  files name in their `url`. A Linear identifier inside a URL counts only
  through that URL.
- `extractLinear.ts` reads `linear/**/issues/**/*.md` and
  `linear/**/teams/*.md`, and emits one Issue for each identifier.

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
- `chat-projection.contract.test.ts` "static chat tools resolve the
  authorized projection only when invoked" fails also on the base commit.
