#!/usr/bin/env node
// repository: the first step of a run (ADR-052 section 6). It writes the
// repository unit, knowledge/codebases/<repository>.md of kind Repository,
// on the assembled ref before the root steps, so that each root step and
// each later repository-wide step can link to it. An existing Repository
// file of the same name gets only new Related lines. The host sets the
// provenance fields and `root: .`. The summary is the purpose of the
// repository (bin/purpose-lib.mjs). When no file gives it,
// the summary names the code roots, because this step has no model.
//
// node repository.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map>

import {
  findExisting,
  ownSummary,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"
import { purposeOf } from "../../bin/purpose-lib.mjs"
import { baseBlob } from "../../bin/stage-lib.mjs"
import { trackedFiles } from "../../discover-roots/scripts/roots-lib.mjs"

const { step, source, sourcePath, repository, roots, index, skipped } =
  scriptStep()
const name = repository.split("/").pop() ?? repository
const slug = name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
const existing = findExisting(index, "Repository", [repository, name])
const path = existing ?? `knowledge/codebases/${slug || "repository"}.md`
const purpose = purposeOf(source, new Set(trackedFiles(source)), ".")
const listed = roots.map((r) => r.path).filter((p) => p !== ".")
const summary =
  purpose?.text ??
  (listed.length
    ? `The source repository ${repository}, with the code roots ${listed.slice(0, 5).join(", ")}${listed.length > 5 ? ` and ${listed.length - 5} more` : ""}.`
    : `The source repository ${repository}, with one code root at its top.`)
// The summary that this step wrote before CTX-1514.
const current = baseBlob(step, path) ? ownSummary(step, path, sourcePath) : null
const replaces =
  typeof current === "string" &&
  // The old summary, or the fallback when no file gave a purpose.
  /^The source repository \S+(?:\.|, with .*\.)$/.test(current) &&
  current !== summary

writeStep(
  step,
  [
    {
      path,
      claims: [],
      related: roots.map((root) => {
        const manifest = root.manifests[0]
        return `- \`${repository}\` has the root \`${root.path}\`${manifest ? ` (\`${manifest}\`)` : ""}`
      }),
      expectName: existing ? undefined : repository,
      exactName: true,
      ...(replaces ? { summary } : {}),
      create: {
        kind: "Repository",
        name: repository,
        summary,
        intro: [
          `A script wrote this file for the source repository \`${repository}\` and its code roots.`,
          // A purpose from a file is source text: a quote with its source.
          purpose ? `> ${purpose.text}\n\nSource: ${purpose.evidence}` : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    },
  ],
  skipped,
)
