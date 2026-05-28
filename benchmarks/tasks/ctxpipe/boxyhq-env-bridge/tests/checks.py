from __future__ import annotations

import json
from pathlib import Path

import rewardkit as rk


ORACLE_PATH = Path(__file__).with_name("oracle.json")


def _load_oracle() -> dict[str, str]:
    return json.loads(ORACLE_PATH.read_text())


_oracle = _load_oracle()

rk.json_key_equals("answer.json", "jackson_url_env", _oracle["jackson_url_env"], weight=0.2)
rk.json_key_equals(
    "answer.json",
    "jackson_external_url_env",
    _oracle["jackson_external_url_env"],
    weight=0.2,
)
rk.json_key_equals(
    "answer.json", "jackson_api_key_env", _oracle["jackson_api_key_env"], weight=0.2
)
rk.json_key_equals(
    "answer.json",
    "polis_saml_path_prefix",
    _oracle["polis_saml_path_prefix"],
    weight=0.2,
)
rk.json_key_equals(
    "answer.json",
    "polis_saml_path_source_file",
    _oracle["polis_saml_path_source_file"],
    weight=0.2,
)
