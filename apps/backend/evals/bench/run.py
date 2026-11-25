"""Run the OrgBench spike (CTX-1660): each task x arm x model once, through Harbor.

Each run is one Harbor job with the stock `claude-code` agent. The script
stops before a run that could take the spend over --cap-usd, records each run
(record.py), and resumes from runs.jsonl in --out: a run with an error runs
again. See README.md.

Environment:
  ANTHROPIC_AUTH_TOKEN  the spend-capped model key of the bench (or ANTHROPIC_API_KEY); the
                        script refuses an OpenRouter key whose limit does not count the
                        Claude calls
  ANTHROPIC_BASE_URL    optional, an Anthropic-compatible endpoint
  CTXPIPE_API_KEY       the org key of the bench org (CTX arm)
  DOCKER_HOST           the Docker of Harbor
"""

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

from record import falkor_graph_calls, gateway_usage, key_limit_problem, record_run, run_cost, write_report

BENCH = Path(__file__).resolve().parent


def job_config(args, config, arm_name, model_name, task, run_id):
    arm = config["arms"][arm_name]
    model = config["models"][model_name]
    base_url = os.environ.get("ANTHROPIC_BASE_URL")
    # The tasks allow no egress in the agent phase (task.toml); the agent
    # reaches only the model endpoint and, in the CTX arm, the MCP host.
    hosts = [urlparse(base_url).hostname if base_url else "api.anthropic.com"]
    agent = {
        "name": "claude-code",
        "model_name": model["id"],
        "kwargs": {
            "version": config["claudeCodeVersion"],
            "max_turns": config["maxTurns"],
            "max_budget_usd": f"{model['runCapUsd']:.2f}",
        },
        "env": {"CTXPIPE_CONVERSATION_ID": run_id},
        "extra_allowed_hosts": hosts,
    }
    if arm["disallowedTools"]:
        agent["kwargs"]["disallowed_tools"] = ",".join(arm["disallowedTools"])
    if base_url:
        agent["base_url"] = base_url
    if arm["mcp"]:
        hosts.append(urlparse(args.mcp_url).hostname)
        agent["mcp_servers"] = [
            {
                "name": "ctxpipe",
                "transport": "streamable-http",
                "url": args.mcp_url,
                "headers": {
                    "x-api-key": "${CTXPIPE_API_KEY}",
                    "x-ctxpipe-conversation-id": "${CTXPIPE_CONVERSATION_ID}",
                },
            }
        ]
    environment = {"type": "docker"}
    if arm["mountCorpus"]:
        environment["mounts"] = [
            {"type": "bind", "source": str(args.corpus), "target": "/app/org", "read_only": True}
        ]
    return {
        "job_name": run_id,
        "jobs_dir": str(args.out / "jobs"),
        "n_attempts": 1,
        "n_concurrent_trials": 1,
        "environment": environment,
        "agents": [agent],
        "tasks": [{"path": str(BENCH / "tasks" / task)}],
        "extra_instructions": [config["preamble"].format(where=arm["where"])],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True, help="run folder, in a path Docker can mount")
    parser.add_argument("--corpus", type=Path, required=True, help="B1+ corpus: repos/ and issues/")
    parser.add_argument("--mcp-url", default="http://host.docker.internal:3660/mcp")
    parser.add_argument("--otlp", type=Path, required=True, help="OTLP JSON lines of the backend spans")
    parser.add_argument("--falkor-container", required=True, help="the FalkorDB of the backend")
    parser.add_argument("--cap-usd", type=float, default=2.0)
    parser.add_argument("--models", default="haiku,sonnet")
    parser.add_argument("--arms", default="b1plus,ctx")
    parser.add_argument("--tasks", default=",".join(sorted(p.name for p in (BENCH / "tasks").iterdir())))
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    if problem := key_limit_problem(args.cap_usd):
        print(f"refused: {problem}. Give a bench model key whose limit covers the Claude calls (README.md).")
        return 2
    config = json.loads((BENCH / "arms.json").read_text())
    runs_path = args.out / "runs.jsonl"
    runs = [json.loads(line) for line in runs_path.read_text().splitlines()] if runs_path.exists() else []
    # A failed run keeps its spend, but it is not done: it runs again.
    done = {(r["model"], r["arm"], r["task"]) for r in runs if not r["error"]}
    spent = sum(run_cost(r) for r in runs)
    # The gateway counter lags by up to a minute, so it checks the spend of
    # the whole invocation, not of each run.
    gateway_before, new_runs, status = gateway_usage(), [], 0
    try:
        for model_name in args.models.split(","):
            model = config["models"][model_name]
            # Task first, so that a stop at the cap leaves whole pairs of arms.
            for task in args.tasks.split(","):
                for arm_name in args.arms.split(","):
                    if (model_name, arm_name, task) in done:
                        continue
                    # The server calls of a CTX run (a query embedding and Jev
                    # for each search) have no cap of their own, so the arm
                    # reserves an estimate of them (README.md); the key limit is the hard cap.
                    reserve = model["runCapUsd"] + config["arms"][arm_name]["serverReserveUsd"]
                    if spent + reserve > args.cap_usd:
                        print(f"stop: ${spent:.3f} spent, the next run can cost ${reserve}, cap ${args.cap_usd}")
                        return 3
                    run_id = f"bench-{model_name}-{arm_name}-{task}-{int(time.time())}"
                    config_path = args.out / "configs" / f"{run_id}.json"
                    config_path.parent.mkdir(exist_ok=True)
                    config_path.write_text(json.dumps(job_config(args, config, arm_name, model_name, task, run_id), indent=2))
                    falkor_before = falkor_graph_calls(args.falkor_container)
                    started = time.time()
                    print(f"run {run_id}", flush=True)
                    subprocess.run(
                        [str(Path(sys.executable).parent / "harbor"), "run", "--config", str(config_path), "--yes"],
                        check=False,
                    )
                    ended = time.time()
                    # The backend exports its spans every 5 s, and the collector writes each second.
                    time.sleep(10)
                    run = record_run(
                        out=args.out, run_id=run_id, model=model_name, arm=arm_name, task=task,
                        cap_usd=model["runCapUsd"], otlp=args.otlp, started=started, ended=ended,
                        falkor_commands=falkor_graph_calls(args.falkor_container) - falkor_before,
                    )
                    runs.append(run)
                    new_runs.append(run)
                    with runs_path.open("a") as f:
                        f.write(json.dumps(run) + "\n")
                    spent += run_cost(run)
                    if run["error"]:
                        status = 1
                    print(f"done {run_id}: reward {run['reward']} error {run['error']} cost ${run_cost(run):.4f} spent ${spent:.4f}", flush=True)
        return status
    finally:
        write_report(args.out, runs)
        if gateway_before is not None:
            check = {
                "byokUsageDelta": round(gateway_usage() - gateway_before, 6),
                "claudeCodeCostUsd": round(sum(r["claudeCodeCostUsd"] or 0 for r in new_runs), 6),
                "runs": [r["runId"] for r in new_runs],
            }
            with (args.out / "gateway.jsonl").open("a") as f:
                f.write(json.dumps(check) + "\n")
            print(f"gateway check: {check['byokUsageDelta']} USD on the provider key, Claude Code says {check['claudeCodeCostUsd']}")


if __name__ == "__main__":
    sys.exit(main())
