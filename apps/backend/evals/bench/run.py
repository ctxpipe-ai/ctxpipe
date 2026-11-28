"""Run OrgBench (phases 1 and 2, CTX-1664, CTX-1665): each task x arm x model x trial, through Harbor.

Each run is one Harbor job with the stock `claude-code` agent. The model
requests of a run go through the model gateway of the run (model-gateway.yaml),
which holds the model key and stops the run at its budget. The MCP requests of
a CTX run go through the MCP proxy of the run (mcp-proxy.yaml), which holds the
bench key. The script admits a run only when the spend so far, the budget of
the run and the server reserve of the arm are not more than --cap-usd. It
records each run (record.py), and resumes from runs.jsonl in --out. A baseline
arm (no MCP) reuses a cached record of the same task, snapshot, harness,
model, trial and arm config. `--tier` takes the tasks of a split, with the
arms, models, trials and caps of tiers.json. `--candidate-mcp-url` runs a
candidate and the kept CTX interleaved, with a B1+ sentinel. Then `analyze.py`
writes report.{json,md}, with the keep rule for a candidate. See README.md.

Environment (run.py gives Harbor only PATH, HOME, DOCKER_HOST and the values
of the two sidecars):
  ANTHROPIC_AUTH_TOKEN  the model key of `factory eval`. Only the model gateway gets it.
  ANTHROPIC_BASE_URL    the Anthropic-compatible endpoint of that key
  CTXPIPE_API_KEY       the read-scope key of the bench org (CTX arm). Only the MCP proxy gets it.
  CTXPIPE_CANDIDATE_API_KEY  the org key of the candidate stack (mint-key.ts), with --candidate-mcp-url
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
from importlib.metadata import version
from pathlib import Path

import corpus
import tiers
from analyze import CANDIDATE, KEPT, analyze, write_report
from record import byok_usage, record_run, run_cost, run_key, task_config, tree_hash, workspace_snapshot

BENCH = Path(__file__).resolve().parent
CACHE = Path.home() / ".cache" / "ctxpipe-bench" / "cache"


def gold_context(task_dir, corpus_dir):
    """The gold context of a task for the ORACLE arm: each file of `gold_context`, or its lines (`#L10-80`, `#L42`)."""
    root = corpus_dir.resolve()
    parts = []
    for ref in task_config(task_dir)["metadata"]["gold_context"]:
        path, _, lines = ref.partition("#")
        # The text goes to the model host: refuse a path (or a link) out of the corpus.
        file = (root / path).resolve()
        if not file.is_relative_to(root):
            raise SystemExit(f"{task_dir.name}: the gold file {ref} is not in the corpus")
        text = file.read_text(errors="replace").splitlines()
        if lines:
            start, _, end = lines.replace("L", "").partition("-")
            text = text[int(start) - 1 : int(end or start)]
        parts.append(f'<file path="{ref}">\n' + "\n".join(text) + "\n</file>")
    return "\n\n".join(parts)


def check_task(task_dir):
    """A task must give the agent and the verifier no egress: run.py adds only the sidecars to the agent (README.md)."""
    config = task_config(task_dir)
    agent, verifier = config.get("agent", {}), config.get("verifier", {})
    if agent.get("network_mode") != "allowlist" or agent.get("allowed_hosts") or verifier.get("network_mode") != "no-network":
        raise SystemExit(f'{task_dir.name}: task.toml must set [agent] network_mode = "allowlist", allowed_hosts = [] and [verifier] network_mode = "no-network"')


def preamble(config, twin, arm):
    where = arm["where"].format(ctxOrg=twin["ctxOrg"], ctxWorkspace=twin["ctxWorkspace"])
    return config["preamble"].format(about=twin["about"], where=where)


def job_config(args, config, twin, arm, model, task_dir, run_id, corpus_dir):
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


def harbor_env(args, config, arm, model, run_id, endpoint):
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
        MODEL_GATEWAY_OUT=str(args.out / "gateway" / run_id),
    )
    if arm["mcp"]:
        env.update(
            MCP_PROXY_UPSTREAM=endpoint["url"],
            MCP_PROXY_KEY=os.environ[endpoint["keyVar"]],
            MCP_PROXY_CONVERSATION_ID=run_id,
            MCP_PROXY_TOOLS=",".join(arm["mcpTools"]),
            MCP_PROXY_MAX_TOOL_CALLS=str(config["maxToolCalls"]),
            MCP_PROXY_OUT=str(args.out / "mcp" / run_id),
        )
    return env


def cache_key(config, twin, arm_name, model, task_dir, trial, size):
    """The key of a baseline record: task, snapshot, harness version, model, arm config, trial."""
    arm = config["arms"][arm_name]
    key = {
        "task": tree_hash(task_dir),
        # Each repository as source@sha, and the context repo: a changed pin is a new key.
        "snapshot": corpus.snapshot(twin, size),
        "harness": {"harbor": version("harbor"), "claudeCode": config["claudeCodeVersion"], "maxTurns": config["maxTurns"]},
        "model": model,
        "arm": {"name": arm_name, **arm, "preamble": preamble(config, twin, arm)},
        "trial": trial,
    }
    return hashlib.sha256(json.dumps(key, sort_keys=True).encode()).hexdigest()


def interleaved(arms, index):
    """The arms of the task at `index`: the candidate and the kept CTX change places on each other task, so neither always runs first."""
    if index % 2 == 0:
        return arms
    swap = {KEPT: CANDIDATE, CANDIDATE: KEPT}
    return [swap.get(arm, arm) for arm in arms]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True, help="run folder, in a path Docker can mount")
    parser.add_argument("--twin", default="zulip-v1")
    parser.add_argument("--tasks-dir", type=Path, help="the task folders (default: tasks/<twin>)")
    parser.add_argument("--tier", choices=["smoke", "dev", "holdout", "release"], help="the tasks of a tier of tiers.json, with its arms, models, trials and caps")
    parser.add_argument("--tasks", help="comma-separated task ids (default: each task of the tier, else each task that is not sealed)")
    parser.add_argument("--repos", type=int, help="scale sweep, B1+ only: the count of repositories of the corpus (5, 50, 200)")
    parser.add_argument("--cap-usd", type=float, help="the spend cap of the invocation (default: the cap of the tier, else 2; never above the cap of the tier)")
    parser.add_argument("--models", help="comma-separated models of arms.json (default: the tier, else haiku)")
    parser.add_argument("--arms", help="comma-separated arms (default: the tier, else b1plus,ctx,oracle)")
    parser.add_argument("--trials", type=int, help="trials of each arm (default: the tier, else 1; ORACLE: 1)")
    parser.add_argument("--mcp-url", default="https://app.ctxpipe.ai/mcp", help="the MCP of the CTX arm, or of the kept CTX (D4: production)")
    parser.add_argument("--telemetry-env", default="production", help="the DeploymentEnvironment of the MCP server spans")
    parser.add_argument("--candidate-mcp-url", help="the MCP of a candidate (a local stack): the candidate and the kept CTX run interleaved, with a B1+ sentinel")
    parser.add_argument("--candidate-telemetry-env", help="the DeploymentEnvironment of the candidate stack (local-<name>)")
    parser.add_argument("--sentinel", type=int, help="the B1+ sentinel of a candidate run: B1+ runs again on the first N tasks (default: tiers.json)")
    parser.add_argument("--no-cache", action="store_true", help="run each baseline arm again and refresh its cache record; run the smoke tier again")
    args = parser.parse_args()
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=True)
    args.tasks_dir = args.tasks_dir or BENCH / "tasks" / args.twin
    config = json.loads((BENCH / "arms.json").read_text())
    tier_config = tiers.load()
    tier = tier_config["tiers"][args.tier] if args.tier else None
    twin = config["twins"][args.twin]
    models = (args.models or ",".join(tier["models"] if tier else ["haiku"])).split(",")
    arms = (args.arms or ",".join(tier["arms"] if tier else ["b1plus", "ctx", "oracle"])).split(",")
    trials = args.trials or (tier["trials"] if tier else 1)
    cap_usd = args.cap_usd if args.cap_usd is not None else (tier["capUsd"] if tier else 2.0)
    if tier and cap_usd > tier["capUsd"]:
        raise SystemExit(f"--cap-usd {cap_usd} is above the cap of the tier {args.tier} (${tier['capUsd']})")
    if args.tier == "smoke" and (models != ["haiku"] or arms != ["ctx"] or args.candidate_mcp_url):
        raise SystemExit("the smoke tier runs only the CTX arm with Haiku; --mcp-url names the stack under test")
    run_cap = (tier or {}).get("runCapUsd")
    server_reserve = (tier or {}).get("serverReserveUsd")
    endpoints = {"kept": {"url": args.mcp_url, "keyVar": "CTXPIPE_API_KEY", "telemetry": args.telemetry_env}}
    if args.candidate_mcp_url:
        # Production cannot serve unmerged code (D4): the candidate is a local
        # stack, and the kept CTX is --mcp-url (README.md, "Candidate and kept").
        if "ctx" not in arms or not args.candidate_telemetry_env:
            raise SystemExit("--candidate-mcp-url needs the arm ctx and --candidate-telemetry-env")
        endpoints["candidate"] = {"url": args.candidate_mcp_url, "keyVar": "CTXPIPE_CANDIDATE_API_KEY", "telemetry": args.candidate_telemetry_env}
        arms = [a for a in arms if a != "ctx"] + [KEPT, CANDIDATE]
    plan_size = len(corpus.plan_repositories(twin))
    # The CTX arm reads the production Workspace, which has the repositories
    # of the plan only: the sweep changes only the corpus of B1+.
    if args.repos not in (None, plan_size) and arms != ["b1plus"]:
        raise SystemExit(f"--repos {args.repos} runs only the arm b1plus (the bench Workspace has {plan_size} repositories)")
    repos = len(corpus.snapshot(twin, args.repos)["repositories"])
    task_ids = tiers.select_tasks(args.tasks_dir, args.tier, tier, args.tasks.split(",") if args.tasks else None)
    for task in task_ids:
        check_task(args.tasks_dir / task)
    sentinel = set()
    if args.candidate_mcp_url:
        sentinel = set(task_ids[: args.sentinel if args.sentinel is not None else tier_config["sentinel"]["size"]])
    smoke = None
    if args.tier == "smoke":
        # One verdict for each tool surface: the same surface never runs twice.
        smoke = tiers.Smoke(args, task_ids)
        if not args.no_cache and (verdict := smoke.cached()) is not None:
            return verdict
    aggregate_only = bool(tier and tier.get("aggregateOnly"))
    corpus_dir = None
    runs_path = args.out / "runs.jsonl"
    runs = [json.loads(line) for line in runs_path.read_text().splitlines()] if runs_path.exists() else []
    # An infrastructure error (a model API error, a harness crash) runs
    # again. Each other result counts, also an error of the own service.
    done = {run_key(r) for r in runs if r["errorClass"] != "infra"}
    # A run with no record (an invocation that stopped during the run) keeps its full reserve.
    recorded = {r["runId"] for r in runs}
    spent = sum(run_cost(r) for r in runs if not r.get("cached")) + sum(
        float(path.read_text()) for path in (args.out / "gateway").glob("*/reserve.txt") if path.parent.name not in recorded
    )
    candidate = endpoints.get("candidate")
    (args.out / "invocation.json").write_text(json.dumps({
        "twin": args.twin, "tasksDir": str(args.tasks_dir), "tier": args.tier, "aggregateOnly": aggregate_only,
        "repos": repos, "corpus": corpus.snapshot(twin, args.repos), "mcpUrl": args.mcp_url, "telemetryEnv": args.telemetry_env,
        "candidate": candidate and {"mcpUrl": candidate["url"], "telemetryEnv": candidate["telemetry"]},
        "surface": smoke and smoke.surface["hash"],
    }, indent=2))
    # The byok_usage counter of OpenRouter lags by up to a minute, so it
    # checks the spend of the whole invocation, not of each run.
    byok_before, new_runs, status = byok_usage(), [], 0

    def append(run):
        runs.append(run)
        with runs_path.open("a") as f:
            f.write(json.dumps(run) + "\n")

    try:
        for model_name in models:
            model = dict(config["models"][model_name])
            if run_cap is not None:
                model["runCapUsd"] = run_cap
            # Task first, so that the arms of a task run one after the other.
            for index, task in enumerate(task_ids):
                task_dir = args.tasks_dir / task
                for arm_name in interleaved(arms, index):
                    base = arm_name.split(":")[0]
                    arm = config["arms"][base]
                    endpoint = endpoints["candidate" if arm_name == CANDIDATE else "kept"]
                    for trial in range(1, arm.get("trials", trials) + 1):
                        if run_key({"model": model_name, "arm": arm_name, "task": task, "trial": trial, "repos": repos}) in done:
                            continue
                        cache_path, cached = None, None
                        if not arm["mcp"]:
                            cache_path = CACHE / f"{cache_key(config, twin, base, model, task_dir, trial, args.repos)}.json"
                            cached = json.loads(cache_path.read_text()) if cache_path.is_file() else None
                            # The B1+ sentinel runs again, so that a drift of the cache shows.
                            fresh = args.no_cache or (base == "b1plus" and task in sentinel)
                            if cached and not fresh:
                                append({**cached, "cached": True})
                                print(f"cached {model_name} {arm_name} {task} trial {trial}", flush=True)
                                continue
                            if candidate and not fresh:
                                print(f"skip {model_name} {arm_name} {task} trial {trial}: not in the cache, and a candidate run takes its baselines from the cache", flush=True)
                                continue
                        if (arm["mountCorpus"] or arm["goldContext"]) and corpus_dir is None:
                            # Only a baseline run that is not in the cache needs the files.
                            corpus_dir = corpus.build(twin, args.repos)
                        for attempt in range(1, 4):
                            # The model gateway stops the agent at the cap of the
                            # run. The server calls of a CTX run (a query embedding
                            # and Jev for each search) have no dollar cap: the MCP
                            # proxy limits only their count. Thus the arm also
                            # reserves an estimate of their cost (README.md).
                            reserve = model["runCapUsd"] + (server_reserve if arm["mcp"] and server_reserve is not None else arm["serverReserveUsd"])
                            if spent + reserve > cap_usd:
                                print(f"stop: ${spent:.3f} spent, the next run can cost ${reserve}, cap ${cap_usd}")
                                return status or 3
                            run_id = f"bench-{model_name}-{arm_name.replace(':', '-')}-{task}-t{trial}-{int(time.time())}"
                            config_path = args.out / "configs" / f"{run_id}.json"
                            config_path.parent.mkdir(exist_ok=True)
                            config_path.write_text(json.dumps(job_config(args, config, twin, arm, model, task_dir, run_id, corpus_dir), indent=2))
                            (args.out / "gateway" / run_id).mkdir(parents=True)
                            (args.out / "gateway" / run_id / "reserve.txt").write_text(str(reserve))
                            snapshot = {}
                            if arm["mcp"]:
                                (args.out / "mcp" / run_id).mkdir(parents=True)
                                snapshot["before"] = workspace_snapshot(endpoint["url"], os.environ[endpoint["keyVar"]], twin["ctxOrg"], twin["ctxWorkspace"])
                            started = time.time()
                            print(f"run {run_id}", flush=True)
                            subprocess.run(
                                [str(Path(sys.executable).parent / "harbor"), "run", "--config", str(config_path), "--yes"],
                                check=False, env=harbor_env(args, config, arm, model, run_id, endpoint),
                            )
                            ended = time.time()
                            if arm["mcp"]:
                                snapshot["after"] = workspace_snapshot(endpoint["url"], os.environ[endpoint["keyVar"]], twin["ctxOrg"], twin["ctxWorkspace"])
                            run = record_run(
                                out=args.out, run_id=run_id, model=model_name, arm=arm_name, task=task, trial=trial,
                                attempt=attempt, repos=repos, cap_usd=model["runCapUsd"], mcp=arm["mcp"],
                                started=started, ended=ended, telemetry_env=endpoint["telemetry"],
                                org_slug=twin["ctxOrg"], task_dir=task_dir, snapshot=snapshot,
                            )
                            if base == "b1plus" and task in sentinel:
                                run["sentinel"] = True
                                run["cachedScore"] = cached["score"] if cached else None
                            append(run)
                            new_runs.append(run)
                            spent += run_cost(run)
                            # A tier with aggregate results only prints no score of a task.
                            result = "" if aggregate_only else f": score {run['score']} error {run['error']} ({run['errorClass']}) valid {run['valid']}"
                            print(f"done {run_id}{result} cost ${run_cost(run):.4f} spent ${spent:.4f}", flush=True)
                            if run["errorClass"] != "infra":
                                break
                            status = 1
                        if cache_path and run["errorClass"] is None:
                            cache_path.parent.mkdir(parents=True, exist_ok=True)
                            cache_path.write_text(json.dumps(run))
        if smoke:
            report = analyze(args.out, 1.0)
            verdict = tiers.smoke_verdict(report, tier["verdict"])
            # Only a finished run keeps its verdict: a run that the cap stopped
            # returned above, and an infrastructure error is not a verdict of the surface.
            if not report["unresolvedInfraRunCount"]:
                smoke.write(verdict)
            print(f"smoke verdict for tool surface {smoke.surface['hash'][:12]}: {'pass' if verdict['pass'] else 'fail'} {verdict['reasons']} {verdict['numbers']}")
            status = 0 if verdict["pass"] else 1
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
