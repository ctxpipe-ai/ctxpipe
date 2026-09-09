# Temporary recovery handoff — extract, then delete from Git

The user requested this temporary Git transfer because manual upload was unavailable. This is not product code or a completed recovery gate. Continue on `codex/develop-plan-to-refocus-branch-direction` through Gate 6.

Implementation checkpoint: `1c7b9657045ed56e62678c5a1d6a6e148925c04a`. Gates 0–3 are complete; Gate 4 is active; Gates 5–6 remain. The archive includes comprehensive instructions, remote setup, the uncommitted fixture patch, portable helper templates and selected evidence. It contains no production/model key. Provision required secrets through the remote platform.

## Extract outside the checkout

From the repository root, choose a private directory outside Git and preserve it for the duration of the task. This example allocates a fresh temporary directory; use the remote platform's durable private task directory instead if temporary directories do not survive its task lifecycle.

```bash
export CTXPIPE_REPO="$(git rev-parse --show-toplevel)"
export CTXPIPE_HANDOFF="$(mktemp -d "${TMPDIR:-/tmp}/ctxpipe-recovery-handoff.XXXXXX")"
tar -xzf "$CTXPIPE_REPO/docs/plans/workspace-recovery-transfer/ctxpipe-recovery-handoff-assets.tar.gz" -C "$CTXPIPE_HANDOFF"
python3 "$CTXPIPE_HANDOFF/verify-manifest.py"
```

Archive SHA256: `d66e01e7a49bc59224b0ffd8ca783119b71208a7607556f4e90a4a2466df74b6`.

Read the extracted `REMOTE-START-HERE.md` and `CONTINUE-CTXPIPE-RECOVERY.md` completely. Their initial delivery update supersedes earlier manual-upload wording. All paths are configured for your host; you have no access to the former agent's computer. Do not treat historical evidence paths as remote prerequisites.

## Delete the tracked transfer after verification

Once extraction and manifest verification succeed, retain the extracted files and remove **this entire transfer directory** from the checkout in a follow-up commit. This cleanup and pushes to the existing branch are explicitly authorized. Stage/commit only this directory so unrelated source changes are not included.

```bash
cd "$CTXPIPE_REPO"
git rm -r -- docs/plans/workspace-recovery-transfer
git commit -m "Remove temporary recovery handoff after extraction" -- docs/plans/workspace-recovery-transfer
git push origin HEAD:codex/develop-plan-to-refocus-branch-direction
```

This removes the bundle from the branch's current tree; normal Git history retains the transfer commit. Do not rewrite history or force-push to erase it. Do not delete the extracted private copy until the recovery is complete or transferred durably again.

Then follow the remote guide: inspect current CI, restore/reconcile `repository-wip.patch`, configure helpers using the actual checkout path, recreate required services, complete the authenticated Git/live-model journey and remaining gates. The fixture patch has not been runtime accepted; it is intentionally not applied to source by this transfer commit. All existing branch-push and model-key-use authorizations persist. Preserve architecture, security and proof requirements; use bounded economical execution and report real external blockers while continuing independent work.
