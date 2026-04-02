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

  railway_regions = [
    {
      region       = "us-east4-eqdc4a"
      num_replicas = 1
    },
  ]

  image_tag                      = var.image_tag
  source_image_registry_username = var.source_image_registry_username
  source_image_registry_password = var.source_image_registry_password
  better_auth_secret             = var.better_auth_secret
  langsmith_api_key              = var.langsmith_api_key
  model_provider_api_key         = var.model_provider_api_key
  smtp_connection_url            = var.smtp_connection_url
  github_private_key             = var.github_private_key
  github_client_secret           = var.github_client_secret
  atlassian_client_id            = var.atlassian_client_id
  atlassian_client_secret        = var.atlassian_client_secret
  falkordb_password              = var.falkordb_password

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
}

