---
"@ctxpipe/aws-cdk": patch
---

Ingestion v2: a later ingest of a source now finds the context files of each root. Before, the roots map listed only the files that a step of the same run wrote. A later ingest wrote no new Service file, so `dependencies` wrote no claim, and `libraries`, `ownership`, `decisions`, and `instruction-areas` did not find the file of a root. The host now adds each existing package file whose front matter `root` is the root and whose `sources` hold the source path. When the run wrote a package file of a root, an old package file of the same root is not added. The host runs the `dependencies` scan first, and starts the model only when a root has a candidate and a Service file. Each step also records counts of candidates, resolutions, and skipped choices on its span. `apply.mjs` no longer stops with an error at more than 300 resolutions.
