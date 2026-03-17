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
    name           = "ctx| - app"
    description    = "This is the ctx| application deployed as our SaaS platform"
    private        = true
    has_pr_deploys = true
    default_environment = {
      name = "production"
    }
  }

  railway_environment_name = "production"

  railway_regions = [
    {
      region       = "us-east4-eqdc4a"
      num_replicas = 1
    },
  ]

  source_repo        = "ctxpipe-ai/ctxpipe"
  source_repo_branch = "main"

  services = {
    ui = {
      name        = "ctx| - ui"
      config_path = "/apps/ui/railway.json"
    }
    backend = {
      name        = "ctx| - backend"
      config_path = "/apps/backend/railway.json"
    }
    code_search = {
      name        = "CodeSearch"
      config_path = "/apps/codesearch/railway.json"
      volume = {
        name       = "codesearch-volume-vNK-"
        mount_path = "/data"
      }
    }
    open_workflow = {
      name        = "OpenWorkflow"
      config_path = "/apps/backend/railway.worker.json"
    }
    falkordb = {
      name         = "FalkorDB"
      source_image = "falkordb/falkordb"
      volume = {
        name       = "falkordb-volume"
        mount_path = "/var/lib/falkordb/data"
      }
    }
  }

  railway_service_variables = [
    {
      service_key = "falkordb"
      name        = "FALKORDB_PORT"
      value       = "6379"
    },
    {
      service_key = "backend"
      name        = "GRAPH_DB_URI"
      value       = "redis://falkordb:6379"
    },
  ]

  neon_project = {
    name                     = "ctxpipe"
    org_id                   = "org-steep-pine-64462726"
    region_id                = "aws-us-east-1"
    pg_version               = 17
    history_retention_seconds = 86400
    compute_provisioner      = "k8s-neonvm"
    store_password           = "yes"
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

