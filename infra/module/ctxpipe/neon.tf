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

resource "neon_database" "postgres" {
  branch_id  = neon_branch.production.id
  name       = var.neon_project.branch.database_name
  owner_name = var.neon_project.branch.role_name
  project_id = neon_project.this.id
}

resource "neon_branch" "production" {
  name       = "production"
  protected  = "yes"
  project_id = neon_project.this.id
}

# Migrate creates ctxpipe_app in SQL with this password (role mode a, ADR-042).
# A role that the Neon API creates is a member of neon_superuser, which has
# BYPASSRLS, so the migrate safety check refuses it.
resource "random_password" "app_database" {
  length  = 40
  special = false
}

# Older states can hold the API role. Forget it and do not drop it: migrate
# takes over the role and sets the password above.
removed {
  from = neon_role.app

  lifecycle {
    destroy = false
  }
}

locals {
  owner_pooler_uri = neon_project.this.connection_uri_pooler
  pooler_after_user = replace(
    local.owner_pooler_uri,
    "//${neon_project.this.database_user}:",
    "//ctxpipe_app:",
  )
  app_database_url = (
    strcontains(local.pooler_after_user, ":${neon_project.this.database_password}@")
    ? replace(local.pooler_after_user, ":${neon_project.this.database_password}@", ":${random_password.app_database.result}@")
    : replace(local.pooler_after_user, ":${urlencode(neon_project.this.database_password)}@", ":${urlencode(random_password.app_database.result)}@")
  )
}

resource "terraform_data" "app_database_url" {
  input = local.app_database_url

  lifecycle {
    precondition {
      condition = (
        strcontains(local.app_database_url, "ctxpipe_app") &&
        local.app_database_url != local.owner_pooler_uri
      )
      error_message = "Failed to rewrite Neon pooler URL from the owner role to ctxpipe_app"
    }
  }
}
