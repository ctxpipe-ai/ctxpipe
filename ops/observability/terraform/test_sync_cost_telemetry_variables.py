"""Exercise credential delivery through a fake Railway HTTP API."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("sync-cost-telemetry-variables.py")
SPEC = importlib.util.spec_from_file_location("sync_cost_telemetry_variables", SCRIPT)
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)


class CostTelemetryCredentialSyncTest(unittest.TestCase):
    def setUp(self):
        self.desired = {name: f"private-{name}" for name in SYNC.VARIABLES}
        self.environment = {
            "PROJECT_ID": "project",
            "ENVIRONMENT_ID": "environment",
            "SERVICE_ID": "service",
            "RAILWAY_TOKEN": "management-token",
            **{source: self.desired[name] for name, source in SYNC.VARIABLES.items()},
        }
        self.current = {"OTEL_EXPORTER_OTLP_ENDPOINT": "https://collector.example"}
        self.calls = []

    def railway_response(self, request, timeout):
        self.assertEqual(timeout, 30)
        self.assertEqual(request.get_header("Authorization"), "Bearer management-token")
        self.assertEqual(request.get_header("User-agent"), "ctxpipe-observability-ci/1.0")
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

    def run_sync(self, *args):
        output = io.StringIO()
        with patch.dict(os.environ, self.environment, clear=True), \
             patch.object(sys, "argv", [str(SCRIPT), *args]), \
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

    def test_missing_credential_fails_before_any_railway_request(self):
        del self.environment["COST_TELEMETRY_NEON_API_KEY"]
        with self.assertRaisesRegex(RuntimeError, "COST_TELEMETRY_NEON_API_KEY"):
            self.run_sync()
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
