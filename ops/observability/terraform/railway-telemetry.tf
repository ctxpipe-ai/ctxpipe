resource "railway_service" "railway_telemetry" {
  project_id         = var.railway_project_id
  name               = "railway-telemetry"
  source_repo        = var.github_repo
  source_repo_branch = var.github_repo_branch
  root_directory     = "ops/observability/railway-telemetry"
  config_path        = "ops/observability/railway-telemetry/railway.toml"
  # Provider 0.6.1 Update sends cronSchedule with no omitempty. An unset
  # attribute clears the live */5 schedule. railway.toml uses the same value;
  # a GitHub deploy and a Terraform service update both keep this cron.
  cron_schedule = "*/5 * * * *"
  regions       = local.regions
  depends_on    = [railway_service.collector, railway_service.redis]

  lifecycle {
    # Provider 0.6.x Update() never sends multiRegionConfig (issue #77).
    # Desired region is us-east4-eqdc4a (ADR-029). Pin after apply with
    # RAILWAY_SERVICE_SET=observability scripts/railway-set-regions.sh.
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "railway_telemetry" {
  environment_id = var.railway_environment_id
  service_id     = railway_service.railway_telemetry.id

  # RAILWAY_API_TOKEN stays on Railway. API reads do not wake sleeping services.
  variables = [
    {
      name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
      value = "http://$${{collector.RAILWAY_PRIVATE_DOMAIN}}:4318"
    },
    {
      name  = "OTEL_EXPORTER_OTLP_HEADERS"
      value = "authorization=$${{collector.HYPERDX_API_KEY}}"
    },
    {
      name  = "REDIS_URL"
      value = "redis://$${{redis.RAILWAY_PRIVATE_DOMAIN}}:6379"
    },
  ]
}
