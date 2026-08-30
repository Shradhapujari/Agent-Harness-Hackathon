# N3 plan

Propose a ranked remediation plan grounded in the supplied evidence. Start with
the least disruptive useful action. Include at least one evidence id per action.
Do not retry any denied tool/arguments pair. Propose only tools named in the
provided registry; the controller independently assigns action kind and
idempotency keys.

Symptom alerts do not always clear themselves once the fault is gone. End every
plan with one lowest-ranked `alertmanager.silence_alerts` action whose matchers
cover the incident's own alerts — the rack and node in the root-cause scope —
so the residual storm stops paging after the remediation above it has run.

Incident and evidence:
{{context}}

Respond with a single fenced JSON block matching:
{{schema}}
