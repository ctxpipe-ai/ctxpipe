#!/usr/bin/env python3
import json
from pathlib import Path

WORKSPACE = Path("/app")
ANSWER_PATH = WORKSPACE / "answer.json"
ORACLE_PATH = Path("/tests/oracle.json")
REWARD_PATH = Path("/logs/verifier/reward.txt")
DETAILS_PATH = Path("/logs/verifier/reward-details.json")


def main() -> int:
    details = {
        "checks": [],
        "status": "failed",
    }

    if not ANSWER_PATH.exists():
        details["checks"].append(
            {"name": "answer_exists", "ok": False, "error": "Missing /app/answer.json"}
        )
        write_outputs(0, details)
        return 0

    try:
        answer = json.loads(ANSWER_PATH.read_text())
    except json.JSONDecodeError as exc:
        details["checks"].append(
            {"name": "answer_json_valid", "ok": False, "error": str(exc)}
        )
        write_outputs(0, details)
        return 0

    oracle = json.loads(ORACLE_PATH.read_text())
    ok = True
    for key, expected in oracle.items():
        actual = answer.get(key)
        match = actual == expected
        if not match:
            ok = False
        details["checks"].append(
            {"name": key, "ok": match, "expected": expected, "actual": actual}
        )

    extra_keys = sorted(set(answer.keys()) - set(oracle.keys()))
    if extra_keys:
        ok = False
        details["checks"].append(
            {"name": "no_extra_keys", "ok": False, "extra_keys": extra_keys}
        )
    else:
        details["checks"].append({"name": "no_extra_keys", "ok": True})

    details["status"] = "passed" if ok else "failed"
    write_outputs(1 if ok else 0, details)
    return 0


def write_outputs(reward: int, details: dict) -> None:
    REWARD_PATH.write_text(f"{reward}\n")
    DETAILS_PATH.write_text(json.dumps(details, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    raise SystemExit(main())
