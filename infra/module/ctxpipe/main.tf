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

locals {
  railway_services = var.services
}

resource "railway_project" "this" {
  name           = var.railway_project.name
  description    = try(var.railway_project.description, null)
  private        = try(var.railway_project.private, true)
  has_pr_deploys = try(var.railway_project.has_pr_deploys, false)
  workspace_id   = var.railway_workspace_id

  dynamic "default_environment" {
    for_each = try([var.railway_project.default_environment], [])
    content {
      name = default_environment.value.name
    }
  }

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

resource "railway_service" "this" {
  for_each = local.railway_services

  project_id = railway_project.this.id
  name       = each.value.name

  source_repo        = var.source_repo
  source_repo_branch = var.source_repo_branch

  config_path  = try(each.value.config_path, null)
  source_image = try(each.value.source_image, null)

  dynamic "regions" {
    for_each = var.railway_regions
    content {
      region       = regions.value.region
      num_replicas = regions.value.num_replicas
    }
  }

  dynamic "volume" {
    for_each = try([each.value.volume], [])
    content {
      name       = volume.value.name
      mount_path = volume.value.mount_path
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_variable" "service" {
  for_each = {
    for v in var.railway_service_variables :
    "${v.service_key}:${v.name}" => v
  }

  environment_id = railway_environment.this.id
  service_id     = railway_service.this[each.value.service_key].id
  name           = each.value.name
  value          = each.value.value
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

