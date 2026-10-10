# ADR-050: Every README becomes a Document node

**Status:** Accepted | **Date:** 2026-10-06 | **Tags:** graph, ingestion, retrieval

Amends [ADR-033](ADR-033-graph-ontology-v2.md) §1 (kinds) and §8 (search-only
Markdown). Builds on [ADR-032](ADR-032-path-located-graph-edges.md).

## Context

Some monorepos keep a README in most directories as in-place documentation for
people and agents. ADR-033 §8 makes only the repository-root README and
package-root READMEs instruction sources. Every other README is search-only: it
is in the Zoekt index, but it is never embedded and has no graph node. The
advisor reaches one only through a literal code-search hit or by opening the
file. A README in a directory outside every workspace package is not attached
to anything.

Making every README an instruction source is not the fix: that path is one
model call per file, and README-derived units were 64% of all nodes on a preview
graph before §8. Most README text describes rather than instructs.

## Decision

1. **New extension kind `Document`**, one node per `README.md` in any letter
   case, minus dependency, vendor and connector warehouse paths. Identity is
   `doc:${repositoryId}:${path}` (`referenceResolver.documentDedupKey`).
2. **Deterministic, no model call.** Name is the first H1, else frontmatter
   `title`, else the directory. Summary is the first prose paragraph (badge
   rows, images and HTML blocks are skipped). Payload `excerpt` is the first
   2,000 characters after the title; the generic embedding builder already
   embeds `name`, `summary` and `excerpt`, so Documents are found by hybrid
   search.
3. **Located like Decisions.** `Document DECLARED_IN File`, and that `File` is
   `PART_OF` its package and the `Repository` (`linkLocatedPaths`). The core
   walk reaches a package's READMEs in two hops. No new predicate. A push
   re-extracts only packages whose manifest changed, so on a partial ingest
   the other packages come from the graph (`listPackageRootsForRepository`);
   otherwise retraction would drop the README's package link until the next
   full ingest.
4. **One repository-wide pass after all roots** (`extract-readme-documents`
   workflow step), not a per-root extractor. Each root branch knows only its
   own root, so per-root extraction would either drop READMEs outside every
   package or read every README once per root. The pass sees every package
   from the per-root output.
5. **Root and package-root READMEs get both** a `Document` and their
   `InstructionUnit`s: the Document holds what the file describes, the units
   hold what it tells you to do. No other Markdown is added to the Document
   pass in this decision.
6. **At most 2,000 READMEs per ingest**, shallowest first, so the repository
   and package READMEs survive; hitting the cap logs a warning. The cap is
   applied before a push is narrowed to its diff, so a push never adds a
   README the next full ingest would drop.
7. **The step output is passed through `sanitizePostgresJson`**, like the
   per-root output: a cut at 2,000 characters can split an emoji, and jsonb
   rejects the unpaired surrogate.

## Consequences

- Existing graphs gain Documents on the next ingest that sees each README: a
  full re-index for all of them, a push for the READMEs it changes.
- Partial ingests re-read only changed READMEs. A deleted README's
  `DECLARED_IN` evidence goes through path-based retraction, as Decisions'
  does.
- Only the first 2,000 characters are embedded. The advisor can open the full
  file once a Document matches.
- `README.mdx` and `README.markdown` are not included.
- A README whose H1 is generic ("Overview") is found by its body rather than
  its name; the path is a payload field, not embedded text.
- The unused LangGraph `codeIngestionGraph` does not run the pass; it already
  lacks the post-root steps (reference finalization, package hierarchy).

## Alternatives considered

- **Every README as an instruction source** — rejected: one model call per
  file and the node blow-up §8 removed.
- **A summary on the `File` node** — rejected: ADR-032 keeps `File` a location,
  not a document.
- **Per-root extractor, like `extractDecisions`** — rejected: drops READMEs
  outside every package or reads each README once per root (see 4).
- **All non-instruction Markdown, not only READMEs** — deferred: unbounded on
  docs-site repositories. A later decision can widen the glob onto the same
  kind, as can typed Notion and Confluence pages (ADR-032 §4).
- **One node per README section** — deferred until the 2,000-character
  excerpt proves too short in retrieval.
