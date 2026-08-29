"""HTTP clients for the two services a scenario drives: the BMC and Alertmanager."""
from __future__ import annotations

import os
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx


def env(name: str, default: str) -> str:
    return os.getenv(name, default)


class BmcClient:
    """The mock BMC's chaos and Redfish endpoints."""

    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = base_url or env("HUSH_BMC_URL", "http://127.0.0.1:8100")
        self.auth = (env("MOCK_BMC_USER", "root"), env("MOCK_BMC_PASSWORD", "password0"))

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, auth=self.auth, timeout=10.0)

    def post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        with self._client() as http:
            response = http.post(path, json=body)
            response.raise_for_status()
            payload: dict[str, Any] = response.json()
        return payload

    def status(self) -> dict[str, Any]:
        with self._client() as http:
            response = http.get("/chaos/status")
            response.raise_for_status()
            payload: dict[str, Any] = response.json()
        return payload

    def reset(self, system_id: str, reset_type: str) -> None:
        self.post(f"/redfish/v1/Systems/{system_id}/Actions/ComputerSystem.Reset", {"ResetType": reset_type})


class AmClient:
    """Alertmanager's v2 alert API."""

    def __init__(self, base_url: str | None = None) -> None:
        self.base_url = base_url or env("HUSH_ALERTMANAGER_URL", "http://127.0.0.1:9093")

    def _client(self) -> httpx.Client:
        return httpx.Client(base_url=self.base_url, timeout=10.0)

    def post_alerts(self, alerts: list[dict[str, Any]]) -> None:
        if not alerts:
            return
        with self._client() as http:
            response = http.post("/api/v2/alerts", json=alerts)
            response.raise_for_status()

    def silence(self, matchers: list[str], duration_s: int, comment: str) -> str:
        """Silence every alert matching `matchers`; returns the silence id."""
        now = datetime.now(UTC)
        body = {
            "matchers": [
                {"name": name, "value": value, "isRegex": False, "isEqual": True}
                for name, _, value in (m.partition("=") for m in matchers)
            ],
            "startsAt": now.isoformat(),
            "endsAt": (now + timedelta(seconds=duration_s)).isoformat(),
            "createdBy": "hush-chaos",
            "comment": comment,
        }
        with self._client() as http:
            response = http.post("/api/v2/silences", json=body)
            response.raise_for_status()
            silence_id: str = response.json().get("silenceID", "")
        return silence_id

    def expire_silences(self, created_by: str) -> list[str]:
        """End every active silence this CLI created; returns the ids it ended.

        A `clear` silence would otherwise swallow the next scenario: alerts
        posted a minute later match it immediately and never show as firing.
        """
        with self._client() as http:
            response = http.get("/api/v2/silences")
            response.raise_for_status()
            silences = response.json()
            ended = []
            for silence in silences:
                state = (silence.get("status") or {}).get("state")
                if silence.get("createdBy") != created_by or state == "expired":
                    continue
                deleted = http.delete(f"/api/v2/silence/{silence['id']}")
                deleted.raise_for_status()
                ended.append(str(silence["id"]))
        return ended

    def list_alerts(self, filters: list[str] | None = None, silenced: bool = True) -> list[dict[str, Any]]:
        params: list[tuple[str, str | int | float | bool | None]] = [
            ("active", True),
            ("silenced", silenced),
            ("inhibited", True),
        ]
        params += [("filter", f) for f in (filters or [])]
        with self._client() as http:
            response = http.get("/api/v2/alerts", params=params)
            response.raise_for_status()
            payload: list[dict[str, Any]] = response.json()
        return payload
