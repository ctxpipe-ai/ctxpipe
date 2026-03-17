terraform {
  required_providers {
    railway = {
      source  = "terraform-community-providers/railway"
      version = "0.6.1"
    }
    neon = {
      source  = "kislerdm/neon"
      version = "0.13.0"
    }
  }
}

resource "railway_project" "this" {
  name           = var.railway_project.name
  description    = try(var.railway_project.description, null)
  private        = try(var.railway_project.private, true)
  has_pr_deploys = try(var.railway_project.has_pr_deploys, false)
  workspace_id   = var.railway_workspace_id

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_environment" "this" {
  name       = var.railway_environment_name
  project_id = railway_project.this.id

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_service" "ui" {
  project_id = railway_project.this.id
  name       = "ctx| - ui"

  source_repo        = var.source_repo
  source_repo_branch = var.source_repo_branch
  config_path        = "/apps/ui/railway.json"

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_service" "backend" {
  project_id = railway_project.this.id
  name       = "ctx| - backend"

  source_repo        = var.source_repo
  source_repo_branch = var.source_repo_branch
  config_path        = "/apps/backend/railway.json"

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_service" "code_search" {
  project_id = railway_project.this.id
  name       = "CodeSearch"

  source_repo        = var.source_repo
  source_repo_branch = var.source_repo_branch
  config_path        = "/apps/codesearch/railway.json"
  volume = {
    name       = "codesearch-volume-vNK-"
    mount_path = "/data"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_service" "open_workflow" {
  project_id = railway_project.this.id
  name       = "OpenWorkflow"

  source_repo        = var.source_repo
  source_repo_branch = var.source_repo_branch
  config_path        = "/apps/backend/railway.worker.json"

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_service" "falkordb" {
  project_id = railway_project.this.id
  name       = "FalkorDB"

  source_image = "falkordb/falkordb"
  volume = {
    name       = "falkordb-volume"
    mount_path = "/var/lib/falkordb/data"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_variable" "falkordb_port" {
  environment_id = railway_environment.this.id
  service_id     = railway_service.falkordb.id
  name           = "FALKORDB_PORT"
  value          = "6379"
}

resource "railway_variable" "backend_graph_db_uri" {
  environment_id = railway_environment.this.id
  service_id     = railway_service.backend.id
  name           = "GRAPH_DB_URI"
  value          = "$${{FalkorDB.FALKORDB_PRIVATE_URL}}"
}

resource "railway_variable" "open_workflow_graph_db_uri" {
  environment_id = railway_environment.this.id
  service_id     = railway_service.open_workflow.id
  name           = "GRAPH_DB_URI"
  value          = "$${{FalkorDB.FALKORDB_PRIVATE_URL}}"
}

resource "neon_project" "this" {
  name       = var.neon_project.name
  org_id     = var.neon_project.org_id
  region_id  = var.neon_project.region_id
  pg_version = var.neon_project.pg_version

  history_retention_seconds = try(var.neon_project.history_retention_seconds, null)
  compute_provisioner       = try(var.neon_project.compute_provisioner, null)
  store_password            = try(var.neon_project.store_password, null)

  dynamic "maintenance_window" {
    for_each = try([var.neon_project.maintenance_window], [])
    content {
      start_time = maintenance_window.value.start_time
      end_time   = maintenance_window.value.end_time
      weekdays   = maintenance_window.value.weekdays
    }
  }

  dynamic "branch" {
    for_each = try([var.neon_project.branch], [])
    content {
      name          = branch.value.name
      database_name = branch.value.database_name
      role_name     = branch.value.role_name
    }
  }

  dynamic "default_endpoint_settings" {
    for_each = try([var.neon_project.default_endpoint_settings], [])
    content {
      autoscaling_limit_min_cu = default_endpoint_settings.value.autoscaling_limit_min_cu
      autoscaling_limit_max_cu = default_endpoint_settings.value.autoscaling_limit_max_cu
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

