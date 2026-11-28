"""The tiers of OrgBench (phase 2, CTX-1665): which tasks a run takes, and the smoke tier.

A task has a split in `[metadata]` of its task.toml: `dev`, `holdout` or
`sealed`. A tier of tiers.json takes the tasks of its splits. A run with no
tier takes only dev tasks, and only the tier `release` takes sealed tasks. The smoke tier is a fixed subset of dev: the
list `tasks` of tiers.json, or, while that list is null, the first `size` dev
tasks by id (the placeholder until the first baseline exists).

The smoke tier has one verdict for each tool surface (README.md, "The smoke
check"). The record of the verdict is in ~/.cache/ctxpipe-bench/smoke/, under the
hash of the tool surface, so that the same surface never runs twice.

  python tiers.py pick-smoke RUN_FOLDER   the smoke list from a baseline run
"""

import argparse
import hashlib
import json
import statistics
import subprocess
from pathlib import Path

from record import task_config, tree_hash

BENCH = Path(__file__).resolve().parent
REPO = BENCH.parents[3]
SMOKE_CACHE = Path.home() / ".cache" / "ctxpipe-bench" / "smoke"
SPLITS = ("dev", "holdout", "sealed")
PRODUCTION_MCP = "https://app.ctxpipe.ai/mcp"


def load():
    return json.loads((BENCH / "tiers.json").read_text())


def split_of(task_dir):
    split = task_config(task_dir).get("metadata", {}).get("split")
    if split not in SPLITS:
        raise SystemExit(f"{task_dir.name}: task.toml must set [metadata] split to one of {', '.join(SPLITS)}")
    return split


def select_tasks(tasks_dir, tier_name, tier, requested):
    """The task ids of a run. Without a tier, the dev tasks; `requested` narrows the set."""
    splits = {p.name: split_of(p) for p in sorted(tasks_dir.iterdir()) if (p / "task.toml").is_file()}
    unknown = [t for t in requested or [] if t not in splits]
    if unknown:
        raise SystemExit(f"no task {', '.join(unknown)} in {tasks_dir}")
    if tier is None:
        # The holdout tier reports aggregates only, so a run with no tier takes no holdout task.
        pool = [t for t, s in splits.items() if s == "dev"]
    elif tier_name == "smoke" and tier.get("tasks") is not None:
        pool = tier["tasks"]
    else:
        pool = [t for t, s in splits.items() if s in tier["splits"]]
        if tier_name == "smoke":
            pool = pool[: tier["size"]]
    sealed = [t for t in requested or [] if splits[t] == "sealed" and tier_name != "release"]
    if sealed:
        raise SystemExit(f"{', '.join(sealed)}: a sealed task runs only with --tier release")
    holdout = [t for t in requested or [] if splits[t] == "holdout" and tier_name not in ("holdout", "release")]
    if holdout:
        raise SystemExit(f"{', '.join(holdout)}: a holdout task runs only with --tier holdout or release")
    outside = [t for t in requested or [] if t not in pool]
    if outside:
        raise SystemExit(f"{', '.join(outside)}: not in the tasks of {f'the tier {tier_name}' if tier else 'a run without a tier'}")
    return requested or pool


def surface(ref=None):
    """The tool surface of the checkout, or of a revision: its files and their hash, as the smoke check lists them (scripts/checks/evals.mjs)."""
    output = subprocess.run(["node", str(REPO / "scripts/checks/evals.mjs"), "surface", *([ref] if ref else [])], check=True, capture_output=True, text=True).stdout
    return json.loads(output)


class Smoke:
    """The verdict of a smoke run, under the hash of the tool surface (README.md, "The smoke check")."""

    def __init__(self, args, task_ids):
        self.surface = surface()
        self.args = args
        # Production serves the tools of main, so it tests only the surface of main.
        if args.mcp_url == PRODUCTION_MCP and self.surface["hash"] != surface("origin/main")["hash"]:
            raise SystemExit("the tool surface of this checkout is not that of origin/main, so production does not serve it: give --mcp-url and --telemetry-env of a local stack of this checkout")
        invocation = args.out / "invocation.json"
        if invocation.is_file() and json.loads(invocation.read_text()).get("surface") != self.surface["hash"]:
            raise SystemExit(f"{args.out} holds runs of another tool surface, or of no smoke run: give a new --out")
        name = self.surface["hash"]
        # The smoke check reads only the verdict of the smoke list of tiers.json;
        # a run of other tasks (--tasks, --tasks-dir) keeps its own verdict.
        if args.tasks or args.tasks_dir.resolve() != (BENCH / "tasks" / args.twin).resolve():
            tasks = {t: tree_hash(args.tasks_dir / t) for t in task_ids}
            name += "-" + hashlib.sha256(json.dumps(tasks, sort_keys=True).encode()).hexdigest()[:12]
        self.path = SMOKE_CACHE / f"{name}.json"

    def cached(self):
        """The exit code of a cached verdict (0 pass, 1 fail), or None."""
        if not self.path.is_file():
            return None
        verdict = json.loads(self.path.read_text())
        print(f"cached smoke verdict {self.path.stem[:12]}: {'pass' if verdict['pass'] else 'fail'} {verdict['reasons']} (run folder {verdict['runFolder']}); no run, $0")
        return 0 if verdict["pass"] else 1

    def write(self, verdict):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        record = {**verdict, "surface": self.surface, "runFolder": str(self.args.out), "mcpUrl": self.args.mcp_url}
        self.path.write_text(json.dumps(record, indent=2) + "\n")


def smoke_verdict(report, verdict):
    """Pass or fail of a smoke run, with the reasons: a breakage check of the CTX arm, not a measure."""
    reasons = []
    if report["invalidRunCount"]:
        reasons.append(f"{report['invalidRunCount']} invalid runs")
    if report["unresolvedInfraRunCount"]:
        reasons.append(f"{report['unresolvedInfraRunCount']} infrastructure errors")
    arms = [g["arms"]["ctx"] for g in report["groups"] if "ctx" in g["arms"]]
    if not arms:
        return {"pass": False, "reasons": reasons + ["no counted CTX run"], "numbers": {}}
    ctx = arms[0]
    mcp = ctx["mcp"]
    numbers = {
        "tasks": ctx["tasks"],
        "score": ctx["score"],
        "argErrorRate": mcp["argErrorRate"],
        "tasksWithZeroMcpCalls": mcp["tasksWithZeroMcpCalls"],
        "ownServiceErrorRuns": ctx["ownServiceErrorRuns"],
        "limitStops": ctx["limitStops"],
        "usdTotal": ctx["usdTotal"],
    }
    if ctx["limitStops"] * 2 > ctx["runs"]:
        reasons.append(f"{ctx['limitStops']} of {ctx['runs']} runs stopped at a limit")
    if ctx["ownServiceErrorRuns"]:
        reasons.append(f"{ctx['ownServiceErrorRuns']} runs with an own-service error")
    if (mcp["argErrorRate"] or 0) > verdict["maxArgErrorRate"]:
        reasons.append(f"argument error rate {mcp['argErrorRate']} > {verdict['maxArgErrorRate']}")
    if mcp["tasksWithZeroMcpCalls"] / ctx["tasks"] > verdict["maxShareOfTasksWithoutMcp"]:
        reasons.append(f"{mcp['tasksWithZeroMcpCalls']} of {ctx['tasks']} tasks with no MCP call")
    reference = verdict["referenceScore"]
    if reference is not None and ctx["score"] < reference - verdict["maxScoreDrop"]:
        reasons.append(f"score {ctx['score']} < reference {reference} - {verdict['maxScoreDrop']}")
    return {"pass": not reasons, "reasons": reasons, "numbers": numbers}


def pick_smoke(folder, tier):
    """The smoke list from a baseline run: the dev tasks whose CTX score is in the 30-70% band, nearest to 50% first."""
    report = json.loads((folder / "report.json").read_text())
    scores = {}
    for group in report["groups"]:
        for run in group.get("runs", []):
            if run["arm"] == "ctx":
                scores.setdefault(run["task"], []).append(run["score"])
    band = sorted((abs(statistics.fmean(s) - 0.5), t) for t, s in scores.items() if 0.3 <= statistics.fmean(s) <= 0.7)
    return sorted(t for _, t in band[: tier["size"]])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    pick = commands.add_parser("pick-smoke", help="print the smoke list for tiers.json from a baseline run of the dev split")
    pick.add_argument("folder", type=Path)
    args = parser.parse_args()
    print(json.dumps(pick_smoke(args.folder, load()["tiers"]["smoke"])))
