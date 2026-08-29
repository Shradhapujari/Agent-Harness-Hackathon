"""`hush-chaos` argument parsing and dispatch — no service is contacted."""
from __future__ import annotations

from typing import Any

import pytest

from hush_chaos import cli, cluster, scenarios


@pytest.fixture(autouse=True)
def stub_scenarios(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []

    def record(name: str) -> Any:
        def fn(bmc: Any, am: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
            calls.append((name, kwargs))
            return {"scenario": name}

        return fn

    for name in ("crac", "hang", "clear", "status"):
        monkeypatch.setattr(scenarios, name, record(name))
    monkeypatch.setattr(cluster, "node_map", lambda: {"hush-worker": "R4-N04"})
    return calls


def test_crac_takes_the_lead_time_from_the_command_line(
    stub_scenarios: list[tuple[str, dict[str, Any]]],
) -> None:
    assert cli.main(["crac", "--lead-s", "0"]) == 0
    assert stub_scenarios == [("crac", {"lead_s": 0.0})]


def test_hang_defaults_to_the_worker_node_and_its_machine(
    stub_scenarios: list[tuple[str, dict[str, Any]]],
) -> None:
    cli.main(["hang"])
    assert stub_scenarios == [("hang", {"k8s_node": "hush-worker", "system": "R4-N04"})]


def test_hang_can_target_another_node(stub_scenarios: list[tuple[str, dict[str, Any]]]) -> None:
    cli.main(["hang", "--node", "hush-worker2", "--system", "R4-N07"])
    assert stub_scenarios == [("hang", {"k8s_node": "hush-worker2", "system": "R4-N07"})]


def test_clear_and_status_take_no_arguments(stub_scenarios: list[tuple[str, dict[str, Any]]]) -> None:
    cli.main(["clear"])
    cli.main(["status"])
    assert [name for name, _ in stub_scenarios] == ["clear", "status"]


def test_a_scenario_that_could_not_run_exits_nonzero(monkeypatch: pytest.MonkeyPatch) -> None:
    def explode(bmc: Any, am: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("could not pause hush-worker")

    monkeypatch.setattr(scenarios, "hang", explode)
    assert cli.main(["hang"]) == 1


def test_a_clear_that_left_a_node_cordoned_exits_nonzero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        scenarios, "clear", lambda bmc, am, nodes: {"scenario": "clear", "failed_nodes": ["hush-worker"]}
    )
    assert cli.main(["clear"]) == 1


def test_a_command_is_required() -> None:
    with pytest.raises(SystemExit) as exit_info:
        cli.main([])
    assert exit_info.value.code == 2


def test_an_unknown_command_is_rejected() -> None:
    with pytest.raises(SystemExit):
        cli.main(["explode"])
