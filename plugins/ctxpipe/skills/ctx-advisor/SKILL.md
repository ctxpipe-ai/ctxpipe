---
name: ctx-advisor
description: Call the ctx_advisor MCP tool for organization standards, ADRs, architecture, and likely source areas before planning or choosing tools.
---

# ctx_advisor

Use the `ctx_advisor` tool from the ctxpipe MCP server. Do not invent organization standards from the local repo alone.

## When to call

Call before you:

- choose a tool, library, framework, or database
- decide a service boundary, API shape, or data model
- present a plan that depends on organization conventions
- start a task that might already have an ADR or prior decision

Call again mid-plan when options change.

Initial retrieval is complete when the answer names the applicable standards
or decisions and labels anything that still needs source verification. A
mid-plan check is complete when every newly introduced option has been checked
against that context.

## How to prompt

Include the task, any user preference, and the repo or subsystem involved. Ask the tool to separate verified evidence from inference.

Example:

```text
Planning to change authentication. What standards, ADRs, and source areas apply? Label anything that still needs a file or search check.
```

## After the answer

Inspect critical files with this client's own repository tools. `ctx_advisor` is organizational context, not a code-review guarantee. Do not cite line numbers or call graphs unless a later tool result in this conversation supports them.

The task is grounded only when consequential claims are either supported by
those repository tools or clearly marked as unverified.
