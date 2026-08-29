# Agent-Harness-Hackathon

## Register the Hush operator

Start TrueForge at `http://localhost:8790`. In **Settings > Skills**, choose
**Import from GitHub** and import this public repository with the path
`skills/hush-triage`. This one-time UI step is intentionally not automated
because it uses an OAuth flow.

With the five local MCP servers running, register or update their connectors
and the `hush-operator` agent:

```sh
cd hush
npm install
npm run register
```

Set `TRUEFORGE_BASE_URL` to use a different TrueForge URL and `HUSH_MODEL` to
override the default model. The registration command is idempotent and safe to
run again after changing the agent manifest or system prompt.
