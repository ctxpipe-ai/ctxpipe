#!/usr/bin/env python3
"""Copy GitHub Environment secrets to Railway service variables.

The values go straight to Railway, so they never enter Terraform inputs,
plans, or state. Terraform owns only the variables that are not secret.
"""

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request


# Railway variable -> GitHub Environment secret, for each Railway service.
PRODUCT_APP = {
    "AUTH_SECRET": "BETTER_AUTH_SECRET",
    "CONNECTION_SECRETS_ENCRYPTION_KEY": "CONNECTION_SECRETS_ENCRYPTION_KEY",
    "MODEL_PROVIDER_API_KEY": "MODEL_PROVIDER_API_KEY",
    "SMTP_CONNECTION_URL": "SMTP_CONNECTION_URL",
    "GITHUB_PRIVATE_KEY": "GH_PRIVATE_KEY",
    "GITHUB_CLIENT_SECRET": "GH_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET": "GH_WEBHOOK_SECRET",
    "ATLASSIAN_CLIENT_ID": "ATLASSIAN_CLIENT_ID",
    "ATLASSIAN_CLIENT_SECRET": "ATLASSIAN_CLIENT_SECRET",
    "NOTION_CLIENT_ID": "NOTION_CLIENT_ID",
    "NOTION_CLIENT_SECRET": "NOTION_CLIENT_SECRET",
    "NOTION_WEBHOOK_SECRET": "NOTION_WEBHOOK_SECRET",
    "SLACK_CLIENT_ID": "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET": "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET": "SLACK_SIGNING_SECRET",
    "LINEAR_CLIENT_ID": "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET": "LINEAR_CLIENT_SECRET",
    "LINEAR_WEBHOOK_SECRET": "LINEAR_WEBHOOK_SECRET",
    "PAGERDUTY_CLIENT_ID": "PAGERDUTY_CLIENT_ID",
    "PAGERDUTY_CLIENT_SECRET": "PAGERDUTY_CLIENT_SECRET",
    "VERCEL_TOKEN": "VERCEL_ACCESS_TOKEN",
    "OTEL_EXPORTER_OTLP_HEADERS": "OBSERVABILITY_OTLP_HEADERS",
    "BETTER_AUTH_API_KEY": "BETTER_AUTH_API_KEY",
    "CONFLUENCE_FORGE_INSTALL_URL": "CONFLUENCE_FORGE_INSTALL_URL",
}
SERVICE_VARIABLES = {
    # Product project (GitHub Environment `production`).
    "backend": PRODUCT_APP,
    "openworkflow": PRODUCT_APP,
    "codesearch": {
        "AUTH_SECRET": "BETTER_AUTH_SECRET",
        "OTEL_EXPORTER_OTLP_HEADERS": "OBSERVABILITY_OTLP_HEADERS",
    },
    "ui": {"OTEL_EXPORTER_OTLP_HEADERS": "OBSERVABILITY_OTLP_HEADERS"},
    "falkordb": {"FALKORDB_PASSWORD": "FALKORDB_PASSWORD"},
    # Observability project (GitHub Environment `observability`).
    "clickhouse": {
        "CLICKHOUSE_OTEL_PASSWORD": "CLICKHOUSE_OTEL_PASSWORD",
        "CLICKHOUSE_LANGFUSE_PASSWORD": "CLICKHOUSE_LANGFUSE_PASSWORD",
    },
    # The workflow makes LANGFUSE_AUTH_STRING from the Langfuse project keys.
    "collector": {
        "HYPERDX_API_KEY": "HYPERDX_API_KEY",
        "LANGFUSE_AUTH_STRING": "LANGFUSE_AUTH_STRING",
    },
    # langfuse-worker refers to the database URLs, SALT and ENCRYPTION_KEY of
    # langfuse-web.
    "langfuse-web": {
        "DATABASE_URL": "LANGFUSE_DATABASE_URL",
        "DIRECT_URL": "LANGFUSE_DIRECT_URL",
        "NEXTAUTH_SECRET": "LANGFUSE_NEXTAUTH_SECRET",
        "SALT": "LANGFUSE_SALT",
        "ENCRYPTION_KEY": "LANGFUSE_ENCRYPTION_KEY",
        "LANGFUSE_INIT_PROJECT_PUBLIC_KEY": "LANGFUSE_PUBLIC_KEY",
        "LANGFUSE_INIT_PROJECT_SECRET_KEY": "LANGFUSE_SECRET_KEY",
        "LANGFUSE_INIT_USER_EMAIL": "LANGFUSE_INIT_USER_EMAIL",
        "LANGFUSE_INIT_USER_PASSWORD": "LANGFUSE_INIT_USER_PASSWORD",
    },
    # No secret of their own: they refer to the values above, so they only
    # redeploy (--redeploy) after a change.
    "hyperdx": {},
    "langfuse-worker": {},
    # Both telemetry services read Railway with the same workspace token.
    "cost-telemetry": {
        "OPENROUTER_MANAGEMENT_KEY": "COST_TELEMETRY_OPENROUTER_MANAGEMENT_KEY",
        "GITHUB_BILLING_TOKEN": "COST_TELEMETRY_GITHUB_BILLING_TOKEN",
        "BLACKSMITH_TOKEN": "COST_TELEMETRY_BLACKSMITH_TOKEN",
        "NEON_API_KEY": "COST_TELEMETRY_NEON_API_KEY",
        "NEON_ORG_ID": "COST_TELEMETRY_NEON_ORG_ID",
        "CLOUDFLARE_API_TOKEN": "COST_TELEMETRY_CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_ACCOUNT_ID": "COST_TELEMETRY_CLOUDFLARE_ACCOUNT_ID",
        "RAILWAY_API_TOKEN": "TELEMETRY_RAILWAY_WORKSPACE_TOKEN",
        "AWS_ACCESS_KEY_ID": "COST_TELEMETRY_AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY": "COST_TELEMETRY_AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN": "COST_TELEMETRY_AWS_SESSION_TOKEN",
    },
    "railway-telemetry": {"RAILWAY_API_TOKEN": "TELEMETRY_RAILWAY_WORKSPACE_TOKEN"},
}
# Secrets that may be empty. An empty one is deleted from the service, so the
# service turns that integration off and an old value does not stay live.
OPTIONAL = {
    "SLACK_CLIENT_ID",
    "SLACK_CLIENT_SECRET",
    "SLACK_SIGNING_SECRET",
    "LINEAR_CLIENT_ID",
    "LINEAR_CLIENT_SECRET",
    "LINEAR_WEBHOOK_SECRET",
    "PAGERDUTY_CLIENT_ID",
    "PAGERDUTY_CLIENT_SECRET",
    "COST_TELEMETRY_AWS_SESSION_TOKEN",
    "BETTER_AUTH_API_KEY",
    "CONFLUENCE_FORGE_INSTALL_URL",
}
# Variables that no code uses any more. The sync deletes them from each
# service it writes.
RETIRED = {"BETTER_STACK_TOKEN"}
# A Railway PR preview starts as a copy of the production variables. With
# --preview, the values come from the GitHub Environment `Preview`, and each
# empty one is deleted, so no production value stays. The preview scripts own
# these names (a value made for each preview, the preview GitHub App, the
# preview Vercel project, the OTLP header):
PREVIEW_OWNED = {
    "AUTH_SECRET",
    "CONNECTION_SECRETS_ENCRYPTION_KEY",
    "GITHUB_PRIVATE_KEY",
    "GITHUB_CLIENT_SECRET",
    "GITHUB_WEBHOOK_SECRET",
    "VERCEL_TOKEN",
    "OTEL_EXPORTER_OTLP_HEADERS",
}
# A preview cannot start without these.
PREVIEW_REQUIRED = {"MODEL_PROVIDER_API_KEY", "FALKORDB_PASSWORD"}
# Checked before any write, so a bad value never reaches a service.
FORMATS = {
    "CONNECTION_SECRETS_ENCRYPTION_KEY": re.compile(r"[0-9a-fA-F]{64}"),
    "LANGFUSE_ENCRYPTION_KEY": re.compile(r"[0-9a-fA-F]{64}"),
}


def graphql(query, variables, token):
    request = urllib.request.Request(
        "https://backboard.railway.com/graphql/v2",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "ctxpipe-railway-sync/1.0",
        },
    )
    # A variableDelete starts a redeploy, and Railway can take more than 30
    # seconds to answer it. Wait 2 minutes, as railway-graphql.sh does.
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Railway API returned HTTP {error.code}") from None
    if not isinstance(payload, dict) or payload.get("errors") or not isinstance(payload.get("data"), dict):
        raise RuntimeError("Railway API returned an invalid or failed GraphQL response")
    return payload["data"]


def current_variables(project_id, environment_id, service_id, token):
    data = graphql(
        "query variables($projectId: String!, $environmentId: String!, $serviceId: String) "
        "{ variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }",
        {"projectId": project_id, "environmentId": environment_id, "serviceId": service_id},
        token,
    )
    variables = data.get("variables")
    if not isinstance(variables, dict):
        raise RuntimeError("Railway did not return service variables")
    return variables


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--redeploy-on-change", action="store_true")
    # Redeploys even when no value changed: a re-run, after an attempt that
    # wrote the values but whose redeploy failed.
    parser.add_argument("--redeploy", action="store_true")
    parser.add_argument("--service", choices=SERVICE_VARIABLES, required=True)
    # Appends the service name to this file when a value changed.
    parser.add_argument("--changed-file")
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    variables = SERVICE_VARIABLES[args.service]
    optional = OPTIONAL
    if args.preview:
        variables = {name: source for name, source in variables.items()
                     if name not in PREVIEW_OWNED}
        optional = set(variables.values()) - PREVIEW_REQUIRED

    required = ["PROJECT_ID", "ENVIRONMENT_ID", "SERVICE_ID",
                *(source for source in variables.values() if source not in optional)]
    missing = [name for name in required if not os.environ.get(name)]
    token = os.environ.get("RAILWAY_TOKEN") or os.environ.get("RAILWAY_API_TOKEN")
    if not token:
        missing.append("RAILWAY_TOKEN")
    if missing:
        raise RuntimeError("Missing required environment variables: " + ", ".join(missing))
    malformed = [source for source, pattern in FORMATS.items()
                 if source in variables.values() and not pattern.fullmatch(os.environ[source])]
    if malformed:
        raise RuntimeError("Malformed values: " + ", ".join(malformed))

    project_id = os.environ["PROJECT_ID"]
    environment_id = os.environ["ENVIRONMENT_ID"]
    service_id = os.environ["SERVICE_ID"]
    desired = {name: os.environ[source] for name, source in variables.items()
               if os.environ.get(source)}

    existing = current_variables(project_id, environment_id, service_id, token)
    changed = {name: value for name, value in desired.items() if existing.get(name) != value}
    removed = [name for name in [*variables, *sorted(RETIRED)]
               if name not in desired and name in existing]
    if not changed and not removed:
        print(f"{args.service} credentials already match GitHub Environment")
    if changed:
        graphql(
            "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) "
            "{ variableCollectionUpsert(input: $input) }",
            {"input": {"projectId": project_id, "environmentId": environment_id,
                       "serviceId": service_id, "variables": changed, "skipDeploys": True}},
            token,
        )
    # variableDelete has no skipDeploys, so a delete can redeploy the service
    # on its current image. It happens when an optional connector is turned
    # off, and on a new preview for each production value that Preview does
    # not set. The service then starts without it.
    for name in removed:
        graphql(
            "mutation variableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }",
            {"input": {"projectId": project_id, "environmentId": environment_id,
                       "serviceId": service_id, "name": name}},
            token,
        )
    if changed or removed:
        updated = current_variables(project_id, environment_id, service_id, token)
        if any(updated.get(name) != value for name, value in changed.items()) or \
                any(name in updated for name in removed):
            raise RuntimeError(f"Railway did not retain every {args.service} credential")
        print(f"Synced {len(changed)} and removed {len(removed)} {args.service} variables "
              "from GitHub Environment")
        if args.changed_file:
            with open(args.changed_file, "a", encoding="utf-8") as changed_file:
                changed_file.write(f"{args.service}\n")

    if not (args.redeploy or (args.redeploy_on_change and (changed or removed))):
        return
    data = graphql(
        "mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!) "
        "{ serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId) }",
        {"serviceId": service_id, "environmentId": environment_id},
        token,
    )
    deployment_id = data.get("serviceInstanceDeployV2")
    if not isinstance(deployment_id, str) or not deployment_id:
        raise RuntimeError("Railway did not return a deployment ID")
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        data = graphql(
            "query deployments($input: DeploymentListInput!) "
            "{ deployments(input: $input) { edges { node { id status } } } }",
            {"input": {"environmentId": environment_id, "serviceId": service_id}},
            token,
        )
        edges = data.get("deployments", {}).get("edges", [])
        statuses = [edge["node"]["status"] for edge in edges
                    if isinstance(edge, dict) and isinstance(edge.get("node"), dict)
                    and edge["node"].get("id") == deployment_id]
        if statuses:
            if statuses[0] in ("SUCCESS", "SLEEPING"):
                print(f"{args.service} redeployment succeeded")
                return
            if statuses[0] in ("FAILED", "CRASHED"):
                raise RuntimeError(f"{args.service} redeployment ended {statuses[0]}")
        time.sleep(10)
    raise RuntimeError(f"Timed out waiting for {args.service} redeployment")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
