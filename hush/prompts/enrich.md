# N2 enrich

Enrich this incident by starting three subagents in parallel: one restricted to
Redfish, one to NetBox, and one to Kubernetes plus Prometheus. Each subagent may
make at most eight calls and must return concise findings with raw references.
Wait for all three. Merge their results without inventing missing data. Mark
seeded NetBox results as `fallback`.

Redfish: collect power, hung flag, inlet and CPU temperatures, PSU health, and
the last five SEL entries for scoped nodes. NetBox: collect rack, site, tenant,
role, and affected-tenant count. Kubernetes plus Prometheus: collect Ready
conditions, scoped-node pods, and ten minutes of inlet-temperature history.
Each subagent returns layer, a <=300 character summary, findings, and raw_refs.

Incident:
{{incident}}

Respond with a single fenced JSON block matching:
{{schema}}
