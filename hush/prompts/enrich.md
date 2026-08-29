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

After joining the subagents, use the sandbox once to create `evidence.png` with
matplotlib from the inlet and CPU temperature series returned by
`prometheus.query_range`. Then render one compact thermal table or chart showing
the scoped nodes, temperatures, and tenant blast radius. This is the second and
final Generative UI display for the incident. If sandbox execution is disabled,
state that honestly and still return the evidence JSON.

Incident:
{{incident}}

Respond with a single fenced JSON block matching:
{{schema}}
