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
  falkordb_port = 6379
  shared_backend_env_variables = [
    {
      name  = "AUTH_SECRET"
      value = var.better_auth_secret
    },
    {
      name  = "CODESEARCH_URL"
      value = "http://$${{codesearch.RAILWAY_PRIVATE_DOMAIN}}:$${{codesearch.PORT}}"
    },
    {
      name  = "DATABASE_URL"
      value = local.database_url
    },
    {
      name  = "EMAIL_FROM_ADDRESS"
      value = "noreply@ctxpipe.ai"
    },
    {
      name  = "ENABLE_LANGSMITH"
      value = "TRUE"
    },
    {
      name  = "LANGSMITH_API_KEY"
      value = var.langsmith_api_key
    },
    {
      name  = "MODEL_PROVIDER_API_KEY",
      value = var.model_provider_api_key
    },
    {
      name  = "SMTP_CONNECTION_URL"
      value = var.smtp_connection_url
    },
    {
      name  = "UI_PROXY_URL",
      value = "http://$${{ui.RAILWAY_PRIVATE_DOMAIN}}:$${{ui.PORT}}"
    },
    {
      name  = "GITHUB_APP_ID",
      value = "3037875"
    },
    {
      name  = "GITHUB_PRIVATE_KEY",
      value = var.github_private_key
    },
    {
      name  = "GRAPH_DB_URI",
      value = "$${{falkordb.FALKORDB_PRIVATE_URL}}"
    },
    {
      name  = "GITHUB_CLIENT_ID",
      value = "Iv23lidGWi9ouvBjgvbv"
    },
    {
      name  = "GITHUB_CLIENT_SECRET",
      value = var.github_client_secret
    }
  ]
}

resource "railway_service" "ui" {
  project_id = railway_project.this.id
  name       = "ui"

  source_image                   = "${var.ui_source_image}:${var.image_tag}"
  source_image_registry_username = var.source_image_registry_username
  source_image_registry_password = var.source_image_registry_password

  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_variable_collection" "ui_env" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.ui.id

  variables = [
    {
      name  = "NODE_ENV"
      value = "production"
    },
    {
      name  = "PORT"
      value = "3002"
    }
  ]
}

resource "railway_service" "backend" {
  project_id = railway_project.this.id
  name       = "backend"

  source_image                   = "${var.backend_source_image}:${var.image_tag}"
  source_image_registry_username = var.source_image_registry_username
  source_image_registry_password = var.source_image_registry_password
  depends_on = [ railway_service.falkordb, railway_service.ui, railway_service.code_search ]
  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_service_domain" "backend" {
  subdomain      = "ctxpipe-backend"
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.backend.id
}

resource "railway_custom_domain" "app" {
  domain         = "app.ctxpipe.ai"
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.backend.id
}

resource "railway_variable_collection" "backend_env" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.backend.id

  variables = concat(local.shared_backend_env_variables, [
    {
      name  = "AUTH_ALLOWED_ORIGINS"
      value = "https://$${{RAILWAY_PUBLIC_DOMAIN}}"
    },
    {
      name  = "AUTH_BASE_URL"
      value = "https://$${{RAILWAY_PUBLIC_DOMAIN}}"
    },
  ])
}

resource "railway_service" "code_search" {
  project_id = railway_project.this.id
  name       = "codesearch"

  source_image                   = "${var.codesearch_source_image}:${var.image_tag}"
  source_image_registry_username = var.source_image_registry_username
  source_image_registry_password = var.source_image_registry_password
  volume = {
    name       = "codesearch-volume-vNK-"
    mount_path = "/data"
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_variable_collection" "code_search_env" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.code_search.id

  variables = [
    {
      name  = "AUTH_SECRET"
      value = var.better_auth_secret
    },
    {
      name  = "AUTH_TOKEN_AUDIENCE_CODESEARCH",
      value = "codesearch"
    },
    {
      name  = "DATABASE_URL"
      value = local.database_url
    },
    {
      name  = "NODE_ENV",
      value = "production"
    },
    {
      name  = "PORT",
      value = "3001"
    },
    {
      name  = "ZOEKT_WEBSERVER_URL",
      value = "http://localhost:6070"
    }
  ]
}

resource "railway_service" "open_workflow" {
  project_id = railway_project.this.id
  name       = "openworkflow"

  source_image                   = "${var.worker_source_image}:${var.image_tag}"
  source_image_registry_username = var.source_image_registry_username
  source_image_registry_password = var.source_image_registry_password
  depends_on = [ railway_service.falkordb, railway_service.backend ]
  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_variable_collection" "open_workflow_env" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.open_workflow.id

  variables = concat(local.shared_backend_env_variables, [
    {
      name  = "AUTH_ALLOWED_ORIGINS"
      value = "https://$${{backend.RAILWAY_PUBLIC_DOMAIN}}"
    },
    {
      name  = "AUTH_BASE_URL"
      value = "https://$${{backend.RAILWAY_PUBLIC_DOMAIN}}"
    },
  ])
}

resource "railway_service" "falkordb" {
  project_id = railway_project.this.id
  name       = "falkordb"

  source_image = "falkordb/falkordb"
  volume = {
    name       = "falkordb-volume"
    mount_path = "/var/lib/falkordb/data"
  }
  lifecycle {
    prevent_destroy = true
  }
}

resource "railway_variable_collection" "falkordb_env" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.falkordb.id

  variables = [
    {
      name  = "FALKORDB_ARGS",
      value = "--port ${local.falkordb_port} --bind 0.0.0.0 :: --protected-mode no"
    },
    {
      name  = "FALKORDB_PASSWORD",
      value = var.falkordb_password
    },
    {
      name  = "FALKORDB_PORT",
      value = local.falkordb_port
    },
    {
      name  = "FALKORDB_PRIVATE_URL",
      value = "redis://default:${var.falkordb_password}@falkordb.railway.internal:${local.falkordb_port}"
    },
    {
      name  = "PORT",
      value = "3000"
    },
    {
      name  = "REDIS_ARGS",
      value = "--requirepass ${var.falkordb_password}"
    }
  ]
}
