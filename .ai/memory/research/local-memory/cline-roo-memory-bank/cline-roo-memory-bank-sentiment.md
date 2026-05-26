# Cline / Roo Memory Bank Sentiment

Sources searched: Cline docs, Roo Code Reddit threads, community GitHub repo.

Representative sources:

- Cline Memory Bank docs: https://docs.cline.bot/prompting/custom-instructions-library/memory-bank
- Cline workflow docs: https://docs.cline.bot/features/slash-commands/workflows
- Roo Code memory-bank repo: https://github.com/GreatScottyMac/roo-code-memory-bank
- Reddit Roo Code thread: https://www.reddit.com/r/RooCode/comments/1ivbtvw/finally_managed_to_create_the_memory_bank_i_was/

## Overall Sentiment

Sentiment is positive among users who need a simple, local continuity layer. It is also pragmatic: users know memory-bank files are not magic, but they prefer them to losing all project context after compaction.

Confidence: medium.

## Positive Themes

- Users report relief when agents can resume work after resets.
- The method is understandable and portable.
- Markdown memory is easy to inspect and correct.
- It works across many agents because it only requires file access and instructions.

## Negative Or Cautious Themes

- Community users often have to customize heavily to make it fit their workflow.
- Memory files can become long, stale, or contradictory.
- Agents may update the wrong level of detail.
- There is no automatic retrieval beyond reading prescribed files.

## Perceived Pros

- Low friction.
- Highly local and reviewable.
- Good baseline for repo memory.

## Perceived Cons

- Weak search and scaling.
- Requires disciplined prompts.
- Easy to pollute with low-value summaries.

## Sentiment Summary

Memory Bank is the simplest credible baseline for local coding memory. The main lesson is that a useful system should preserve human-readable active context and progress even if it later adds indexes, MCP tools, or task graphs.

