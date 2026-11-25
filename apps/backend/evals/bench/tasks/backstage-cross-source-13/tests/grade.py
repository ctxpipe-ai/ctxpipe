"""Score an answer against the key facts of its task (OrgBench spike, CTX-1660).

Each key fact of `gold.json` has groups of patterns. A fact matches when each
of its groups has a pattern that the answer holds (a case-insensitive regular
expression). The reward is the fraction of the facts that match. The check is
deterministic and crude on purpose: a judge panel replaces it after the spike.

The answer is /app/answer.md. When the agent wrote no such file, the answer is
the final text of the Claude Code run (the `result` event of its stream).
"""

import json
import re
import sys
from pathlib import Path


def answer_text() -> str:
    path = Path("/app/answer.md")
    if path.is_file():
        return path.read_text(errors="replace")
    stream = Path("/logs/agent/claude-code.txt")
    if stream.is_file():
        for line in reversed(stream.read_text(errors="replace").splitlines()):
            if line.startswith("{") and '"type":"result"' in line.replace(" ", ""):
                return json.loads(line).get("result") or ""
    return ""


def main() -> None:
    gold = json.loads(Path(sys.argv[1]).read_text())
    text = answer_text()
    facts = []
    for fact in gold["facts"]:
        matched = all(
            any(re.search(pattern, text, re.IGNORECASE | re.DOTALL) for pattern in group)
            for group in fact["groups"]
        )
        facts.append({"fact": fact["fact"], "matched": matched})
    reward = sum(f["matched"] for f in facts) / len(facts)
    out = Path("/logs/verifier")
    out.mkdir(parents=True, exist_ok=True)
    (out / "reward.txt").write_text(f"{reward:.4f}\n")
    (out / "facts.json").write_text(
        json.dumps({"answer_chars": len(text), "facts": facts}, indent=2)
    )
    print(f"reward {reward:.4f}")


main()
