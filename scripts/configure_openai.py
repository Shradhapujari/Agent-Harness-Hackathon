"""Configure the TrueForge OpenAI provider from a key this repo never stores.

    echo -n 'sk-...' > ~/.hush-openai-key   # or export OPENAI_API_KEY
    uv run python scripts/configure_openai.py

The key is read from $OPENAI_API_KEY or ~/.hush-openai-key, sent once to the
local TrueForge instance, and never printed or written anywhere else.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

BASE = os.getenv("TRUEFORGE_BASE_URL", "http://localhost:8790")
KEY_FILE = Path.home() / ".hush-openai-key"
MODEL_ID = "gpt-5.6-luna"


def _key() -> str:
    key = os.getenv("OPENAI_API_KEY", "").strip()
    if key:
        return key
    if KEY_FILE.exists():
        return KEY_FILE.read_text().strip()
    sys.exit(f"no key: set OPENAI_API_KEY or write one to {KEY_FILE}")


def _get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}", timeout=15) as response:
        return json.load(response)


def _post(path: str, body: dict) -> dict:
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def main() -> int:
    catalog = _get("/api/v1/catalogs/model-providers")["data"]
    openai = next(p for p in catalog if p["type"] == "openai")
    model = next(m for m in openai["models"] if m["model_id"] == MODEL_ID)
    _post(
        "/api/v1/settings/model-providers",
        {"manifest": {"type": "openai", "auth": {"api_key": _key()}, "models": [model]}},
    )
    for entry in _get("/api/v1/models")["data"]:
        print(entry.get("name"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
