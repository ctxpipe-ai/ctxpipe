"""Run OrgBench (phase 1, CTX-1664): each task x arm x model x trial, through Harbor.

Each run is one Harbor job with the stock `claude-code` agent. The model
requests of a run go through the model gateway of the run (model-gateway.yaml),
which holds the model key and stops the run at its budget. The MCP requests of
a CTX run go through the MCP proxy of the run (mcp-proxy.yaml), which holds the
bench key. The script admits a run only when the spend so far, the budget of
the run and the server reserve of the arm are not more than --cap-usd. It
records each run (record.py), and resumes from runs.jsonl in --out. A baseline
arm (no MCP) reuses a cached record of the same task, snapshot, harness,
model, trial and arm config. Then `analyze.py` writes report.{json,md}. See
README.md.

Environment (run.py gives Harbor only PATH, HOME, DOCKER_HOST and the values
of the two sidecars):
  ANTHROPIC_AUTH_TOKEN  the model key of `factory eval`. Only the model gateway gets it.
  ANTHROPIC_BASE_URL    the Anthropic-compatible endpoint of that key
  CTXPIPE_API_KEY       the read-scope key of the bench org (CTX arm). Only the MCP proxy gets it.
  DOCKER_HOST           the Docker of Harbor
  HYPERDX_ACCESS_KEY, HYPERDX_CF_ACCESS_CLIENT_ID, HYPERDX_CF_ACCESS_CLIENT_SECRET
                        the recorder reads the server spans of the CTX arm from HyperDX
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import tomllib
from importlib.metadata import version
from pathlib import Path

import corpus
from analyze import write_report
from record import byok_usage, record_run, run_cost

BENCH = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache" / "ctxpipe-bench" / "cache"
MAX_ATTEMPTS = 3


def task_metadata(task_dir):
    return tomllib.loads((task_dir / "task.toml").read_text()).get("metadata", {})


def gold_context(task_dir, corpus_dir):
    """The gold context of a task for the ORACLE arm: each file of `gold_context`, or its line range."""
    parts = []
    for ref in task_metadata(task_dir)["gold_context"]:
        path, _, lines = ref.partition("#")
        text = (corpus_dir / path).read_text(errors="replace").splitlines()
        if lines:
            start, end = (int(n) for n in lines.lstrip("L").split("-L" if "-L" in lines else "-"))
            text = text[start - 1 : end]
        parts.append(f'<file path="{ref}">\n' + "\n".join(text) + "\n</file>")
    return "\n\n".join(parts)


def preamble(config, twin, arm):
    where = arm["where"].format(ctxOrg=twin["ctxOrg"], ctxWorkspace=twin["ctxWorkspace"])
    return config["preamble"].format(about=twin["about"], where=where)


def job_config(args, config, twin, arm_name, model_name, task_dir, run_id, corpus_dir):
    arm = config["arms"][arm_name]
    model = config["models"][model_name]
    # The tasks allow no egress in the agent phase (task.toml); the agent
    # reaches only the model gateway and, in the CTX arm, the MCP proxy.
    hosts = ["ctxpipe-model-gateway"]
    agent = {
        "name": "claude-code",
        "model_name": model["id"],
        "kwargs": {
            "version": config["claudeCodeVersion"],
            "max_turns": config["maxTurns"],
            "max_budget_usd": f"{model['runCapUsd']:.2f}",
            "disallowed_tools": ",".join(arm["disallowedTools"]),
        },
        "extra_allowed_hosts": hosts,
        "base_url": "http://ctxpipe-model-gateway",
    }
    environment = {"type": "docker", "extra_docker_compose": [str(BENCH / "model-gateway.yaml")]}
    if arm["mcp"]:
        # The proxy adds the bench key and the conversation id of the run
        # (mcp-proxy.yaml): the agent container has no key.
        environment["extra_docker_compose"].append(str(BENCH / "mcp-proxy.yaml"))
        hosts.append("ctxpipe-mcp-proxy")
        agent["mcp_servers"] = [{"name": "ctxpipe", "transport": "streamable-http", "url": "http://ctxpipe-mcp-proxy/mcp"}]
    if arm["mountCorpus"]:
        environment["mounts"] = [{"type": "bind", "source": str(corpus_dir), "target": "/app/org", "read_only": True}]
    instructions = [preamble(config, twin, arm)]
    if arm["goldContext"]:
        instructions.append(gold_context(task_dir, corpus_dir))
    return {
        "job_name": run_id,
        "jobs_dir": str(args.out / "jobs"),
        "n_attempts": 1,
        "n_concurrent_trials": 1,
        "environment": environment,
        "agents": [agent],
        "tasks": [{"path": str(task_dir)}],
        "extra_instructions": instructions,
    }


def harbor_env(args, config, arm, model, run_id, out):
    """The environment of Harbor: a small allowlist, not a copy of the host environment.

    The model key goes only to the model gateway, and the bench key only to
    the MCP proxy (Compose gives each value to its own service). Claude Code
    gets a dummy token.
    """
    env = {k: os.environ[k] for k in ("PATH", "HOME", "DOCKER_HOST") if k in os.environ}
    env.update(
        HARBOR_TELEMETRY="0",
        # litellm (a dependency of Harbor) loads the first .env above the
        # working folder at import; this keeps that file out of Harbor too.
        PYTHON_DOTENV_DISABLED="1",
        ANTHROPIC_AUTH_TOKEN="model-gateway",
        MODEL_GATEWAY_UPSTREAM=os.environ["ANTHROPIC_BASE_URL"],
        MODEL_GATEWAY_KEY=os.environ["ANTHROPIC_AUTH_TOKEN"],
        MODEL_GATEWAY_MODEL=model["id"],
        MODEL_GATEWAY_PRICES=json.dumps(model["pricesUsdPerMTok"]),
        MODEL_GATEWAY_BUDGET_USD=str(model["runCapUsd"]),
        MODEL_GATEWAY_OUT=str(out / "gateway" / run_id),
    )
    if arm["mcp"]:
        (out / "mcp" / run_id).mkdir(parents=True)
        env.update(
            MCP_PROXY_UPSTREAM=args.mcp_url,
            MCP_PROXY_KEY=os.environ["CTXPIPE_API_KEY"],
            MCP_PROXY_CONVERSATION_ID=run_id,
            MCP_PROXY_TOOLS=",".join(arm["mcpTools"]),
            MCP_PROXY_MAX_TOOL_CALLS=str(config["maxToolCalls"]),
            MCP_PROXY_OUT=str(out / "mcp" / run_id),
        )
    return env


def tree_hash(folder):
    digest = hashlib.sha256()
    for path in sorted(p for p in folder.rglob("*") if p.is_file()):
        digest.update(str(path.relative_to(folder)).encode() + b"\0" + path.read_bytes() + b"\0")
    return digest.hexdigest()


def cache_key(config, twin, arm_name, model_name, task_dir, trial, repos):
    """The key of a baseline record: task, snapshot, harness version, model, arm config, trial."""
    arm = config["arms"][arm_name]
    key = {
        "task": tree_hash(task_dir),
        "snapshot": {"plan": twin["plan"], "context": twin["context"], "repos": repos},
        "harness": {"harbor": version("harbor"), "claudeCode": config["claudeCodeVersion"], "maxTurns": config["maxTurns"]},
        "model": config["models"][model_name],
        "arm": {"name": arm_name, **arm, "preamble": preamble(config, twin, arm)},
        "trial": trial,
    }
    return hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True, help="run folder, in a path Docker can mount")
    parser.add_argument("--tasks-dir", type=Path, default=BENCH / "tasks" / "zulip-v1")
    parser.add_argument("--tasks", help="comma-separated task ids (default: each task of --tasks-dir)")
    parser.add_argument("--twin", default="zulip-v1")
    parser.add_argument("--repos", type=int, help="scale sweep: the count of repositories of the B1+ corpus (5, 50, 200)")
    parser.add_argument("--cap-usd", type=float, default=2.0)
    parser.add_argument("--models", default="haiku")
    parser.add_argument("--arms", default="b1plus,ctx,oracle")
    parser.add_argument("--trials", type=int, default=1, help="trials of each arm (ORACLE: 1)")
    parser.add_argument("--mcp-url", default="https://app.ctxpipe.ai/mcp", help="the MCP of the CTX arm (D4: production)")
    parser.add_argument("--telemetry-env", default="production", help="the DeploymentEnvironment of the MCP server spans")
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    config = json.loads((BENCH / "arms.json").read_text())
    twin = config["twins"][args.twin]
    task_ids = args.tasks.split(",") if args.tasks else sorted(p.name for p in args.tasks_dir.iterdir() if (p / "task.toml").is_file())
    corpus_dir = corpus.build(args.twin, args.repos)
    repos = len(list((corpus_dir / "repos").iterdir()))
    runs_path = args.out / "runs.jsonl"
    runs = [json.loads(line) for line in runs_path.read_text().splitlines()] if runs_path.exists() else []
    # An infrastructure error (a model API error, a harness crash) runs
    # again. Each other result counts, also an error of the own service.
    done = {(r["model"], r["arm"], r["task"], r["trial"], r["repos"]) for r in runs if r["errorClass"] != "infra"}
    # A run with no record (an invocation that stopped during the run) keeps its full reserve.
    recorded = {r["runId"] for r in runs}
    spent = sum(run_cost(r) for r in runs if not r.get("cached")) + sum(
        float(path.read_text()) for path in (args.out / "gateway").glob("*/reserve.txt") if path.parent.name not in recorded
    )
    (args.out / "invocation.json").write_text(json.dumps({"twin": args.twin, "tasksDir": str(args.tasks_dir), "repos": repos, "corpus": str(corpus_dir), "mcpUrl": args.mcp_url, "telemetryEnv": args.telemetry_env}, indent=2))
    # The byok_usage counter of OpenRouter lags by up to a minute, so it
    # checks the spend of the whole invocation, not of each run.
    byok_before, new_runs, status = byok_usage(), [], 0

    def append(run):
        runs.append(run)
        with runs_path.open("a") as f:
            f.write(json.dumps(run) + "\n")

    try:
        for model_name in args.models.split(","):
            model = config["models"][model_name]
            # Task first, so that the arms of a task run one after the other.
            for task in task_ids:
                task_dir = args.tasks_dir / task
                for arm_name in args.arms.split(","):
                    arm = config["arms"][arm_name]
                    for trial in range(1, arm.get("trials", args.trials) + 1):
                        if (model_name, arm_name, task, trial, repos) in done:
                            continue
                        cache_path = None
                        if not arm["mcp"]:
                            cache_path = CACHE / f"{cache_key(config, twin, arm_name, model_name, task_dir, trial, repos)}.json"
                            if cache_path.is_file():
                                append({**json.loads(cache_path.read_text()), "cached": True})
                                print(f"cached {model_name} {arm_name} {task} trial {trial}", flush=True)
                                continue
                        for attempt in range(1, MAX_ATTEMPTS + 1):
                            # The model gateway stops the agent at the cap of the
                            # run. The server calls of a CTX run (a query embedding
                            # and Jev for each search) have no dollar cap: the MCP
                            # proxy limits only their count. Thus the arm also
                            # reserves an estimate of their cost (README.md).
                            reserve = model["runCapUsd"] + arm["serverReserveUsd"]
                            if spent + reserve > args.cap_usd:
                                print(f"stop: ${spent:.3f} spent, the next run can cost ${reserve}, cap ${args.cap_usd}")
                                return status or 3
                            run_id = f"bench-{model_name}-{arm_name}-{task}-t{trial}-{int(time.time())}"
                            config_path = args.out / "configs" / f"{run_id}.json"
                            config_path.parent.mkdir(exist_ok=True)
                            config_path.write_text(json.dumps(job_config(args, config, twin, arm_name, model_name, task_dir, run_id, corpus_dir), indent=2))
                            (args.out / "gateway" / run_id).mkdir(parents=True)
                            (args.out / "gateway" / run_id / "reserve.txt").write_text(str(reserve))
                            env = harbor_env(args, config, arm, model, run_id, args.out)
                            started = time.time()
                            print(f"run {run_id}", flush=True)
                            subprocess.run(
                                [str(Path(sys.executable).parent / "harbor"), "run", "--config", str(config_path), "--yes"],
                                check=False, env=env,
                            )
                            run = record_run(
                                out=args.out, run_id=run_id, model=model_name, arm=arm_name, task=task, trial=trial,
                                attempt=attempt, repos=repos, cap_usd=model["runCapUsd"], mcp=arm["mcp"],
                                started=started, ended=time.time(), telemetry_env=args.telemetry_env,
                                org_slug=twin["ctxOrg"], task_dir=task_dir,
                            )
                            append(run)
                            new_runs.append(run)
                            spent += run_cost(run)
                            print(f"done {run_id}: score {run['score']} error {run['error']} ({run['errorClass']}) valid {run['valid']} cost ${run_cost(run):.4f} spent ${spent:.4f}", flush=True)
                            if run["errorClass"] != "infra":
                                break
                            status = 1
                        if cache_path and run["errorClass"] is None:
                            cache_path.parent.mkdir(parents=True, exist_ok=True)
                            cache_path.write_text(json.dumps(run))
        return status
    finally:
        if runs:
            print(write_report(args.out))
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
