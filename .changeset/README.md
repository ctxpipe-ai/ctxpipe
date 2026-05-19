# Changesets

Run `pnpm changeset` when a PR includes release-worthy changes to publishable packages (currently `@ctxpipe/aws-cdk`).

## Release flow

1. Merge a PR that includes one or more `.changeset/*.md` files.
2. The [Release workflow](.github/workflows/release.yml) opens or updates a **chore(release): version packages** PR (bumps versions, changelog, and pins the service image tag to the triggering commit).
3. Review and merge that version PR; the same workflow then publishes `@ctxpipe/aws-cdk` to npm.
