#!/usr/bin/env python3
"""Copy GitHub Environment credentials to Railway without putting them in Terraform state."""

import argparse
import json
import os
import time
import urllib.error
import urllib.request


VARIABLES = {
    "OPENROUTER_MANAGEMENT_KEY": "COST_TELEMETRY_OPENROUTER_MANAGEMENT_KEY",
    "GITHUB_BILLING_TOKEN": "COST_TELEMETRY_GITHUB_BILLING_TOKEN",
    "BLACKSMITH_TOKEN": "COST_TELEMETRY_BLACKSMITH_TOKEN",
    "NEON_API_KEY": "COST_TELEMETRY_NEON_API_KEY",
    "NEON_ORG_ID": "COST_TELEMETRY_NEON_ORG_ID",
    "CLOUDFLARE_API_TOKEN": "COST_TELEMETRY_CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID": "COST_TELEMETRY_CLOUDFLARE_ACCOUNT_ID",
    "RAILWAY_API_TOKEN": "COST_TELEMETRY_RAILWAY_API_TOKEN",
    "AWS_ACCESS_KEY_ID": "COST_TELEMETRY_AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY": "COST_TELEMETRY_AWS_SECRET_ACCESS_KEY",
}


def graphql(query, variables, token):
    request = urllib.request.Request(
        "https://backboard.railway.com/graphql/v2",
        data=json.dumps({"query": query, "variables": variables}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "User-Agent": "ctxpipe-observability-ci/1.0",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
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
    args = parser.parse_args()

    required = ["PROJECT_ID", "ENVIRONMENT_ID", "SERVICE_ID", *VARIABLES.values()]
    missing = [name for name in required if not os.environ.get(name)]
    token = os.environ.get("RAILWAY_TOKEN") or os.environ.get("RAILWAY_API_TOKEN")
    if not token:
        missing.append("RAILWAY_TOKEN")
    if missing:
        raise RuntimeError("Missing required environment variables: " + ", ".join(missing))

    project_id = os.environ["PROJECT_ID"]
    environment_id = os.environ["ENVIRONMENT_ID"]
    service_id = os.environ["SERVICE_ID"]
    desired = {name: os.environ[source] for name, source in VARIABLES.items()}
    if os.environ.get("COST_TELEMETRY_AWS_SESSION_TOKEN"):
        desired["AWS_SESSION_TOKEN"] = os.environ["COST_TELEMETRY_AWS_SESSION_TOKEN"]

    existing = current_variables(project_id, environment_id, service_id, token)
    changed = {name: value for name, value in desired.items() if existing.get(name) != value}
    if not changed:
        print("Cost telemetry credentials already match GitHub Environment")
        return

    graphql(
        "mutation variableCollectionUpsert($input: VariableCollectionUpsertInput!) "
        "{ variableCollectionUpsert(input: $input) }",
        {"input": {"projectId": project_id, "environmentId": environment_id,
                   "serviceId": service_id, "variables": changed, "skipDeploys": True}},
        token,
    )
    updated = current_variables(project_id, environment_id, service_id, token)
    if any(updated.get(name) != value for name, value in changed.items()):
        raise RuntimeError("Railway did not retain every cost telemetry credential")
    print(f"Synced {len(changed)} cost telemetry variables from GitHub Environment")

    if not args.redeploy_on_change:
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
                print("Cost telemetry redeployment succeeded")
                return
            if statuses[0] in ("FAILED", "CRASHED"):
                raise RuntimeError(f"Cost telemetry redeployment ended {statuses[0]}")
        time.sleep(10)
    raise RuntimeError("Timed out waiting for cost telemetry redeployment")


if __name__ == "__main__":
    try:
        main()
    except RuntimeError as error:
        raise SystemExit(str(error)) from None
