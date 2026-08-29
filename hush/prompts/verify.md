# N8 verify

Use fresh read-only observations to summarize recovery. Check the relevant BMC
state, Kubernetes node state, and active incident alerts. Report disagreement
with the deterministic probe result explicitly; never override it or infer
recovery from a prior action result.

Probe result and incident:
{{context}}

Respond with a single fenced JSON block matching:
{{schema}}
