# ADR-054: Secrets go from GitHub Environments straight to Railway

**Status:** Accepted | **Date:** 2026-10-22 | **Tags:** secrets, railway, terraform, github-actions, observability

## Context

The hosted product and the observability stack run on Railway. Their secrets reached Railway in three ways:

- **Product (`infra/`).** Each secret was a Terraform input. Terraform wrote it to the Railway service variables, so each value was also in plain text in the Terraform state. The PR plan needed the production secrets only to avoid a false diff.
- **Observability, cost telemetry.** The GitHub Environment held each value, and a script wrote it to Railway. The values stayed out of the state.
- **Observability, the rest.** Values set once in Railway, with no copy in code. Nobody could rebuild or rotate them from the repository.

A security incident on Railway required a rotation of every secret.

## Decision

1. **The GitHub Environment is the only source of each secret.** `production` holds the product secrets. `observability` holds the observability secrets. No secret is set by hand in Railway.
2. **One script writes them to Railway.** `scripts/railway-sync-variables.py` maps each GitHub secret to the variables of each Railway service and writes it with the Railway API. An empty optional secret is deleted from the service.
3. **Terraform holds no secret value.** It holds the values that are not secret and the Railway references (`${{service.VARIABLE}}`). A value that Terraform itself makes, such as a database password, is the only secret in the state.
4. **The deploy applies a change.** The product deploy writes the secrets before the new images start. The observability apply writes them after Terraform. When a value changes, the deploy redeploys the services that read it, in the order of their references. A re-run redeploys every such service.
5. **Each environment holds its own value.** `production` and `Preview` never share a credential (see `AGENTS.md`).

## Consequences

- The state, the plan output, and the PR plan job hold no app secret.
- A rotation is: set the new value in GitHub, then deploy. A value that a service stores itself (for example the Langfuse init user, or the key that encrypts stored connection secrets) needs its own procedure.
- The deploy job that runs the sync holds every secret of its environment.
- Railway PR previews start as a copy of the production variables. A preview script must replace each production secret that a preview must not hold.

## Alternatives considered

- **Terraform inputs with a hardened state.** Anyone who can read the state still reads every secret.
- **Railway shared or sealed variables as the source.** Nothing in code could rebuild or rotate them.
- **An outside secret manager.** Possible later. It still needs a delivery path to Railway, which this script is.
