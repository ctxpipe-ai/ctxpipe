import type { CodeIngestionState } from "../schemas.js"
import { extractGithubPullRequests } from "./extractGithubPullRequests.js"
import { extractLinear } from "./extractLinear.js"
import { extractSlackThreads } from "./extractSlackThreads.js"

export type ConnectorExtractor = {
  extract: (state: CodeIngestionState) => Promise<Partial<CodeIngestionState>>
}

/**
 * Registry of deterministic record extractors (ADR-033). A connector ships
 * its frontmatter contract and its extractor together; connector Markdown
 * never goes through the instruction LLM. Each extractor globs its own
 * prefix, so running all of them on a repository without that prefix costs
 * one glob each.
 */
export const CONNECTOR_EXTRACTORS: ReadonlyArray<ConnectorExtractor> = [
  { extract: extractGithubPullRequests },
  { extract: extractLinear },
  { extract: extractSlackThreads },
]
