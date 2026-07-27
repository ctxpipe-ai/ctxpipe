from __future__ import annotations

import json
from pathlib import Path

import rewardkit as rk


ORACLE_PATH = Path(__file__).with_name("oracle.json")


def _load_oracle() -> dict[str, str]:
    return json.loads(ORACLE_PATH.read_text())


_oracle = _load_oracle()

# Guardrails: baseline arm must include the pinned primary-repo checkout.
rk.file_exists(".github/CODEOWNERS", weight=0.4)
rk.file_exists("package.json", weight=0.5)
rk.file_exists("scripts/codeowners-manifest/index.js", weight=0.4)

rk.json_key_equals("answer.json", "codeowners_file", _oracle["codeowners_file"], weight=0.1)
rk.json_key_equals(
    "answer.json",
    "codeowners_validator_workflow",
    _oracle["codeowners_validator_workflow"],
    weight=0.1,
)
rk.json_key_equals(
    "answer.json", "manifest_constants_script", _oracle["manifest_constants_script"], weight=0.1
)
rk.json_key_equals(
    "answer.json",
    "manifest_index_script",
    _oracle["manifest_index_script"],
    weight=0.1,
)
rk.json_key_equals(
    "answer.json", "manifest_raw_script", _oracle["manifest_raw_script"], weight=0.1
)
rk.json_key_equals(
    "answer.json",
    "manifest_generate_script",
    _oracle["manifest_generate_script"],
    weight=0.1,
)
rk.json_key_equals(
    "answer.json",
    "manifest_metadata_script",
    _oracle["manifest_metadata_script"],
    weight=0.1,
)
rk.json_key_equals(
    "answer.json", "manifest_utils_script", _oracle["manifest_utils_script"], weight=0.1
)
rk.json_key_equals(
    "answer.json",
    "featuremgmt_codeowners_go",
    _oracle["featuremgmt_codeowners_go"],
    weight=0.1,
)
rk.json_key_equals(
    "answer.json", "featuremgmt_models_go", _oracle["featuremgmt_models_go"], weight=0.1
)
rk.json_key_equals(
    "answer.json",
    "package_json_manifest_script",
    _oracle["package_json_manifest_script"],
    weight=0.1,
)
