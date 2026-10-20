#!/usr/bin/env node
// repository: the first step of a run (ADR-052 section 6). It writes the
// repository unit, knowledge/codebases/<repository>.md of kind Repository,
// on the assembled ref before the root steps, so that each root step and
// each later repository-wide step can link to it. An existing Repository
// file of the same name gets only new Related lines. The host sets the
// provenance fields and `root: .`.
//
// node repository.mjs --root /ctxpipe --source /ctxpipe/source/<handle> \
//   --source-url <url> --source-path <path> --roots <root-to-file map>

import {
  findExisting,
  scriptStep,
  writeStep,
} from "../../bin/knowledge-lib.mjs"

const { step, repository, roots, index, skipped } = scriptStep()
const name = repository.split("/").pop() ?? repository
const slug = name
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
const existing = findExisting(index, "Repository", [repository, name])
const path = existing ?? `knowledge/codebases/${slug || "repository"}.md`

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
      create: {
        kind: "Repository",
        name: repository,
        summary: `The source repository ${repository}.`,
        intro: `A script wrote this file for the source repository \`${repository}\` and its code roots.`,
      },
    },
  ],
  skipped,
)
