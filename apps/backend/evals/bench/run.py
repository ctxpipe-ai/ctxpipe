"""Run the OrgBench spike (CTX-1660): each task x arm x model once, through Harbor.

Each run is one Harbor job with the stock `claude-code` agent. The model
requests of a run go through the model gateway of the run (model-gateway.yaml),
which holds the model key and stops the run at its budget. The script admits
a run only when the spend so far, the budget of the run and the server reserve
of the arm are not more than --cap-usd. It records each run (record.py), and
resumes from runs.jsonl in --out: a run with an error runs again. See
README.md.

Environment:
  ANTHROPIC_AUTH_TOKEN  the model key of `factory eval`. Only the model gateway gets it,
                        never the agent container.
  ANTHROPIC_BASE_URL    the Anthropic-compatible endpoint of that key
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

from record import falkor_graph_calls, byok_usage, record_run, run_cost, write_report

BENCH = Path(__file__).resolve().parent


def job_config(args, config, arm_name, model_name, task, run_id):
    arm = config["arms"][arm_name]
    model = config["models"][model_name]
    # The tasks allow no egress in the agent phase (task.toml); the agent
    # reaches only the model gateway and, in the CTX arm, the MCP proxy.
    # The allowlist never holds the model host.
    hosts = ["ctxpipe-model-gateway"]
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
        "base_url": "http://ctxpipe-model-gateway",
    }
    if arm["disallowedTools"]:
        agent["kwargs"]["disallowed_tools"] = ",".join(arm["disallowedTools"])
    environment = {"type": "docker", "extra_docker_compose": [str(BENCH / "model-gateway.yaml")]}
    if arm["mcp"]:
        # The proxy forwards only /mcp to the backend (mcp-proxy.yaml). The
        # allowlist never holds host.docker.internal: that host also gives
        # the ports of the stores.
        environment["extra_docker_compose"].append(str(BENCH / "mcp-proxy.yaml"))
        hosts.append("ctxpipe-mcp-proxy")
        agent["mcp_servers"] = [
            {
                "name": "ctxpipe",
                "transport": "streamable-http",
                "url": "http://ctxpipe-mcp-proxy/mcp",
                "headers": {
                    "x-api-key": "${CTXPIPE_API_KEY}",
                    "x-ctxpipe-conversation-id": "${CTXPIPE_CONVERSATION_ID}",
                },
            }
        ]
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


def harbor_env(model, out):
    """The environment of Harbor: the model key goes only to the model gateway.

    Claude Code gets a dummy token. Compose gives the key and the budget of
    the run to the gateway (model-gateway.yaml).
    """
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)
    env.pop("ANTHROPIC_BASE_URL")
    env.update(
        ANTHROPIC_AUTH_TOKEN="model-gateway",
        MODEL_GATEWAY_UPSTREAM=os.environ["ANTHROPIC_BASE_URL"],
        MODEL_GATEWAY_KEY=os.environ["ANTHROPIC_AUTH_TOKEN"],
        MODEL_GATEWAY_MODEL=model["id"],
        MODEL_GATEWAY_PRICES=json.dumps(model["pricesUsdPerMTok"]),
        MODEL_GATEWAY_BUDGET_USD=str(model["runCapUsd"]),
        MODEL_GATEWAY_OUT=str(out),
    )
    return env


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True, help="run folder, in a path Docker can mount")
    parser.add_argument("--corpus", type=Path, required=True, help="B1+ corpus: repos/ and issues/")
    parser.add_argument("--otlp", type=Path, required=True, help="OTLP JSON lines of the backend spans")
    parser.add_argument("--falkor-container", required=True, help="the FalkorDB of the backend")
    parser.add_argument("--cap-usd", type=float, default=2.0)
    parser.add_argument("--models", default="haiku,sonnet")
    parser.add_argument("--arms", default="b1plus,ctx")
    parser.add_argument("--tasks", default=",".join(sorted(p.name for p in (BENCH / "tasks").iterdir())))
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    config = json.loads((BENCH / "arms.json").read_text())
    runs_path = args.out / "runs.jsonl"
    runs = [json.loads(line) for line in runs_path.read_text().splitlines()] if runs_path.exists() else []
    # A failed run keeps its spend, but it is not done: it runs again.
    done = {(r["model"], r["arm"], r["task"]) for r in runs if not r["error"]}
    # A run with no record (an invocation that stopped during the run) keeps
    # its full reserve.
    recorded = {r["runId"] for r in runs}
    spent = sum(run_cost(r) for r in runs) + sum(
        float(path.read_text()) for path in (args.out / "gateway").glob("*/reserve.txt") if path.parent.name not in recorded
    )
    # The byok_usage counter of OpenRouter lags by up to a minute, so it
    # checks the spend of the whole invocation, not of each run.
    byok_before, new_runs, status = byok_usage(), [], 0
    try:
        for model_name in args.models.split(","):
            model = config["models"][model_name]
            # Task first, so that the arms of a task run one after the other.
            for task in args.tasks.split(","):
                for arm_name in args.arms.split(","):
                    if (model_name, arm_name, task) in done:
                        continue
                    # The model gateway stops the agent at the cap of the run.
                    # The server calls of a CTX run (a query embedding and Jev
                    # for each search) have no dollar cap: the MCP proxy limits
                    # only their count. Thus the arm also reserves an estimate
                    # of their cost (README.md).
                    reserve = model["runCapUsd"] + config["arms"][arm_name]["serverReserveUsd"]
                    if spent + reserve > args.cap_usd:
                        print(f"stop: ${spent:.3f} spent, the next run can cost ${reserve}, cap ${args.cap_usd}")
                        return status or 3
                    run_id = f"bench-{model_name}-{arm_name}-{task}-{int(time.time())}"
                    config_path = args.out / "configs" / f"{run_id}.json"
                    config_path.parent.mkdir(exist_ok=True)
                    config_path.write_text(json.dumps(job_config(args, config, arm_name, model_name, task, run_id), indent=2))
                    gateway_out = args.out / "gateway" / run_id
                    gateway_out.mkdir(parents=True)
                    (gateway_out / "reserve.txt").write_text(str(reserve))
                    falkor_before = falkor_graph_calls(args.falkor_container)
                    started = time.time()
                    print(f"run {run_id}", flush=True)
                    subprocess.run(
                        [str(Path(sys.executable).parent / "harbor"), "run", "--config", str(config_path), "--yes"],
                        check=False,
                        env=harbor_env(model, gateway_out),
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
        if byok_before is not None:
            check = {
                "byokUsageDelta": round(byok_usage() - byok_before, 6),
                "claudeCodeCostUsd": round(sum(r["claudeCodeCostUsd"] or 0 for r in new_runs), 6),
                "runs": [r["runId"] for r in new_runs],
            }
            with (args.out / "byok.jsonl").open("a") as f:
                f.write(json.dumps(check) + "\n")
            print(f"byok check: {check['byokUsageDelta']} USD on the provider key, Claude Code says {check['claudeCodeCostUsd']}")


if __name__ == "__main__":
    sys.exit(main())
