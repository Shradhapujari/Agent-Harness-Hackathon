# mock-bmc — a fake server management chip, for demos

A small Python web service that pretends to be the **management chips of 12
data-center servers**. It speaks **Redfish** (the industry-standard REST API for
server hardware), keeps a **live simulation** running (heat, fans, power), and
has a **chaos dial** to break things on purpose.

Built for the DC-Sentinel hackathon project: our agent needs a "data center"
to watch over, diagnose, and fix — and real servers were not invited.

## 1. What is a BMC?

**BMC = Baseboard Management Controller.**

- A tiny computer **soldered onto the motherboard** of almost every real server.
- It runs its **own small operating system**, separate from the main OS.
- It watches the hardware: **temperatures, fans, power supplies, voltage**.
- It can **control power**: turn the server on, off, or restart it.
- It keeps a **hardware diary** called the **SEL** (System Event Log):
  "fan failed", "CPU got too hot", "power supply lost power", etc.
- Its superpower: it works **even when the main server is dead or hung**.
  That is why data-center operators love it — the BMC always answers.

### Where it sits inside a server

```
        ONE PHYSICAL SERVER
┌─────────────────────────────────────────┐
│  Main OS (Linux/Windows)                │
│  ├── apps, databases, k8s pods          │
│  └── can hang, crash, get infected      │
│                                         │
│  BMC  ◄── separate tiny computer        │
│  ├── own CPU, own RAM, own Linux        │
│  ├── reads sensors (temp, fan, watts)   │
│  ├── controls the power button          │
│  └── NEVER depends on the main OS       │
└────────────┬────────────────────────────┘
             │ network cable (out-of-band)
             ▼
     Data-center operator / automation
     (this is where our agent connects)
```

Two ways to talk to a server:

| Path | Name | Works when server is hung? |
|---|---|---|
| SSH / k8s API (through the OS) | **in-band** | No — OS is dead |
| BMC over the network | **out-of-band** | **Yes** — BMC always alive |

That difference is the whole point of our demo: when a node stops answering
k8s, the agent asks the BMC "is it off, or is it hung?" — only the BMC knows.

## 2. What is Redfish?

- **Redfish** is the modern REST/JSON standard (from DMTF) for talking to BMCs.
- Think "REST API for hardware": `GET /redfish/v1/Systems/R4-N04` returns JSON
  with power state, health, model, serial number.
- It replaced the older, messier standard called IPMI.
- Every real vendor (Dell iDRAC, HPE iLO, Lenovo XCC) speaks Redfish.
- So anything our agent learns on the mock BMC **also works on real hardware**.
## 3. Why a *mock* BMC? (decision D2)

The free option, DMTF's **Redfish-Mockup-Server**, is just a folder of static
JSON files:

- temperatures **never move** — always the same number
- power-cycle **does nothing**
- no log entries, no failures — useless for a live demo

Our mock instead runs a **live simulation**:

- fake CPU load heats the chip, fans speed up, power draw follows
- we can **inject faults** with one HTTP call (thermal spike, PSU failure...)
- every fault writes a realistic **SEL** entry
- the drama is **deterministic and repeatable** — perfect for judges

## 4. What's in the package

```
mock-bmc/
├── app/
│   ├── __init__.py      (empty, makes "app" a Python package)
│   ├── state.py         THE SIMULATION  — physics + fleet + fault logic
│   ├── redfish.py       THE STANDARD API — Redfish endpoints (read + reset)
│   ├── chaos.py         THE FAULT DIAL  — endpoints to break things
│   └── main.py          GLUE — FastAPI app, background tick every 1s
├── tests/
│   ├── test_state.py    12 tests — physics, trips, SEL, chaos expiry
│   ├── test_redfish.py  14 tests — endpoints, auth, reset flow
│   └── test_chaos.py    10 tests — chaos endpoints + validation
├── pyproject.toml       project metadata + test config
└── README.md            this file
```

### The 12 fake servers

One fleet, 12 nodes, all in rack **R4**:

```
R4-N01  R4-N02  R4-N03  R4-N04  R4-N05  R4-N06
R4-N07  R4-N08  R4-N09  R4-N10  R4-N11  R4-N12
```

Each node is a `Machine` object with its own:

- power state (`On` / `Off`), hung flag, CPU load %
- CPU temperature, inlet (air intake) temperature
- fan speed %, power draw in watts
- two PSUs (each can fail independently)
- thermal-trip flag, SEL event history

### Each file, in one breath

| File | Job | Key thing it exports |
|---|---|---|
| `state.py` | The fake physics + all state changes | `Fleet`, `Machine`, `PowerState`, `Health` |
| `redfish.py` | Standard Redfish REST endpoints | `build_router(fleet)` |
| `chaos.py` | "Break my data center" endpoints | `build_chaos_router(fleet)` |
| `main.py` | Wires everything, ticks the clock | `create_app(...)` |

### Layer picture

```
   chaos.py (break things)      redfish.py (standard view)
          │                            │
          ▼                            ▼
        ┌──────────── state.py ────────────┐
        │  Fleet: 12 Machines + physics    │
        │  tick() every second moves all   │
        │  temps/fans/watts toward targets │
        └──────────────────────────────────┘
```
## 5. The state loop — how fake heat works

Every second, `Fleet.tick()` moves every machine toward its **target** values.
Nothing jumps — things *drift*, like real hardware.

```
            every 1 second (Fleet.tick)
  ┌───────────────────────────────────────────────┐
  │                                               │
  │   CPU LOAD ──► target CPU temp                │
  │      target = 35                              │
  │            + 0.5 × load %                     │
  │            + 0.6 × inlet temp                 │
  │            + chaos offset                     │
  │                                               │
  │   CPU TEMP ──► target FAN speed               │
  │      fan% = 15 + 3 × (temp − 40)              │
  │      clamped to 15..100                       │
  │                                               │
  │   LOAD + TEMP + FAN ──► POWER draw            │
  │      watts = 90 + 1.8×load + 1.2×(temp−30)    │
  │             + 0.5×fan                         │
  │                                               │
  │   temps drift with exp decay (tau ≈ 8 s)      │
  └───────────────────────────────────────────────┘
```

### What a healthy node looks like

- idle (load ~10%): CPU ≈ **42–48 °C**, fan ≈ **20%**, ≈ **160–190 W**
- busy (load ~90%): CPU ≈ **80 °C**, fan ≈ **100%**, ≈ **300+ W**

### Safety rails built into the loop

| Rule | Trigger | Effect |
|---|---|---|
| **Thermal trip** | CPU temp ≥ **97 °C** | power → `Off`, SEL `Critical` entry |
| **Total PSU loss** | PSU 1 **and** 2 both failed | power → `Off`, SEL `Warning` entry |
| **Cooling when off** | power = `Off` | temp drifts down to inlet, fan → 0, **8 W standby** |
| **Chaos expiry** | timer runs out | thermal offset resets to 0 |
| **Hung ≠ dead** | host hung | load stops drifting, but BMC keeps measuring |

### The hung-host idea (demo gold)

```
k8s says:  node R4-N04  NOT READY  ✗
SSH says:  no answer             ✗
           │
           ▼
   agent asks the BMC (Redfish):
   ├─ power = "On"  + temps normal + Hung flag = true
   │        → OS is HUNG → fix = power-cycle (needs human approval!)
   └─ power = "Off" + cool
            → server is just OFF → fix = simply power it on
```

Only the BMC can answer "hung vs off" — this is why the project needs one.
## 6. Faults it can fake (the chaos dial)

All faults are set with one `POST` to `/chaos/...` and are **undo-able**.

| Fault | Endpoint | What happens | SEL entry |
|---|---|---|---|
| **Thermal spike** | `POST /chaos/thermal-spike` | fake heat added to one node's CPU target, for N seconds | `Chaos` / Warning |
| **PSU failure** | `POST /chaos/psu-fail` | one PSU dies → node runs on the other, health goes `Critical` | `PSUFault` / Warning |
| **PSU restore** | `POST /chaos/psu-restore` | PSU comes back | `PSUFault` / OK |
| **Host hang** | `POST /chaos/hang` | OS freezes; BMC still alive and reporting | `HostHang` / Critical |
| **Un-hang** | `POST /chaos/unhang` | OS responsive again | — |
| **Manual SEL note** | `POST /chaos/sel` | write any custom event into the log | your text |
| **CRAC failure** | `POST /chaos/crac-failure` | facility cooling dies → **every** node's inlet air warms up | `Chaos` on all nodes |
| **CRAC restore** | `POST /chaos/crac-restore` | cooling back to normal | — |
| **Clear all** | `POST /chaos/clear` | undo every chaos effect (keeps SEL history) | — |

### Demo scenario A — CRAC failure cascade (the "40 alarms" story)

```
POST /chaos/crac-failure  {"delta_c": 14}
        │
        ▼
 inlet air: 22 °C ──► 36 °C  (all 12 nodes)
        │
        ▼
 CPU temps creep up ──► fans scream ──► watts climb
        │
        ▼
 hottest node(s) hit 97 °C ──► THERMAL TRIP ──► power off
        │
        ▼
 Prometheus/k8s/SEL all fire ──► alarm flood ──► our agent
 correlates it down to ONE root cause: "R4 cooling failed"
```

### Demo scenario B — hung node (the approval-gate story)

```
POST /chaos/hang  {"system": "R4-N04"}
        │
        ▼
 k8s: node NotReady · pods stuck · alerts fire
        │
        ▼
 agent enriches via Redfish:
   power = On, temps OK, Hung = true  →  "it's hung, not off"
        │
        ▼
 agent PROPOSES: power-cycle R4-N04
        │
        ▼
 👤 human approves (destructive action = approval gate)
        │
        ▼
 POST /redfish/v1/Systems/R4-N04/Actions/ComputerSystem.Reset
 {"ResetType": "ForceRestart"}
        │
        ▼
 agent verifies: node back On, k8s Ready ✓
```

Every fault also lands in the **SEL**, so the agent has a hardware-side
evidence trail, not just metrics.
## 7. API reference

Base URL when running locally: `http://127.0.0.1:8100`

**Auth:** every `/redfish/...` call needs HTTP Basic auth — user `root`,
password `password0` (override with env vars `MOCK_BMC_USER` /
`MOCK_BMC_PASSWORD`). The `/chaos/...` dial has **no auth** (local demo tool).

### Redfish endpoints (the standard, read + reset)

| Method | Path | Returns |
|---|---|---|
| GET | `/redfish/v1` | service root, links to everything |
| GET | `/redfish/v1/Systems` | list of the 12 nodes |
| GET | `/redfish/v1/Systems/{id}` | power state, health, model, `Oem.DCSentinel.Hung` |
| POST | `/redfish/v1/Systems/{id}/Actions/ComputerSystem.Reset` | power action (see reset types) |
| GET | `/redfish/v1/Chassis` | list of chassis |
| GET | `/redfish/v1/Chassis/{id}` | one chassis + links to thermal/power |
| GET | `/redfish/v1/Chassis/{id}/Thermal` | **temps** (inlet, CPU) + **fan** RPM |
| GET | `/redfish/v1/Chassis/{id}/Power` | watts drawn + 2 PSUs with health |
| GET | `/redfish/v1/Systems/{id}/LogServices/SEL` | about the event log |
| GET | `/redfish/v1/Systems/{id}/LogServices/SEL/Entries` | the event log itself |
| GET | `/redfish/v1/Systems/{id}/LogServices/SEL/Entries/{entry_id}` | one event |

**Reset types** accepted by the power action:

| ResetType | Meaning | Destructive? |
|---|---|---|
| `On` | power on | no |
| `ForceOff` | cut power now | **yes** |
| `GracefulShutdown` | ask OS, then off | **yes** |
| `ForceRestart` | hard reboot | **yes** |
| `GracefulRestart` | clean reboot | **yes** |
| `Nmi` | debug interrupt | mild |

Every reset writes a `PowerStateChange` entry into the SEL. A restart clears
the hung flag and a thermal trip (fresh boot). Our agent harness treats all
`yes` rows as **approval-gated** — the BMC itself allows them, the *agent*
must ask a human first.

### Chaos endpoints (the demo remote control)

| Method | Path | Body (JSON) |
|---|---|---|
| POST | `/chaos/thermal-spike` | `{"system": "R4-N04", "delta_c": 30, "duration_s": 90}` |
| POST | `/chaos/psu-fail` | `{"system": "R4-N04", "psu": 1}` |
| POST | `/chaos/psu-restore` | `{"system": "R4-N04", "psu": 1}` |
| POST | `/chaos/hang` | `{"system": "R4-N04"}` |
| POST | `/chaos/unhang` | `{"system": "R4-N04"}` |
| POST | `/chaos/sel` | `{"system": "R4-N04", "severity": "Warning", "message": "..."}` |
| POST | `/chaos/crac-failure` | `{"delta_c": 14}` |
| POST | `/chaos/crac-restore` | — |
| POST | `/chaos/clear` | — |
| GET | `/chaos/status` | fleet snapshot: every node's temps, power, hung, health |

Errors: unknown node → `404`, bad PSU number / bad severity → `400`.

## 8. How to run

From the repo root:

```powershell
# install once
python -m venv .venv
.venv\Scripts\python.exe -m pip install fastapi "uvicorn[standard]" httpx pytest

# start the mock (serves 12 nodes on port 8100)
cd mock-bmc
..\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8100

# run the tests (36 of them)
cd mock-bmc
..\.venv\Scripts\python.exe -m pytest -q
```

Try it:

```powershell
# read one server
curl.exe -u root:password0 http://127.0.0.1:8100/redfish/v1/Systems/R4-N04

# break one server
curl.exe -X POST http://127.0.0.1:8100/chaos/hang -H "Content-Type: application/json" -d "{\"system\":\"R4-N04\"}"

# watch everything
curl.exe http://127.0.0.1:8100/chaos/status
```
## 9. Data-center glossary (plain English)

| Term | What it means |
|---|---|
| **BMC** | Tiny management computer on a server board. Reads sensors, controls power, works even when the main server is dead. |
| **Redfish** | The standard REST/JSON API for talking to BMCs. `GET` gives you sensor data, `POST` a Reset action changes power state. |
| **Out-of-band** | Reaching a server through its BMC network, not through the OS. Works when the OS is hung. |
| **SEL** | System Event Log — the BMC's diary of hardware events (fan failed, too hot, PSU lost power). |
| **CRAC** | Computer Room Air Conditioner — the big cooling units of a data-center room. If CRAC dies, inlet air warms up. |
| **Inlet temp** | Temperature of the air going *into* the server. Set by the room cooling, not the server itself. |
| **PSU** | Power Supply Unit. Servers have two (PSU1/PSU2) so one can fail without downtime. |
| **Thermal trip** | Emergency self-shutdown when a chip gets too hot (we use 97 °C). |
| **Hung** | OS frozen but powered: no answer to ping/SSH, yet fans still spin and BMC still talks. |
| **Power-cycle** | Turn off, wait, turn on. Classic fix for a hung machine. Destructive — needs approval. |
| **NMI** | Non-Maskable Interrupt — a "panic button" signal for low-level debugging. |
| **Outlet / PDU** | Where a rack gets power; PDUs feed the PSUs. (Not simulated — PSUs are.) |
| **Rack** | The metal cabinet holding servers. Ours is rack **R4** with 12 nodes. |
| **Blast radius** | How much stuff one failure takes down. One CRAC = whole rack; one PSU = one node. |
| **Alarm storm** | One root cause fires dozens of alarms across tools — the pain our agent exists to fix. |
| **Root cause** | The single real failure under the pile of alarms. |
| **k8s / Kubernetes** | Container orchestrator. It "drains" a node before taking it down. |
| **Node (k8s)** | A server that runs containers. If it hangs, its pods get rescheduled elsewhere. |
| **IPMI** | The old, clunky predecessor of Redfish. |
| **DMTF** | The industry group that owns the Redfish standard. |
| **Mockup / emulator** | Fake service used instead of real hardware. Ours adds moving state + chaos. |

## 10. Tuning constants (in `state.py`)

Want faster drama for a live demo? Change these:

| Constant | Default | Meaning |
|---|---|---|
| CPU temp tau | 8 s | how fast CPU temp approaches its target (lower = faster) |
| Fan curve | `15 + 3×(t−40)` | fan % from CPU temp, clamped 15–100 |
| Power model | `90 + 1.8×load + 1.2×(t−30) + 0.5×fan` | watts |
| Thermal trip | **97 °C** | emergency power-off + `Critical` SEL |
| Warning temp | 80 °C | sensor health flips to `Warning` |
| Critical temp | 90 °C | node health flips to `Critical` |
| Standby watts | 8 W | draw when powered off |
| PSU loss | both fail → off | one PSU failing = survive, two = down |
| Fleet | 12 nodes, rack R4 | `create_app()` default |
| Tick | 1 s | background loop in `main.py` |

## 11. What this does NOT do (honest limits)

- No real thermal physics — a believable linear model, not CFD.
- No network/traffic simulation, no disk or DIMM sensors.
- No storage of state across restarts (in-memory only — restart = fresh fleet).
- Redfish subset only: the endpoints above, not the whole 400-page standard.
- Chaos endpoints are unauthenticated — never expose this service publicly.

---

*Part of DC-Sentinel · decision D2 (custom mock over static DMTF mockup) ·
pre-built before event day per the build order in `hackathon-brief.html`.*
