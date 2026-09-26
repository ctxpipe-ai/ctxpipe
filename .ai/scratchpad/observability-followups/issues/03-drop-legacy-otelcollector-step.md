# Drop the leftover preview otelcollector step

Status: ready-for-human

Remove the preview `otelcollector` scale-to-zero block in [`.github/workflows/pr-deploy.yaml`](../../../../.github/workflows/pr-deploy.yaml) (the `OTELCOLLECTOR_SERVICE_ID` branch, about lines 659–668).

Production Terraform does not create `otelcollector`. The step only stops a copy left on a preview environment created before that service was removed. Drop the step once no preview environment still has a service named `otelcollector`.

## Comments
