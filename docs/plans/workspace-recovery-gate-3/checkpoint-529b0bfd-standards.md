# Gate 3 immutable-source checkpoint — Standards review

Pinned range: `bb24210c01e0dc1bcbc2d4fdf197d07a7a17035d...529b0bfd08d1e73618285cc5867c4859062b2c14`

## Documented-standard violation (1)

**[P1] Captured extraction’s public graph tools force the wrong checkout.** Every exported `graph_*` tool forwards `checkoutKey`, whose Zod schema defaults to `"default"` (`apps/backend/src/tools/codegraphTools.ts:15-46,54-85,91-122`). In a captured extraction, `codesearchGraphQuery` correctly signs a `repositoryRevisions` claim for the immutable SHA but sends that unchanged body (`apps/backend/src/tools/codesearchGraph.ts:33-50,64-73`). Codesearch derives `rev:<sha>` from the claim and rejects the supplied `default` with 403 (`apps/codesearch/src/routes/graph.ts:87-96`). Consequently an ordinary model invocation of any graph tool cannot read its captured source. This violates ADR-033:48 (“captured source revision … into every explorer tool”) and the TDD skill’s public-seam rule: the new native source proof invokes only `get_file` and `search` (`repository-index-source-native.contract.test.ts:84-109`). Suppress or replace the body checkout key when source authority exists, then prove one public `graph_*` invocation after another revision is published.

The prior HTTP admission blocker is closed: repository creation and Confluence configuration await admission and return 503 (`routes/v1/repositories.ts:324-345`; `routes/v1/connectors-atlassian.ts:992-1005`), with native failure/retry coverage. Immutable checkout publication, request-fenced progress, source binding rechecks, and default-branch follow-up otherwise conform to ADR-033.

## Fowler heuristic judgments (9; non-blocking)

The seven cumulative judgments remain: **Mysterious Name (2)** (`sourceId`/`evidenceKey`; dual-purpose `contentSyncWorkflowRunId`), **Repeated Switches (1)** in connector lifecycle dispatch, and **Duplicated Code (4)** in typed-write admission, connector admission, GitHub credential issuance, and conversation preparation/publication. This increment adds **Duplicated Code (2)**: captured-source claim/JWT assembly is repeated across four backend clients (`codesearchClient.ts`, `codesearchGraph.ts`, `codesearchZoekt.ts`, `structuralSearch.ts`), and the published-checkout SQL is copied verbatim between backend and codesearch (`models/repositories.ts:55-59`; `domain/repositories/service.ts:77-81`). Centralize each invariant-bearing shape.

**Blockers: 1.**
