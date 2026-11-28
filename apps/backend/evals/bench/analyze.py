"""The analyzer of OrgBench (phase 1, CTX-1664): runs.jsonl -> report.json and report.md.

It reads the records of one run folder (record.py), and reports for each model
and corpus size (the scale sweep):

- the continuous score, pass@1 and pass^k of each arm;
- the paired delta of each arm against B1+ for each task, with a bootstrap
  confidence interval over the tasks;
- the strata by family, lexical hook and repository count of the task;
- the cost ($/task, $/success), the tokens and the time;
- the process: MCP adoption, argument errors, own-service errors;
- the failure class of each failed run.

A CTX run with no D5 proof is not valid: the report lists it and leaves it out.
A run with an infrastructure error that did not run again is left out too.

  python analyze.py RUN_FOLDER [--pass-at 1.0]
"""

import argparse
import collections
import json
import random
import statistics
import tomllib
from pathlib import Path

from record import run_cost

BASELINE = "b1plus"


def failure_class(run, mcp_arm):
    if run["errorClass"] == "own-service":
        return "own-service error"
    if run["errorClass"] == "infra":
        return "infra"
    if mcp_arm and run["mcpCalls"] == 0:
        return "tool not used"
    if run["goldSeen"] or run["arm"] == "oracle":
        return "reasoning with gold seen"
    if run["argErrors"]:
        return "bad args"
    return "retrieval miss"


def bootstrap_ci(values, rounds=10000, seed=0):
    """The 95% interval of the mean, by resampling the tasks."""
    if len(values) < 2:
        return None
    rng = random.Random(seed)
    means = sorted(statistics.fmean(rng.choices(values, k=len(values))) for _ in range(rounds))
    return [round(means[int(0.025 * rounds)], 4), round(means[int(0.975 * rounds) - 1], 4)]


def mean(values):
    values = [v for v in values if v is not None]
    return round(statistics.fmean(values), 4) if values else None


def repo_bucket(count):
    return "3+" if count >= 3 else str(count)


def arm_summary(runs, pass_at, mcp_arm):
    by_task = collections.defaultdict(list)
    for r in runs:
        by_task[r["task"]].append(r)
    k = min(len(v) for v in by_task.values())
    passes = [r["score"] >= pass_at for r in runs]
    cost = sum(run_cost(r) for r in runs)
    tool_calls = sum(sum(r["toolCalls"].values()) for r in runs)
    mcp_calls = sum(r["mcpCalls"] for r in runs)
    summary = {
        "runs": len(runs),
        "tasks": len(by_task),
        "score": mean(r["score"] for r in runs),
        "pass@1": mean(passes),
        f"pass^{k}": mean(all(r["score"] >= pass_at for r in rs[:k]) for rs in by_task.values()),
        "usdPerTask": round(cost / len(by_task), 4),
        "usdPerSuccess": round(cost / sum(passes), 4) if any(passes) else None,
        "usdTotal": round(cost, 4),
        "tokens": {t: mean(r["tokens"][t] for r in runs) for t in ("input", "output", "cacheRead", "cacheWrite")},
        "wallSeconds": mean(r["wallSeconds"] for r in runs),
        "agentSeconds": mean(r["agentSeconds"] for r in runs),
        "turns": mean(r["turns"] for r in runs),
        "cachedRuns": sum(bool(r.get("cached")) for r in runs),
        "ownServiceErrorRuns": sum(r["errorClass"] == "own-service" for r in runs),
        "failureClasses": dict(collections.Counter(failure_class(r, mcp_arm) for r in runs if r["score"] < pass_at)),
    }
    if mcp_arm:
        summary["mcp"] = {
            "calls": mcp_calls,
            "shareOfToolCalls": round(mcp_calls / tool_calls, 4) if tool_calls else None,
            "tasksWithZeroMcpCalls": sum(all(r["mcpCalls"] == 0 for r in rs) for rs in by_task.values()),
            "argErrors": sum(r["argErrors"] for r in runs),
            "argErrorRate": round(sum(r["argErrors"] for r in runs) / mcp_calls, 4) if mcp_calls else None,
            "serverTools": dict(sum((collections.Counter(r["server"].get("tools", {})) for r in runs), collections.Counter())),
            "jevCalls": sum(r["server"].get("jevCalls", 0) for r in runs),
            "falkorSpans": sum(r["server"].get("falkorSpans", 0) for r in runs),
            "planeFallbackLogs": sum(r["server"].get("planeFallbackLogs", 0) for r in runs),
        }
    return summary


def paired(runs_by_arm, arm, tasks_meta):
    """The per-task delta of `arm` against B1+ (the mean score of the trials of each task)."""
    task_score = lambda runs: {t: statistics.fmean(r["score"] for r in rs) for t, rs in group(runs, "task").items()}
    base, other = task_score(runs_by_arm[BASELINE]), task_score(runs_by_arm[arm])
    deltas = {t: round(other[t] - base[t], 4) for t in sorted(base.keys() & other.keys())}
    strata = {}
    for name, key in (("family", "family"), ("lexicalHook", "lexical_hook"), ("repoCount", "repoBucket")):
        groups = collections.defaultdict(list)
        for t, d in deltas.items():
            groups[str(tasks_meta[t].get(key))].append(d)
        strata[name] = {g: {"tasks": len(v), "delta": mean(v)} for g, v in sorted(groups.items())}
    values = list(deltas.values())
    return {"tasks": len(values), "delta": mean(values), "ci95": bootstrap_ci(values), "perTask": deltas, "strata": strata}


def group(runs, *keys):
    groups = collections.defaultdict(list)
    for r in runs:
        groups[tuple(r[k] for k in keys) if len(keys) > 1 else r[keys[0]]].append(r)
    return groups


def task_metadata(tasks_dir, task):
    path = Path(tasks_dir) / task / "task.toml"
    meta = tomllib.loads(path.read_text()).get("metadata", {}) if path.is_file() else {}
    repos = meta.get("repos", [])
    return {
        "family": meta.get("family"),
        "lexical_hook": meta.get("lexical_hook"),
        "repoBucket": repo_bucket(len(repos)) if repos else None,
    }


def analyze(folder, pass_at):
    invocation = json.loads((folder / "invocation.json").read_text())
    config = json.loads((Path(__file__).resolve().parent / "arms.json").read_text())
    records = [json.loads(line) for line in (folder / "runs.jsonl").read_text().splitlines()]
    # The last record of each run counts: an infrastructure error ran again.
    latest = {}
    for r in records:
        latest[(r["model"], r["arm"], r["task"], r["trial"], r["repos"])] = r
    invalid = [r for r in latest.values() if not r["valid"]]
    infra = [r for r in latest.values() if r["valid"] and r["errorClass"] == "infra"]
    counted = [r for r in latest.values() if r["valid"] and r["errorClass"] != "infra"]
    tasks_meta = {t: task_metadata(invocation["tasksDir"], t) for t in {r["task"] for r in records}}
    report = {
        "twin": invocation["twin"],
        "mcpUrl": invocation["mcpUrl"],
        "passAt": pass_at,
        "spendUsd": round(sum(run_cost(r) for r in records if not r.get("cached")), 4),
        "infraRetries": sum(r["errorClass"] == "infra" for r in records),
        "invalidRuns": [{"runId": r["runId"], "reasons": r["invalidReasons"]} for r in invalid],
        "unresolvedInfraRuns": [{"runId": r["runId"], "error": r["error"]} for r in infra],
        "tasks": tasks_meta,
        "groups": [],
    }
    for (model, repos), runs in sorted(group(counted, "model", "repos").items()):
        by_arm = group(runs, "arm")
        entry = {
            "model": model,
            "repos": repos,
            "arms": {arm: arm_summary(rs, pass_at, config["arms"][arm]["mcp"]) for arm, rs in sorted(by_arm.items())},
            "paired": {arm: paired(by_arm, arm, tasks_meta) for arm in sorted(by_arm) if arm != BASELINE and BASELINE in by_arm},
            "runs": [
                {k: r[k] for k in ("task", "arm", "trial", "score", "mcpCalls", "argErrors", "goldSeen", "errorClass")}
                | {"usd": round(run_cost(r), 4), "failure": failure_class(r, config["arms"][r["arm"]]["mcp"]) if r["score"] < pass_at else None}
                for r in sorted(runs, key=lambda r: (r["task"], r["arm"], r["trial"]))
            ],
        }
        report["groups"].append(entry)
    return report


def markdown(report):
    lines = [f"# OrgBench report: {report['twin']}", ""]
    lines.append(f"CTX MCP: `{report['mcpUrl']}`. A run passes at a score of {report['passAt']} or more. Spend of this folder: ${report['spendUsd']}. Infrastructure retries: {report['infraRetries']}.")
    lines.append("")
    if report["invalidRuns"]:
        lines += ["**Invalid runs (left out):**", ""] + [f"- `{r['runId']}`: {'; '.join(r['reasons'])}" for r in report["invalidRuns"]] + [""]
    if report["unresolvedInfraRuns"]:
        lines += ["**Infrastructure errors that did not run again (left out):**", ""] + [f"- `{r['runId']}`: {r['error']}" for r in report["unresolvedInfraRuns"]] + [""]
    for g in report["groups"]:
        lines += [f"## {g['model']}, {g['repos']} repositories", ""]
        lines += ["| Arm | Runs | Tasks | Score | pass@1 | pass^k | $/task | $/success | Input | Output | Cache read | Cache write | Wall s | Turns | Cached |",
                  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for arm, s in g["arms"].items():
            k = next(key for key in s if key.startswith("pass^"))
            t = s["tokens"]
            lines.append(f"| {arm} | {s['runs']} | {s['tasks']} | {s['score']} | {s['pass@1']} | {s[k]} ({k}) | {s['usdPerTask']} | {s['usdPerSuccess']} | {t['input']} | {t['output']} | {t['cacheRead']} | {t['cacheWrite']} | {s['wallSeconds']} | {s['turns']} | {s['cachedRuns']} |")
        lines.append("")
        for arm, p in g["paired"].items():
            lines.append(f"**{arm} − {BASELINE}:** mean delta {p['delta']} over {p['tasks']} tasks, 95% CI {p['ci95']}.")
            for name, strata in p["strata"].items():
                lines.append(f"- {name}: " + ", ".join(f"{k} {v['delta']} (n={v['tasks']})" for k, v in strata.items()))
            lines.append("")
        for arm, s in g["arms"].items():
            if "mcp" in s:
                m = s["mcp"]
                lines.append(f"**{arm} process:** {m['calls']} MCP calls ({m['shareOfToolCalls']} of the tool calls), {m['tasksWithZeroMcpCalls']} tasks with no MCP call, {m['argErrors']} argument errors (rate {m['argErrorRate']}), {s['ownServiceErrorRuns']} runs with an own-service error. Server tools {m['serverTools']}, Jev calls {m['jevCalls']}. D5: {m['falkorSpans']} falkordb spans, {m['planeFallbackLogs']} plane fallback logs.")
                lines.append("")
        classes = {arm: s["failureClasses"] for arm, s in g["arms"].items() if s["failureClasses"]}
        if classes:
            lines.append("**Failure classes:** " + "; ".join(f"{arm}: {c}" for arm, c in classes.items()))
            lines.append("")
        lines += ["| Task | Arm | Trial | Score | MCP calls | Arg errors | Gold seen | $ | Failure |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for r in g["runs"]:
            lines.append(f"| {r['task']} | {r['arm']} | {r['trial']} | {r['score']} | {r['mcpCalls']} | {r['argErrors']} | {len(r['goldSeen'])} | {r['usd']} | {r['failure'] or ''} |")
        lines.append("")
    return "\n".join(lines)


def write_report(folder, pass_at=1.0):
    report = analyze(folder, pass_at)
    (folder / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    text = markdown(report)
    (folder / "report.md").write_text(text + "\n")
    return text


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    parser.add_argument("--pass-at", type=float, default=1.0, help="the score at which a run passes")
    args = parser.parse_args()
    print(write_report(args.folder, args.pass_at))
