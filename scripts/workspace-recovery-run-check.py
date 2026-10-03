"""Run one named baseline check; argv is executed verbatim from the repository root."""
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time

root = pathlib.Path(__file__).resolve().parents[1]
out = root / "logs"
if len(sys.argv) < 3:
    raise SystemExit(
        "Usage: workspace-recovery-run-check.py unique-check-name command [args...]"
    )
name, *command = sys.argv[1:]
if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", name) or not command:
    raise SystemExit(
        "Usage: workspace-recovery-run-check.py unique-check-name command [args...]"
    )
out.mkdir(parents=True, exist_ok=True)
log_path, metadata_path = out / (name + ".log"), out / (name + ".json")
if log_path.exists() or metadata_path.exists():
    raise SystemExit("Choose a new check name; existing evidence is never overwritten.")
env = {key: value for key, value in os.environ.items() if key in (
    "PATH", "HOME", "USER", "TMPDIR", "SHELL", "LANG", "VOLTA_HOME", "PNPM_HOME")}
fixture_env = {
    "AUTH_SECRET": "gate0-local-disposable-test-secret-20260907",
    "DATABASE_URL": "postgresql://ctxpipe:ctxpipe@127.0.0.1:51498/ctxpipe_gate0_fresh",
    "GRAPH_DB_URI": "redis://127.0.0.1:6399",
    "CI": "true", "NO_COLOR": "1", "TURBO_TELEMETRY_DISABLED": "1",
    "STORYBOOK_DISABLE_TELEMETRY": "1",
}
if name.startswith(("tests", "opencode-live")):
    fixture_env["DATABASE_URL"] = fixture_env["DATABASE_URL"].replace(
        "ctxpipe:ctxpipe@", "ctxpipe_app:ctxpipe@")
if name.startswith("opencode-live"):
    fixture_env["OPENCODE_LIVE"] = "1"
env.update(fixture_env)
start = time.time()
result = {"name": name, "cwd": str(root), "command": command,
          "environment": fixture_env, "timeout_seconds": 600,
          "started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(start)),
          "log": "logs/" + name + ".log"}
with log_path.open("x") as log:
    log.write(json.dumps(result) + "\n")
    log.flush()
    process = subprocess.Popen(command, cwd=root, env=env, stdout=log,
                               stderr=subprocess.STDOUT, start_new_session=True)
    try:
        code = process.wait(timeout=600)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
        code = 124
result.update(exit_code=code, duration_seconds=round(time.time() - start, 2))
metadata_path.write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result))
raise SystemExit(code if code >= 0 else 128 - code)
