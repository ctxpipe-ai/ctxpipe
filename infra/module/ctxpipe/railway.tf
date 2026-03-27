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

locals {
  database_url = neon_project.this.connection_uri_pooler
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

  source_image                    = "${var.ui_source_image}:${var.image_tag}"
  source_image_registry_username  = var.source_image_registry_username
  source_image_registry_password  = var.source_image_registry_password

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_service" "backend" {
  project_id = railway_project.this.id
  name       = "ctx| - backend"

  source_image                    = "${var.backend_source_image}:${var.image_tag}"
  source_image_registry_username  = var.source_image_registry_username
  source_image_registry_password  = var.source_image_registry_password

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_service" "code_search" {
  project_id = railway_project.this.id
  name       = "CodeSearch"

  source_image                    = "${var.codesearch_source_image}:${var.image_tag}"
  source_image_registry_username  = var.source_image_registry_username
  source_image_registry_password  = var.source_image_registry_password
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

  source_image                    = "${var.worker_source_image}:${var.image_tag}"
  source_image_registry_username  = var.source_image_registry_username
  source_image_registry_password  = var.source_image_registry_password

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

resource "railway_variable" "backend_database_url" {
  environment_id = railway_environment.this.id
  service_id     = railway_service.backend.id
  name           = "DATABASE_URL"
  value          = local.database_url
}

resource "railway_variable" "open_workflow_graph_db_uri" {
  environment_id = railway_environment.this.id
  service_id     = railway_service.open_workflow.id
  name           = "GRAPH_DB_URI"
  value          = "$${{FalkorDB.FALKORDB_PRIVATE_URL}}"
}
