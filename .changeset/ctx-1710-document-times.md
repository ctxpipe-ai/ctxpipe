---
"@ctxpipe/aws-cdk": minor
---

Knowledge plane: each result of `search_knowledge` and `get_related`, and the front matter of `read_file`, has the times of the unit: `createdAt` (when the item began in its source), `updatedAt` (when its content last changed in its source) and `expiresAt` (when the author sets it, a hint that the content can be stale). ctxpipe reads them from the properties of each file, with no case and no `_` in the compare, and never from the time of the projection run. `updatedAfter` filters on `updatedAt`. A mirrored item with no time of its last change uses its creation time, not a commit time. `validAt` and `validBetween` are removed: a document has no valid window, and each relation shows its own `validFrom` and `validTo`. ctxpipe no longer writes `valid_from` into the files of a Workspace. The upgrade rebuilds the knowledge plane of each Workspace.
