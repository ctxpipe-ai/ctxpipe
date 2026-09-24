# ctxpipe-observability Terraform

Provisions services, variables, `telemetry.ctxpipe.ai` (collector), `hyperdx.ctxpipe.ai` (dashboard), and `langfuse.ctxpipe.ai` in the **existing** Railway project `305aa114-c6f3-4aca-b883-0faa9c331aa2`. Does not create the Railway project or a Neon project.

ClickHouse and the collector use the **Railway GitHub integration** (`source_repo` + `root_directory`). Image services (HyperDX, Langfuse, Redis, Mongo) pull public images. There is no `OBSERVABILITY_RAILWAY_TOKEN`.

The Railway bucket `langfuse-events` is created once outside this provider (0.6.1 has no bucket resource). Langfuse variables reference `${{langfuse-events.*}}`.

## Apply

```bash
cd ops/observability/terraform
cp terraform.tfvars.example terraform.tfvars   # fill secrets
terraform init \
  -backend-config="access_key=$R2_ACCESS_KEY_ID" \
  -backend-config="secret_key=$R2_SECRET_ACCESS_KEY"
terraform apply
```

First apply from this PR, before merge:

```bash
terraform apply -var='github_repo_branch=cursor/clickstack-langfuse-observability-8fbc'
```

After merge, apply again with `github_repo_branch=main`.

`RAILWAY_TOKEN` must be able to manage `ctxpipe-observability`. The product workspace token used by `infra/` is enough; do not mint a second project token.

## Neon

Langfuse uses a dedicated database `langfuse` (role `langfuse`) on the existing `ctxpipe` Neon project. A schema on `neondb` is not supported — Langfuse Prisma migrations hardcode `public`.
