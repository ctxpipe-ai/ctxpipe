from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import rewardkit as rk
from rewardkit import criterion


ORACLE_PATH = Path(__file__).with_name("oracle.json")
_oracle = json.loads(ORACLE_PATH.read_text())

_required_top_level_keys = {
    "selected_option",
    "alternatives_considered",
    "evidence",
    "decision_summary",
}
_allowed_options = set(_oracle["allowed_options"])
_required_repos = set(_oracle["required_repos"])
_evidence_catalog = _oracle["evidence_catalog"]
_evidence_catalog_exact = {
    (
        item["repo"],
        item["path"],
        item["claim"],
        bool(item["supports_option"]),
    )
    for item in _evidence_catalog
}
_evidence_catalog_by_repo_path = {
    (item["repo"], item["path"]): item for item in _evidence_catalog
}


def _load_answer(workspace: Path) -> dict[str, Any] | None:
    answer_path = workspace / "answer.json"
    if not answer_path.exists():
        return None
    try:
        parsed = json.loads(answer_path.read_text())
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    return parsed


def _load_evidence(answer: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not answer:
        return []
    evidence = answer.get("evidence")
    if not isinstance(evidence, list):
        return []
    typed: list[dict[str, Any]] = []
    for item in evidence:
        if isinstance(item, dict):
            typed.append(item)
    return typed


# Guardrails: ctxpipe arm must not include the pinned primary-repo checkout.
rk.file_not_exists(".gitignore", weight=0.4)
rk.file_not_exists("README.md", weight=0.5)
rk.file_not_exists("pkg/storage/factory.go", weight=0.4)


@criterion(description="answer.json contains exactly the required top-level keys")
def has_exact_top_level_keys(workspace: Path) -> bool:
    answer = _load_answer(workspace)
    if not answer:
        return False
    return set(answer.keys()) == _required_top_level_keys


@criterion(description="top-level fields have expected JSON types")
def has_valid_top_level_types(workspace: Path) -> bool:
    answer = _load_answer(workspace)
    if not answer:
        return False
    return (
        isinstance(answer.get("selected_option"), str)
        and isinstance(answer.get("alternatives_considered"), list)
        and isinstance(answer.get("evidence"), list)
        and isinstance(answer.get("decision_summary"), str)
    )


@criterion(description="selected option and alternatives only use allowed option values")
def uses_allowed_option_values(workspace: Path) -> bool:
    answer = _load_answer(workspace)
    if not answer:
        return False
    selected_option = answer.get("selected_option")
    alternatives = answer.get("alternatives_considered")
    if not isinstance(selected_option, str) or not isinstance(alternatives, list):
        return False
    if selected_option not in _allowed_options:
        return False
    for option in alternatives:
        if not isinstance(option, str) or option not in _allowed_options:
            return False
    return True


@criterion(description="alternatives list has at least two unique valid options excluding the selected one")
def alternatives_valid(workspace: Path) -> bool:
    answer = _load_answer(workspace)
    if not answer:
        return False
    selected_option = answer.get("selected_option")
    alternatives = answer.get("alternatives_considered")
    if not isinstance(selected_option, str) or not isinstance(alternatives, list):
        return False
    if len(alternatives) < 2:
        return False
    unique_alternatives = {item for item in alternatives if isinstance(item, str)}
    if len(unique_alternatives) < 2:
        return False
    return all(option in _allowed_options and option != selected_option for option in unique_alternatives)


@criterion(description="every evidence entry includes required keys and valid value types")
def evidence_entries_valid(workspace: Path) -> bool:
    answer = _load_answer(workspace)
    evidence = _load_evidence(answer)
    if not answer or not isinstance(answer.get("evidence"), list):
        return False
    if len(evidence) != len(answer["evidence"]):
        return False
    required_keys = {"repo", "path", "claim", "supports_option"}
    for item in evidence:
        if set(item.keys()) != required_keys:
            return False
        if not isinstance(item["repo"], str) or not item["repo"].strip():
            return False
        if not isinstance(item["path"], str) or not item["path"].strip():
            return False
        if not isinstance(item["claim"], str) or not item["claim"].strip():
            return False
        if not isinstance(item["supports_option"], bool):
            return False
    return True


@criterion(description="evidence list has at least the minimum required number of entries")
def evidence_minimum_count(workspace: Path) -> bool:
    answer = _load_answer(workspace)
    evidence = _load_evidence(answer)
    return len(evidence) >= int(_oracle["min_evidence"])


@criterion(description="evidence spans at least two distinct repositories")
def evidence_spans_multiple_repos(workspace: Path) -> bool:
    answer = _load_answer(workspace)
    evidence = _load_evidence(answer)
    repos = {item.get("repo") for item in evidence if isinstance(item.get("repo"), str)}
    return len(repos) >= 2


@criterion(description="evidence includes both primary-repo and sibling-repo references")
def evidence_has_primary_and_sibling(workspace: Path) -> bool:
    answer = _load_answer(workspace)
    evidence = _load_evidence(answer)
    repos = {item.get("repo") for item in evidence if isinstance(item.get("repo"), str)}
    has_primary = "grafana/loki" in repos
    has_sibling = len(repos.intersection(_required_repos - {"grafana/loki"})) > 0
    return has_primary and has_sibling


@criterion(description="evidence precision score against pinned oracle catalog")
def evidence_precision_score(workspace: Path) -> float:
    answer = _load_answer(workspace)
    evidence = _load_evidence(answer)
    if not evidence:
        return 0.0

    penalties = 0.0
    seen_exact: set[tuple[str, str, str, bool]] = set()

    for item in evidence:
        repo = item.get("repo")
        path = item.get("path")
        claim = item.get("claim")
        supports_option = item.get("supports_option")
        if not isinstance(repo, str) or not isinstance(path, str) or not isinstance(claim, str):
            penalties += 0.35
            continue
        if not isinstance(supports_option, bool):
            penalties += 0.15
            continue

        evidence_tuple = (repo, path, claim, supports_option)
        if evidence_tuple in seen_exact:
            penalties += 0.2
            continue
        seen_exact.add(evidence_tuple)

        if evidence_tuple in _evidence_catalog_exact:
            continue

        expected = _evidence_catalog_by_repo_path.get((repo, path))
        if expected is None:
            penalties += 0.35
            continue
        if claim != expected["claim"]:
            penalties += 0.2
        if supports_option is not bool(expected["supports_option"]):
            penalties += 0.15

    return max(0.0, min(1.0, 1.0 - penalties))


rk.has_exact_top_level_keys(weight=0.35)
rk.has_valid_top_level_types(weight=0.35)
rk.uses_allowed_option_values(weight=0.3)

rk.json_key_equals("answer.json", "selected_option", _oracle["selected_option"], weight=0.8)
rk.alternatives_valid(weight=0.4)

rk.evidence_entries_valid(weight=0.3)
rk.evidence_minimum_count(weight=0.5)
rk.evidence_spans_multiple_repos(weight=0.5)
rk.evidence_has_primary_and_sibling(weight=0.3)

rk.evidence_precision_score(weight=1.1)
