provider "railway" {
  # Configure via `RAILWAY_TOKEN` env var, or set `token` here for local testing.
}

provider "neon" {
  # Configure via `NEON_API_KEY` env var, or set `api_key` here for local testing.
}

module "ctxpipe" {
  source = "./module/ctxpipe"

  railway_workspace_id = "aa3ec44f-f8bd-4beb-bbe0-e4c46e20b14c"
  railway_project = {
    name           = "ctxpipe"
    description    = "This is the ctx| application deployed as our SaaS platform"
    private        = true
    has_pr_deploys = true
  }

  railway_environment_name = "production"

  image_tag               = var.image_tag
  better_auth_secret      = var.better_auth_secret
  langsmith_api_key       = var.langsmith_api_key
  model_provider_api_key  = var.model_provider_api_key
  model_provider          = var.model_provider
  smtp_connection_url     = var.smtp_connection_url
  github_private_key      = var.github_private_key
  github_client_secret    = var.github_client_secret
  github_webhook_secret   = var.github_webhook_secret
  atlassian_client_id     = var.atlassian_client_id
  atlassian_client_secret = var.atlassian_client_secret
  slack_client_id         = var.slack_client_id
  slack_client_secret     = var.slack_client_secret
  slack_signing_secret    = var.slack_signing_secret
  linear_client_id        = var.linear_client_id
  linear_client_secret    = var.linear_client_secret
  linear_redirect_uri     = var.linear_redirect_uri
  linear_webhook_secret   = var.linear_webhook_secret
  notion_client_id        = var.notion_client_id
  notion_client_secret    = var.notion_client_secret
  notion_webhook_secret   = var.notion_webhook_secret
  falkordb_password       = var.falkordb_password
  better_stack_token      = var.better_stack_token
  langfuse_auth_string    = var.langfuse_auth_string
  langfuse_otlp_endpoint  = var.langfuse_otlp_endpoint
  amplitude_api_key       = var.amplitude_api_key
  amplitude_region        = var.amplitude_region

  neon_project = {
    name                      = "ctxpipe"
    org_id                    = "org-steep-pine-64462726"
    region_id                 = "aws-us-east-1"
    pg_version                = 17
    history_retention_seconds = 86400
    compute_provisioner       = "k8s-neonvm"
    store_password            = "yes"
    maintenance_window = {
      start_time = "09:00"
      end_time   = "10:00"
      weekdays   = [5]
    }
    branch = {
      name          = "production"
      database_name = "neondb"
      role_name     = "neondb_owner"
    }
    default_endpoint_settings = {
      autoscaling_limit_min_cu = 0.25
      autoscaling_limit_max_cu = 8
    }
  }
  neon_migration_target = {
    name                      = "ctxpipe-singapore"
    org_id                    = "org-steep-pine-64462726"
    region_id                 = "aws-ap-southeast-1"
    pg_version                = 17
    history_retention_seconds = 86400
    compute_provisioner       = "k8s-neonvm"
    store_password            = "yes"
    maintenance_window = {
      start_time = "09:00"
      end_time   = "10:00"
      weekdays   = [5]
    }
    branch = {
      name          = "production"
      database_name = "neondb"
      role_name     = "neondb_owner"
    }
    default_endpoint_settings = {
      autoscaling_limit_min_cu = 0.25
      autoscaling_limit_max_cu = 8
    }
  }
  neon_database_target            = var.neon_database_target
  neon_source_logical_replication = var.neon_source_logical_replication
}
