"""The analyzer of OrgBench (phases 1 and 2, CTX-1664, CTX-1665): runs.jsonl -> report.json and report.md.

It reads the records of one run folder (record.py), and reports for each model
and corpus size (the scale sweep):

- the continuous score, pass@1 and pass^k of each arm;
- the paired delta of each arm against B1+ for each task, with a bootstrap
  confidence interval over the tasks;
- the strata by family, lexical hook and repository count of the task;
- the cost ($/task, $/success), the tokens and the time;
- the process: MCP adoption, argument errors, own-service errors;
- the failure class of each failed run;
- for a candidate run: the keep rule (ADR-075 decision 9) and the B1+ sentinel.

A CTX run with no D5 proof is not valid: the report lists it and leaves it out.
A run with an infrastructure error that did not run again is left out too. A
tier with aggregate results only (holdout, release) gives no result of a task.

  python analyze.py RUN_FOLDER [--pass-at 1.0] [--l0-win]
"""

import argparse
import collections
import json
import random
import statistics
from pathlib import Path

from record import run_cost, run_key, task_config

BASELINE = "b1plus"
CANDIDATE, KEPT = "ctx:candidate", "ctx:kept"


def failure_class(run, arm):
    """The failure class of a failed run; `arm` is its config in arms.json."""
    if run["errorClass"] == "own-service":
        return "own-service error"
    if run["errorClass"] == "infra":
        return "infra"
    if arm["mcp"] and run["mcpCalls"] == 0:
        return "tool not used"
    if run["goldSeen"] or arm["goldContext"]:
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


def arm_summary(runs, pass_at, arm):
    by_task = group(runs, "task")
    k = min(len(v) for v in by_task.values())
    passes = [r["score"] >= pass_at for r in runs]
    cost = sum(run_cost(r) for r in runs)
    tool_calls = sum(sum(r["toolCalls"].values()) for r in runs)
    mcp_calls = sum(r["mcpCalls"] for r in runs)
    summary = {
        "runs": len(runs),
        "tasks": len(by_task),
        "score": mean(r["score"] for r in runs),
        # pass@1 reads the first trial of each task; pass^k needs each of the first k trials to pass.
        "pass@1": mean(min(rs, key=lambda r: r["trial"])["score"] >= pass_at for rs in by_task.values()),
        f"pass^{k}": mean(all(r["score"] >= pass_at for r in sorted(rs, key=lambda r: r["trial"])[:k]) for rs in by_task.values()),
        # The mean cost of one run of one task.
        "usdPerTask": round(cost / len(runs), 4),
        "usdPerSuccess": round(cost / sum(passes), 4) if any(passes) else None,
        "usdTotal": round(cost, 4),
        "tokens": {t: mean(r["tokens"][t] for r in runs) for t in ("input", "output", "cacheRead", "cacheWrite")},
        "wallSeconds": mean(r["wallSeconds"] for r in runs),
        "agentSeconds": mean(r["agentSeconds"] for r in runs),
        "turns": mean(r["turns"] for r in runs),
        "cachedRuns": sum(bool(r.get("cached")) for r in runs),
        "ownServiceErrorRuns": sum(r["errorClass"] == "own-service" for r in runs),
        # Runs that stopped at a limit: the gateway cap, the turn, dollar or time limit.
        "limitStops": sum(bool(r.get("gatewayRefused")) or str(r.get("stopReason") or "").startswith("error_max") for r in runs),
        "failureClasses": dict(collections.Counter(failure_class(r, arm) for r in runs if r["score"] < pass_at)),
    }
    if arm["mcp"]:
        summary["mcp"] = {
            "calls": mcp_calls,
            "shareOfToolCalls": round(mcp_calls / tool_calls, 4) if tool_calls else None,
            "tasksWithZeroMcpCalls": sum(all(r["mcpCalls"] == 0 for r in rs) for rs in by_task.values()),
            "argErrors": sum(r["argErrors"] for r in runs),
            "argErrorRate": round(sum(r["argErrors"] for r in runs) / mcp_calls, 4) if mcp_calls else None,
            "serverTools": dict(sum((collections.Counter(r["server"].get("tools", {})) for r in runs), collections.Counter())),
            "jevCalls": sum(r["server"].get("jevCalls", 0) for r in runs),
            "planeFallbackLogs": sum(r["server"].get("planeFallbackLogs", 0) for r in runs),
            # Two SHAs of one branch: the snapshot moved during the runs.
            "served": dict(sum((collections.Counter(r.get("served", {})) for r in runs), collections.Counter())),
        }
    return summary


def arm_config(config, arm):
    """The config of an arm in arms.json: `ctx:candidate` and `ctx:kept` are the arm `ctx`."""
    return config["arms"][arm.split(":")[0]]


def task_means(runs, value):
    return {t: statistics.fmean(value(r) for r in rs) for t, rs in group(runs, "task").items()}


def bound(name, deltas, margin, worse):
    """Non-inferiority of one metric: the 95% bound of the per-task delta (candidate - kept) against its margin.

    `worse` is -1 when a lower value is a loss (score), +1 when a higher value is a loss (cost).
    """
    values = list(deltas.values())
    ci = bootstrap_ci(values)
    result = {"metric": name, "tasks": len(values), "delta": mean(values), "ci95": ci, "margin": round(margin, 4)}
    if ci is None:
        return result | {"state": "unknown"}
    # The loss side of the interval, as a positive number when it is a loss.
    near, far = (-ci[1], -ci[0]) if worse < 0 else (ci[0], ci[1])
    state = "inferior" if near > margin else "non-inferior" if far < margin else "unknown"
    return result | {"state": state}


def win(name, deltas):
    """A process win: the 95% interval of the per-task gain (positive is better) lies above 0."""
    values = list(deltas.values())
    ci = bootstrap_ci(values)
    return {"metric": name, "tasks": len(values), "gain": mean(values), "ci95": ci, "win": bool(ci and ci[0] > 0)}


def keep_rule(by_arm, tasks_meta, rules, l0_win):
    """The keep rule of ADR-075 decision 9 for a candidate CTX against the kept CTX of the same batch.

    Keep: an L0 win (given) or an L2-process win (argument errors, tool adoption), and
    non-inferiority on success, cost and harm: the 95% bound of each excludes a loss larger
    than its margin. Reject: a bound shows a loss larger than its margin. Else inconclusive,
    which does not keep the change.
    """
    candidate, kept = by_arm[CANDIDATE], by_arm[KEPT]
    tasks = sorted(set(group(candidate, "task")) & set(group(kept, "task")))
    pick = lambda runs: [r for r in runs if r["task"] in tasks]
    candidate, kept = pick(candidate), pick(kept)

    def delta(value, among=tasks):
        c, k = task_means(candidate, value), task_means(kept, value)
        return {t: c[t] - k[t] for t in among}

    margins = rules["margins"]
    kept_cost = mean(task_means(kept, run_cost).values()) or 0
    harm_tasks = [t for t in tasks if tasks_meta[t].get("family") in rules["harmFamilies"]]
    guards = [
        bound("score", delta(lambda r: r["score"]), margins["score"], -1),
        bound("costUsd", delta(run_cost), margins["costShare"] * kept_cost, +1),
        bound("harm", delta(lambda r: r["score"], harm_tasks), margins["harm"], -1),
    ]
    arg_rate = lambda r: r["argErrors"] / r["mcpCalls"] if r["mcpCalls"] else 0.0
    process = [
        # Fewer argument errors and more tool adoption are gains.
        win("argErrorRate", {t: -d for t, d in delta(arg_rate).items()}),
        win("toolAdoption", delta(lambda r: float(r["mcpCalls"] > 0))),
    ]
    won = l0_win or any(p["win"] for p in process)
    reasons = []
    if len(tasks) < rules["minTasks"]:
        reasons.append(f"{len(tasks)} paired tasks, fewer than {rules['minTasks']}")
    inferior = [g["metric"] for g in guards if g["state"] == "inferior"]
    unknown = [g["metric"] for g in guards if g["state"] == "unknown"]
    if inferior:
        verdict = "reject"
        reasons.append(f"a loss larger than the margin: {', '.join(inferior)}")
    else:
        if unknown:
            reasons.append(f"non-inferiority not shown: {', '.join(unknown)}")
        if not won:
            reasons.append("no L0 or L2-process win")
        verdict = "inconclusive" if reasons else "keep"
    return {"verdict": verdict, "reasons": reasons, "tasks": len(tasks), "l0Win": l0_win, "guards": guards, "process": process}


def sentinel_drift(runs, rules):
    """The B1+ sentinel: the fresh B1+ runs of a candidate batch against their cached records."""
    pairs = [(r["score"], r["cachedScore"]) for r in runs if r.get("sentinel")]
    compared = [abs(a - b) for a, b in pairs if b is not None]
    drift = mean(compared)
    return {"runs": len(pairs), "compared": len(compared), "drift": drift, "maxDrift": rules["maxDrift"], "drifted": drift is not None and drift > rules["maxDrift"]}


def workspace_shas(run):
    """The SHAs of the Workspace branch that a CTX run read (a pinned repository has its SHA as its branch)."""
    return sorted({ref.split("@")[1] for ref in run.get("served", {}) if ref.split("@")[0] != ref.split("@")[1]})


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
    meta = task_config(Path(tasks_dir) / task).get("metadata", {})
    count = len(meta.get("repos", []))
    return {
        "family": meta.get("family"),
        "lexical_hook": meta.get("lexical_hook"),
        "repoBucket": ("3+" if count >= 3 else str(count)) if count else None,
    }


def analyze(folder, pass_at, l0_win=False):
    invocation = json.loads((folder / "invocation.json").read_text())
    config = json.loads((Path(__file__).resolve().parent / "arms.json").read_text())
    rules = json.loads((Path(__file__).resolve().parent / "tiers.json").read_text())
    aggregate_only = invocation.get("aggregateOnly", False)
    records = [json.loads(line) for line in (folder / "runs.jsonl").read_text().splitlines()]
    # The last record of each run counts: an infrastructure error ran again.
    latest = {}
    for r in records:
        latest[run_key(r)] = r
    invalid = [r for r in latest.values() if not r["valid"]]
    infra = [r for r in latest.values() if r["valid"] and r["errorClass"] == "infra"]
    counted = [r for r in latest.values() if r["valid"] and r["errorClass"] != "infra"]
    tasks_meta = {t: task_metadata(invocation["tasksDir"], t) for t in {r["task"] for r in records}}
    report = {
        "twin": invocation["twin"],
        "tier": invocation.get("tier"),
        "aggregateOnly": aggregate_only,
        "mcpUrl": invocation["mcpUrl"],
        "candidate": invocation.get("candidate"),
        # The snapshot of the baseline arms; each CTX run names the snapshot it read (`served`).
        "contextSha": config["twins"][invocation["twin"]]["context"]["sha"],
        "passAt": pass_at,
        "spendUsd": round(sum(run_cost(r) for r in records if not r.get("cached")), 4),
        "infraRetries": sum(r["errorClass"] == "infra" for r in records),
        "invalidRuns": [{"runId": r["runId"], "reasons": r["invalidReasons"]} for r in invalid],
        "unresolvedInfraRuns": [{"runId": r["runId"], "error": r["error"]} for r in infra],
        "tasks": {} if aggregate_only else tasks_meta,
        "groups": [],
    }
    for (model, repos), runs in sorted(group(counted, "model", "repos").items()):
        by_arm = group(runs, "arm")
        entry = {
            "model": model,
            "repos": repos,
            "arms": {arm: arm_summary(rs, pass_at, arm_config(config, arm)) for arm, rs in sorted(by_arm.items())},
            "paired": {arm: paired(by_arm, arm, tasks_meta) for arm in sorted(by_arm) if arm != BASELINE and BASELINE in by_arm},
            "runs": [] if aggregate_only else [
                {k: r[k] for k in ("task", "arm", "trial", "score", "mcpCalls", "argErrors", "goldSeen", "errorClass")}
                | {"usd": round(run_cost(r), 4), "workspaceShas": workspace_shas(r)}
                | {"failure": failure_class(r, arm_config(config, r["arm"])) if r["score"] < pass_at else None}
                for r in sorted(runs, key=lambda r: (r["task"], r["arm"], r["trial"]))
            ],
        }
        if CANDIDATE in by_arm and KEPT in by_arm:
            entry["keep"] = keep_rule(by_arm, tasks_meta, rules["keep"], l0_win or invocation.get("l0Win", False))
        if any(r.get("sentinel") for r in runs):
            entry["sentinel"] = sentinel_drift(runs, rules["sentinel"])
        if aggregate_only:
            # A holdout or sealed task gives no result of its own (ADR-075
            # decision 12); a stratum can hold one task, so it goes too.
            for p in entry["paired"].values():
                del p["perTask"], p["strata"]
        report["groups"].append(entry)
    return report


def markdown(report):
    lines = [f"# OrgBench report: {report['twin']}", ""]
    lines.append(f"B1+ and ORACLE corpus: the plan of the twin and the context repo at `{report['contextSha'][:8]}`. CTX MCP: `{report['mcpUrl']}`. A run passes at a score of {report['passAt']} or more. Spend of this folder: ${report['spendUsd']}. Infrastructure retries: {report['infraRetries']}.")
    if report["tier"]:
        lines.append(f"Tier: {report['tier']}{' (aggregate results only)' if report['aggregateOnly'] else ''}.")
    if report["candidate"]:
        lines.append(f"Candidate MCP: `{report['candidate']['mcpUrl']}` (`{report['candidate']['telemetryEnv']}`); kept MCP: `{report['mcpUrl']}`.")
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
            for name, strata in p.get("strata", {}).items():
                lines.append(f"- {name}: " + ", ".join(f"{k} {v['delta']} (n={v['tasks']})" for k, v in strata.items()))
            lines.append("")
        for arm, s in g["arms"].items():
            if "mcp" in s:
                m = s["mcp"]
                lines.append(f"**{arm} process:** {m['calls']} MCP calls ({m['shareOfToolCalls']} of the tool calls), {m['tasksWithZeroMcpCalls']} tasks with no MCP call, {m['argErrors']} argument errors (rate {m['argErrorRate']}), {s['ownServiceErrorRuns']} runs with an own-service error. Server tools {m['serverTools']}, Jev calls {m['jevCalls']}. D5: {m['planeFallbackLogs']} plane fallback logs.")
                lines.append("")
                lines.append(f"**{arm} served snapshot** (`branch@sha` of the hits and files): " + ", ".join(f"`{k}` {v}" for k, v in sorted(m["served"].items())))
                lines.append("")
        classes = {arm: s["failureClasses"] for arm, s in g["arms"].items() if s["failureClasses"]}
        if classes:
            lines.append("**Failure classes:** " + "; ".join(f"{arm}: {c}" for arm, c in classes.items()))
            lines.append("")
        if "keep" in g:
            k = g["keep"]
            lines.append(f"**Keep rule ({CANDIDATE} against {KEPT}): {k['verdict']}** over {k['tasks']} paired tasks. " + ("; ".join(k["reasons"]) + "." if k["reasons"] else ""))
            lines.append("")
            lines += ["| Guard | Delta | 95% CI | Margin | State |", "| --- | --- | --- | --- | --- |"]
            lines += [f"| {x['metric']} (n={x['tasks']}) | {x['delta']} | {x['ci95']} | {x['margin']} | {x['state']} |" for x in k["guards"]]
            lines += ["", "| Process | Gain | 95% CI | Win |", "| --- | --- | --- | --- |"]
            lines += [f"| {x['metric']} (n={x['tasks']}) | {x['gain']} | {x['ci95']} | {x['win']} |" for x in k["process"]]
            lines += ["", f"L0 win (given): {k['l0Win']}.", ""]
        if "sentinel" in g:
            x = g["sentinel"]
            lines.append(f"**B1+ sentinel:** {x['runs']} fresh runs, {x['compared']} with a cached record, mean drift {x['drift']} (limit {x['maxDrift']}). " + ("The cache drifted: run the baselines again with --no-cache." if x["drifted"] else "No drift above the limit."))
            lines.append("")
        if report["aggregateOnly"]:
            continue
        lines += ["| Task | Arm | Trial | Score | MCP calls | Arg errors | Gold seen | $ | Failure | Workspace SHA read |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
        for r in g["runs"]:
            lines.append(f"| {r['task']} | {r['arm']} | {r['trial']} | {r['score']} | {r['mcpCalls']} | {r['argErrors']} | {len(r['goldSeen'])} | {r['usd']} | {r['failure'] or ''} | {' '.join(sha[:8] for sha in r['workspaceShas'])} |")
        lines.append("")
    return "\n".join(lines)


def write_report(folder, pass_at=1.0, l0_win=False):
    report = analyze(folder, pass_at, l0_win)
    (folder / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    text = markdown(report)
    (folder / "report.md").write_text(text + "\n")
    return text


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    parser.add_argument("--pass-at", type=float, default=1.0, help="the score at which a run passes")
    parser.add_argument("--l0-win", action="store_true", help="the L0 eval (evals/knowledge, holdout) kept the change: an input of the keep rule")
    args = parser.parse_args()
    print(write_report(args.folder, args.pass_at, args.l0_win))
