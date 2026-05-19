# Changesets

Run `pnpm changeset` when a PR includes release-worthy changes to publishable packages under `packages/`.

## Release flow

1. Merge a PR that includes one or more `.changeset/*.md` files.
2. The [Deploy workflow](../.github/workflows/deploy.yaml) runs `changesets/action`, which opens or updates a **chore(release): version packages** PR (version bumps + changelog updates).
3. Review and merge that version PR; the same workflow then publishes changed publishable packages to npm.
