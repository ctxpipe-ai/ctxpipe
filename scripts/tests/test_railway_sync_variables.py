"""Exercise credential delivery through a fake Railway HTTP API."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).parent.parent / "railway-sync-variables.py"
SPEC = importlib.util.spec_from_file_location("railway_sync_variables", SCRIPT)
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)


class RailwaySyncVariablesTest(unittest.TestCase):
    def setUp(self):
        self.variables = SYNC.SERVICE_VARIABLES["cost-telemetry"]
        self.desired = {name: f"private-{name}" for name in self.variables}
        self.environment = {
            "PROJECT_ID": "project",
            "ENVIRONMENT_ID": "environment",
            "SERVICE_ID": "service",
            "RAILWAY_TOKEN": "management-token",
            **{source: self.desired[name] for name, source in self.variables.items()},
        }
        self.current = {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example"}
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.calls = []

    def railway_response(self, request, timeout):
        self.assertEqual(timeout, 30)
        self.assertEqual(request.get_header("Authorization"), "Bearer management-token")
        self.assertEqual(request.get_header("User-agent"), "ctxpipe-railway-sync/1.0")
        body = json.loads(request.data)
        query = body["query"]
        variables = body["variables"]
        if query.startswith("query variables"):
            self.calls.append("read")
            data = {"variables": self.current.copy()}
        elif query.startswith("mutation variableCollectionUpsert"):
            self.calls.append("upsert")
            self.assertTrue(variables["input"]["skipDeploys"])
            self.assertEqual(variables["input"]["serviceId"], "service")
            self.current.update(variables["input"]["variables"])
            data = {"variableCollectionUpsert": True}
        elif query.startswith("mutation variableDelete"):
            self.calls.append("delete")
            self.current.pop(variables["input"]["name"])
            data = {"variableDelete": True}
        elif query.startswith("mutation serviceInstanceDeployV2"):
            self.calls.append("deploy")
            data = {"serviceInstanceDeployV2": "deployment"}
        elif query.startswith("query deployments"):
            self.calls.append("poll")
            data = {"deployments": {"edges": [
                {"node": {"id": "deployment", "status": "SUCCESS"}}
            ]}}
        else:
            self.fail(f"Unexpected Railway query: {query}")
        return io.BytesIO(json.dumps({"data": data}).encode())

    def run_sync(self, *args, service="cost-telemetry"):
        output = io.StringIO()
        with patch.dict(os.environ, self.environment, clear=True), \
             patch.object(sys, "argv", [str(SCRIPT), "--service", service, *args]), \
             patch("urllib.request.urlopen", side_effect=self.railway_response), \
             contextlib.redirect_stdout(output):
            SYNC.main()
        return output.getvalue()

    def test_initial_sync_precedes_image_deploy_and_preserves_other_variables(self):
        output = self.run_sync()
        self.assertEqual(self.calls, ["read", "upsert", "read"])
        self.assertEqual({name: self.current[name] for name in self.desired}, self.desired)
        self.assertEqual(self.current["OTEL_EXPORTER_OTLP_ENDPOINT"], "https://collector.example")
        self.assertNotIn("private-", output)

    def test_rotation_redeploys_once_and_matching_values_are_no_op(self):
        self.current.update(self.desired)
        self.current["NEON_API_KEY"] = "old-key"
        self.run_sync("--redeploy-on-change")
        self.assertEqual(self.calls, ["read", "upsert", "read", "deploy", "poll"])
        self.calls.clear()
        self.run_sync("--redeploy-on-change")
        self.assertEqual(self.calls, ["read"])

    def test_railway_telemetry_gets_only_the_shared_railway_token(self):
        self.run_sync(service="railway-telemetry")
        self.assertEqual(self.calls, ["read", "upsert", "read"])
        self.assertEqual(self.current["RAILWAY_API_TOKEN"], self.desired["RAILWAY_API_TOKEN"])
        self.assertNotIn("NEON_API_KEY", self.current)

    def test_backend_skips_an_empty_optional_integration(self):
        backend = SYNC.SERVICE_VARIABLES["backend"]
        self.environment = {
            "PROJECT_ID": "project",
            "ENVIRONMENT_ID": "environment",
            "SERVICE_ID": "service",
            "RAILWAY_TOKEN": "management-token",
            **{source: f"private-{name}" for name, source in backend.items()
               if not source.startswith("SLACK_")},
            "CONNECTION_SECRETS_ENCRYPTION_KEY": "ab" * 32,
        }
        self.run_sync(service="backend")
        self.assertEqual(self.current["AUTH_SECRET"], "private-AUTH_SECRET")
        self.assertEqual(self.current["GITHUB_PRIVATE_KEY"], "private-GITHUB_PRIVATE_KEY")
        self.assertNotIn("SLACK_CLIENT_ID", self.current)

    def test_backend_deletes_an_optional_secret_that_became_empty(self):
        backend = SYNC.SERVICE_VARIABLES["backend"]
        self.environment = {
            "PROJECT_ID": "project",
            "ENVIRONMENT_ID": "environment",
            "SERVICE_ID": "service",
            "RAILWAY_TOKEN": "management-token",
            **{source: f"private-{name}" for name, source in backend.items()
               if source != "PAGERDUTY_CLIENT_SECRET"},
            "CONNECTION_SECRETS_ENCRYPTION_KEY": "ab" * 32,
        }
        self.current.update({name: self.environment[source] for name, source in backend.items()
                             if source in self.environment})
        self.current["PAGERDUTY_CLIENT_SECRET"] = "leaked-old-value"
        changed = Path(self.tmp.name) / "changed"
        self.run_sync("--changed-file", str(changed), service="backend")
        self.assertEqual(self.calls, ["read", "delete", "read"])
        self.assertNotIn("PAGERDUTY_CLIENT_SECRET", self.current)
        self.assertEqual(changed.read_text(), "backend\n")

    def test_malformed_connection_key_fails_before_any_railway_request(self):
        backend = SYNC.SERVICE_VARIABLES["backend"]
        self.environment = {
            "PROJECT_ID": "project",
            "ENVIRONMENT_ID": "environment",
            "SERVICE_ID": "service",
            "RAILWAY_TOKEN": "management-token",
            **{source: f"private-{name}" for name, source in backend.items()},
        }
        with self.assertRaisesRegex(RuntimeError, "CONNECTION_SECRETS_ENCRYPTION_KEY"):
            self.run_sync(service="backend")
        self.assertEqual(self.calls, [])

    def test_redeploy_retries_a_deploy_when_the_values_already_match(self):
        self.current.update(self.desired)
        changed = Path(self.tmp.name) / "changed"
        self.run_sync("--redeploy", "--changed-file", str(changed))
        self.assertEqual(self.calls, ["read", "deploy", "poll"])
        self.assertFalse(changed.exists())

    def test_a_service_with_no_secret_only_redeploys(self):
        self.run_sync("--redeploy", service="langfuse-worker")
        self.assertEqual(self.calls, ["read", "deploy", "poll"])

    def test_preview_keeps_no_production_value(self):
        self.environment = {
            "PROJECT_ID": "project",
            "ENVIRONMENT_ID": "environment",
            "SERVICE_ID": "service",
            "RAILWAY_TOKEN": "management-token",
            "MODEL_PROVIDER_API_KEY": "preview-model-key",
        }
        self.current.update({
            "AUTH_SECRET": "preview-own-auth-secret",
            "MODEL_PROVIDER_API_KEY": "production-model-key",
            "SLACK_CLIENT_SECRET": "production-slack-secret",
            "BETTER_STACK_TOKEN": "retired-token",
        })
        self.run_sync("--preview", service="backend")
        self.assertEqual(self.current["MODEL_PROVIDER_API_KEY"], "preview-model-key")
        self.assertEqual(self.current["AUTH_SECRET"], "preview-own-auth-secret")
        self.assertNotIn("SLACK_CLIENT_SECRET", self.current)
        self.assertNotIn("BETTER_STACK_TOKEN", self.current)

    def test_preview_falkordb_needs_its_own_password(self):
        self.environment = {
            "PROJECT_ID": "project",
            "ENVIRONMENT_ID": "environment",
            "SERVICE_ID": "service",
            "RAILWAY_TOKEN": "management-token",
        }
        with self.assertRaisesRegex(RuntimeError, "FALKORDB_PASSWORD"):
            self.run_sync("--preview", service="falkordb")
        self.assertEqual(self.calls, [])

    def test_missing_credential_fails_before_any_railway_request(self):
        del self.environment["COST_TELEMETRY_NEON_API_KEY"]
        with self.assertRaisesRegex(RuntimeError, "COST_TELEMETRY_NEON_API_KEY"):
            self.run_sync()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
