# Drop the otelcollector removed blocks and delete allowlist

Status: ready-for-human

After the first production apply destroys `module.ctxpipe.railway_service.otelcollector` and `module.ctxpipe.railway_variable_collection.otelcollector_env`, delete the two `removed` blocks in [`infra/main.tf`](../../../../infra/main.tf) and empty the `allow` list in the "Refuse unexpected deletes" step of [`.github/workflows/deploy.yaml`](../../../../.github/workflows/deploy.yaml). Keep the step itself.

## Comments
