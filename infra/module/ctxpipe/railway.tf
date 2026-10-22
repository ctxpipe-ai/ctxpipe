resource "railway_project" "this" {
  name           = var.railway_project.name
  description    = try(var.railway_project.description, null)
  private        = try(var.railway_project.private, true)
  has_pr_deploys = try(var.railway_project.has_pr_deploys, false)
  workspace_id   = var.railway_workspace_id

  lifecycle {
    prevent_destroy = true
    # Railway provider 0.6.1 Update() writes the first environment that
    # projectUpdate returns into default_environment, without the sort by age
    # that Read() does. When a pr-* environment comes first, the apply fails
    # with "Provider produced inconsistent result after apply". Thus
    # Terraform never updates this project. Change the project settings in
    # the Railway UI. Read() still refreshes default_environment, oldest first.
    ignore_changes = all

    # Each variable below writes to default_environment.id. Stop the plan
    # when that is not the environment we deploy, so that production values
    # never go to a PR environment.
    postcondition {
      condition     = self.default_environment.name == var.railway_environment_name
      error_message = "The oldest environment of the Railway project is not \"${var.railway_environment_name}\". Terraform would write the production variables to the wrong environment. Fix: make sure that the ${var.railway_environment_name} environment exists and is the oldest environment in the project, then run Deploy again."
    }
  }
}

locals {
  database_url  = local.app_database_url
  falkordb_port = 6379
  # Honor var.railway_regions (default us-east4-eqdc4a). A direct assign
  # or `for` over the list fails plan in railway 0.6.1 (ServiceResourceRegionModel
  # "unknown value"). Expanding the one element into an HCL object still
  # reads the variable. See variable validation (exactly one region).
  # Do not hardcode Singapore — that leftover default left compute 200ms from Postgres.
  regions = [
    {
      num_replicas = var.railway_regions[0].num_replicas
      region       = var.railway_regions[0].region
    }
  ]
  otel_shared_env = [
    {
      name  = "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"
      value = "${var.otel_otlp_endpoint}/v1/traces"
    },
    {
      name  = "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"
      value = "${var.otel_otlp_endpoint}/v1/logs"
    },
    {
      name  = "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT"
      value = "${var.otel_otlp_endpoint}/v1/metrics"
    },
  ]
  # Omit when unset so parseEnv does not see an empty string.
  linear_shared_env = length(var.linear_redirect_uri) > 0 ? [{
    name  = "LINEAR_REDIRECT_URI"
    value = var.linear_redirect_uri
  }] : []
  pagerduty_shared_env = length(var.pagerduty_redirect_uri) > 0 ? [{
    name  = "PAGERDUTY_REDIRECT_URI"
    value = var.pagerduty_redirect_uri
  }] : []
  # Secret values are not here: scripts/railway-sync-variables.py writes them
  # from the GitHub Environment, so they never enter the Terraform state.
  shared_backend_env_variables = concat([
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
      name  = "MODEL_PROVIDER"
      value = var.model_provider
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
      name  = "GITHUB_APP_SLUG",
      value = "ctxpipe-agent"
    },
    {
      name  = "GRAPH_DB_URI",
      value = "$${{falkordb.FALKORDB_PRIVATE_URL}}"
    },
    {
      name  = "GITHUB_CLIENT_ID",
      value = "Iv23lidGWi9ouvBjgvbv"
    },
    # Hosted chat runs each conversation in a Vercel sandbox; never unsandboxed.
    {
      name  = "SANDBOX_PROVIDER"
      value = "vercel"
    },
    {
      name  = "VERCEL_TEAM_ID"
      value = "ctxpipe"
    },
    {
      name  = "VERCEL_PROJECT_ID"
      value = "ctxpipe"
    },
  ], local.otel_shared_env, local.linear_shared_env, local.pagerduty_shared_env)
}

resource "railway_service" "ui" {
  project_id   = railway_project.this.id
  name         = "ui"
  regions      = local.regions
  source_image = "${var.ui_source_image}:${var.image_tag}"

  lifecycle {
    prevent_destroy = true
    # SHA rolls are environment-scoped GraphQL in CI. Terraform Update()
    # calls serviceConnect + redeployAllInstances and would overwrite pr-* envs.
    # Provider 0.6.x Update() never sends multiRegionConfig (issue #77).
    # Region writes go through scripts/railway-set-regions.sh.
    # The same Update() connects source_image for the whole project and
    # redeploys every environment. Image tags go through
    # scripts/railway-set-images.sh (ADR-039).
    ignore_changes = [regions, source_image]
  }
}

resource "railway_variable_collection" "ui_config" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.ui.id
  # AUTH_BASE_URL refers to backend.PORT. Write the backend variables first,
  # so the reference never resolves empty when the UI redeploys.
  depends_on = [railway_variable_collection.backend_config]

  variables = concat([
    {
      name  = "NODE_ENV"
      value = "production"
    },
    {
      name  = "PORT"
      value = "3002"
    },
    {
      # Nitro/Vinxi default bind is localhost; Railway healthchecks need 0.0.0.0.
      name  = "HOST"
      value = "0.0.0.0"
    },
    {
      name  = "NITRO_HOST"
      value = "0.0.0.0"
    },
    {
      # UI SSR must reach the backend (not localhost baked into VITE_PUBLIC_API_URL).
      name  = "AUTH_BASE_URL"
      value = "http://$${{backend.RAILWAY_PRIVATE_DOMAIN}}:$${{backend.PORT}}"
    },
    {
      # The browser OTLP relay (`/.otel`) accepts only these origins. The
      # private AUTH_BASE_URL above is not an origin that a browser uses.
      name  = "AUTH_ALLOWED_ORIGINS"
      value = "https://${railway_custom_domain.app.domain},https://$${{backend.RAILWAY_PUBLIC_DOMAIN}}"
    }
  ], local.otel_shared_env)
}

resource "railway_service" "backend" {
  project_id   = railway_project.this.id
  name         = "backend"
  regions      = local.regions
  source_image = "${var.backend_source_image}:${var.image_tag}"
  depends_on   = [railway_service.falkordb, railway_service.ui, railway_service.code_search]
  lifecycle {
    prevent_destroy = true
    # SHA rolls are environment-scoped GraphQL in CI.
    # Provider 0.6.x Update() never sends multiRegionConfig (issue #77).
    # Region writes go through scripts/railway-set-regions.sh.
    # The same Update() connects source_image for the whole project and
    # redeploys every environment. Image tags go through
    # scripts/railway-set-images.sh (ADR-039).
    ignore_changes = [regions, source_image]
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

resource "railway_custom_domain" "www_app" {
  domain         = "www.app.ctxpipe.ai"
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.backend.id
}

resource "railway_variable_collection" "backend_config" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.backend.id
  # GRAPH_DB_URI refers to FALKORDB_PRIVATE_URL, which refers to the synced
  # FALKORDB_PASSWORD. Write FalkorDB first, so this redeploy reads the URL
  # with the password that FalkorDB uses.
  depends_on = [terraform_data.app_database_url, railway_variable_collection.falkordb_config]

  variables = concat(local.shared_backend_env_variables, [
    {
      name  = "AUTH_ALLOWED_ORIGINS"
      value = "https://$${{RAILWAY_PUBLIC_DOMAIN}}"
    },
    {
      name  = "AUTH_BASE_URL"
      value = "https://$${{RAILWAY_PUBLIC_DOMAIN}}"
    },
    {
      name  = "OTEL_SERVICE_NAME"
      value = "backend"
    },
    {
      # The UI reaches the backend over the private network on this port
      # (ui_config AUTH_BASE_URL). Set it here so it does not depend on the
      # PORT value that Railway injects at runtime.
      name  = "PORT"
      value = "8080"
    },
  ])
}

resource "railway_service" "code_search" {
  project_id   = railway_project.this.id
  name         = "codesearch"
  regions      = local.regions
  source_image = "${var.codesearch_source_image}:${var.image_tag}"
  volume = {
    name       = "codesearch-volume-vNK-"
    mount_path = "/data"
  }
  lifecycle {
    prevent_destroy = true
    # SHA rolls are environment-scoped GraphQL in CI.
    # Provider 0.6.x Update() never sends multiRegionConfig (issue #77).
    # Region writes go through scripts/railway-set-regions.sh.
    # The same Update() connects source_image for the whole project and
    # redeploys every environment. Image tags go through
    # scripts/railway-set-images.sh (ADR-039).
    ignore_changes = [regions, source_image]
  }
}

resource "railway_variable_collection" "code_search_config" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.code_search.id
  depends_on     = [terraform_data.app_database_url]

  variables = concat([
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
    },
    {
      name  = "OTEL_SERVICE_NAME",
      value = "codesearch"
    },
    {
      name  = "CODESEARCH_INDEXER_CONCURRENCY"
      value = var.codesearch_indexer_concurrency
    },
    {
      name  = "CODESEARCH_INDEX_PIPELINE_CONCURRENCY"
      value = var.codesearch_index_pipeline_concurrency
    }
  ], local.otel_shared_env)
}

resource "railway_service" "open_workflow" {
  project_id   = railway_project.this.id
  name         = "openworkflow"
  regions      = local.regions
  source_image = "${var.worker_source_image}:${var.image_tag}"
  depends_on   = [railway_service.falkordb, railway_service.backend]
  lifecycle {
    prevent_destroy = true
    # SHA rolls are environment-scoped GraphQL in CI.
    # Provider 0.6.x Update() never sends multiRegionConfig (issue #77).
    # Region writes go through scripts/railway-set-regions.sh.
    # The same Update() connects source_image for the whole project and
    # redeploys every environment. Image tags go through
    # scripts/railway-set-images.sh (ADR-039).
    ignore_changes = [regions, source_image]
  }
}

resource "railway_variable_collection" "open_workflow_config" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.open_workflow.id
  # GRAPH_DB_URI refers to FALKORDB_PRIVATE_URL, which refers to the synced
  # FALKORDB_PASSWORD. Write FalkorDB first, so this redeploy reads the URL
  # with the password that FalkorDB uses.
  depends_on = [terraform_data.app_database_url, railway_variable_collection.falkordb_config]

  variables = concat(local.shared_backend_env_variables, [
    {
      name  = "AUTH_ALLOWED_ORIGINS"
      value = "https://$${{backend.RAILWAY_PUBLIC_DOMAIN}}"
    },
    {
      name  = "AUTH_BASE_URL"
      value = "https://$${{backend.RAILWAY_PUBLIC_DOMAIN}}"
    },
    {
      name  = "OTEL_SERVICE_NAME"
      value = "openworkflow"
    },
    {
      name  = "OPENWORKFLOW_CONCURRENCY"
      value = var.openworkflow_concurrency
    },
    {
      # Railway sends SIGTERM and waits this long before SIGKILL (the default
      # is 0). The worker marks its step attempts stopped in this time, and
      # the supervisor kills the worker after 25 seconds.
      name  = "RAILWAY_DEPLOYMENT_DRAINING_SECONDS"
      value = "30"
    },
    {
      name  = "CODESEARCH_INDEXER_CONCURRENCY"
      value = var.codesearch_indexer_concurrency
    },
  ])
}

resource "railway_service" "falkordb" {
  project_id   = railway_project.this.id
  name         = "falkordb"
  regions      = local.regions
  source_image = "falkordb/falkordb"
  volume = {
    name       = "falkordb-volume"
    mount_path = "/var/lib/falkordb/data"
  }
  lifecycle {
    prevent_destroy = true
    # Provider 0.6.x Update() never sends multiRegionConfig (issue #77).
    ignore_changes = [regions]
  }
}

resource "railway_variable_collection" "falkordb_config" {
  environment_id = railway_project.this.default_environment.id
  service_id     = railway_service.falkordb.id

  variables = [
    {
      name  = "FALKORDB_ARGS",
      value = "--port ${local.falkordb_port} --bind 0.0.0.0 :: --protected-mode no"
    },
    {
      name  = "FALKORDB_PORT",
      value = local.falkordb_port
    },
    {
      name  = "FALKORDB_PRIVATE_URL",
      value = "redis://default:$${{FALKORDB_PASSWORD}}@falkordb.railway.internal:${local.falkordb_port}"
    },
    {
      name  = "PORT",
      value = "3000"
    },
    {
      name  = "REDIS_ARGS",
      value = "--requirepass $${{FALKORDB_PASSWORD}}"
    }
  ]
}

# The *_env collections held the secret values too. Terraform forgets them and
# does not delete their variables: an Update or Delete of a collection deletes
# each variable that leaves it. The *_config collections take over the values
# that are not secret, and railway-sync-variables.py owns the secret ones.
# Delete these blocks after the first apply that forgets the collections.
removed {
  from = railway_variable_collection.ui_env
  lifecycle {
    destroy = false
  }
}

removed {
  from = railway_variable_collection.backend_env
  lifecycle {
    destroy = false
  }
}

removed {
  from = railway_variable_collection.code_search_env
  lifecycle {
    destroy = false
  }
}

removed {
  from = railway_variable_collection.open_workflow_env
  lifecycle {
    destroy = false
  }
}

removed {
  from = railway_variable_collection.falkordb_env
  lifecycle {
    destroy = false
  }
}
