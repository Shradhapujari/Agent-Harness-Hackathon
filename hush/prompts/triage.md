# N1 triage

Correlate the supplied alert storm into one incident. Call
`alertmanager.correlate_alerts` with the supplied alerts; use `list_alerts` only
when labels are missing. Choose the leading cluster and classify its root cause.
Map FacilityAmbientHigh to `crac_failure`, HostHung to `host_hang`,
PsuInputLost to `psu_failure`, and an isolated CpuTempCritical to
`thermal_single`; otherwise use `unknown`.
Put root-cause alerts in `primary`, caused alerts in `symptoms`, and unrelated or
flapping alerts in `noise`. Use fingerprints exactly as supplied.

Alerts:
{{alerts}}

Respond with a single fenced JSON block matching:
{{schema}}
