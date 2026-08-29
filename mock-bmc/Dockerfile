# mock-bmc: the simulated 12-node fleet, served over Redfish + /chaos on 8100.
FROM python:3.12-slim

# uv, pinned — same installer the workspace uses on the host.
COPY --from=ghcr.io/astral-sh/uv:0.12.7 /uv /usr/local/bin/uv

WORKDIR /srv

COPY pyproject.toml ./
COPY app ./app

RUN uv pip install --system --no-cache .

# The simulation is in-memory only; nothing to persist, so run unprivileged.
RUN useradd --create-home --uid 10001 bmc
USER bmc

EXPOSE 8100
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8100"]
