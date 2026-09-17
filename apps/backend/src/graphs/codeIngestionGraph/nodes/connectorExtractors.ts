import type { CodeIngestionState } from "../schemas.js"
import { extractGithubPullRequests } from "./extractGithubPullRequests.js"
import { extractLinear } from "./extractLinear.js"
import { extractSlackThreads } from "./extractSlackThreads.js"

export type ConnectorExtractor = {
  name: string
  /** Warehouse prefix this extractor reads (see connectorMirrorPaths.ts). */
  prefix: string
  extract: (state: CodeIngestionState) => Promise<Partial<CodeIngestionState>>
}

/**
 * Registry of deterministic record extractors, keyed by connector warehouse
 * prefix (ADR-033). A connector ships its frontmatter contract and its
 * extractor together; connector Markdown never goes through the instruction
 * LLM. Each extractor globs its own prefix, so running all of them on a
 * repository without that prefix costs one glob each.
 */
export const CONNECTOR_EXTRACTORS: ReadonlyArray<ConnectorExtractor> = [
  {
    name: "extractGithubPullRequests",
    prefix: "github/pulls/",
    extract: extractGithubPullRequests,
  },
  { name: "extractLinear", prefix: "linear/", extract: extractLinear },
  {
    name: "extractSlackThreads",
    prefix: "slack/",
    extract: extractSlackThreads,
  },
]
