# Graph garbage collection of inactive projection keys

Status: open (follow-up from the P2-4 review).

- **What:** after a new revision is published and its graph is ready, remove the `WorkspaceKnowledgeUnit`, `WorkspaceSignal`, and `WorkspaceProjection` data of projection keys that no published or captured revision uses. This includes the version 1 keys that remain after the P2-4 re-projection.
- **Why:** each revision and each projection version adds a full graph. No code removes old keys, so the graph store grows without limit.
- **Rules:** do not delete in the write path. A chat turn can hold a captured revision, so keep the previous key for a grace period. Run from a periodic job (for example the tip check), in bounded batches, and log the count of removed keys.
- **Tests:** live FalkorDB: an old key goes after the grace period; the active key and a captured key stay; a second run removes nothing.
