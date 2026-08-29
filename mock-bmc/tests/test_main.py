"""Application construction validation tests."""
import math

import pytest

from app.main import create_app


@pytest.mark.parametrize("interval", [0.0, -1.0, math.nan, math.inf, -math.inf])
def test_create_app_rejects_invalid_tick_interval(interval: float):
    with pytest.raises(ValueError, match="positive finite"):
        create_app(tick_interval_s=interval)
