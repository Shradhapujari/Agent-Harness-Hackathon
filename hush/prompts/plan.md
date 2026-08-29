# N3 plan

Propose a ranked remediation plan grounded in the supplied evidence. Start with
the least disruptive useful action. Include at least one evidence id per action.
Do not retry any denied tool/arguments pair. Propose only tools named in the
provided registry; the controller independently assigns action kind and
idempotency keys.

Incident and evidence:
{{context}}

Respond with a single fenced JSON block matching:
{{schema}}
