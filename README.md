# fantasy-mcp

An MCP server that reads **FIFA Fantasy** teams (e.g. team `436249`, league `187311`).

## Status: measurement phase (not built yet — on purpose)

FIFA's Fantasy API requires a logged-in session — there is **no public/anonymous
access** (every endpoint returns `403 Invalid credentials`). Login goes through
**PingOne DaVinci** behind **Akamai Bot Manager**, which **blocks datacenter IPs**
(Google Cloud, AWS, etc.). Since the production server is intended for **Cloud Run**
(a datacenter), it cannot perform the interactive email/password login itself.

What *is* reachable from a datacenter: the OAuth token endpoint, the
`auth/sso/login` exchange, and the data API. So the plan is:

1. **One-time bootstrap** from a residential IP (your own computer) → capture a session.
2. Store it as a Cloud Run secret; the server reuses/refreshes it.

But **how long a FIFA session lasts is decided server-side and is not visible in
their code.** Rather than guess, we measure it first.

## Step 1 — mint one session (run on YOUR computer, not a datacenter/VPN)

```bash
npm install
npx playwright install chromium

# credentials for the dedicated FIFA account:
export FIFA_EMAIL='you@example.com'
export FIFA_PASSWORD='...'
export TEAM_ID=436249

npm run bootstrap
```

It logs in with a real browser, verifies it can read the team, writes
`session.json` + `session.b64`, and prints a line starting with `SESSION_B64:`.
**Paste that whole line back into the chat.**

If it prints `Access Restricted | <IP>`, you're on a datacenter/VPN connection —
switch to a normal home/mobile connection and re-run.

## Step 2 — measure session lifetime (runs anywhere, incl. Cloud Run)

```bash
SESSION_B64='<the blob>' npm run measure
```

Run it repeatedly over a few days (cron/Task Scheduler). It appends one line per run
to `measure.log` showing the session age and whether the team is still readable —
telling us exactly when a session dies and whether anything renews it.

Only once we know that do we commit to the Cloud Run architecture and build the MCP
server itself.

## Security

`session.json`, `session.b64`, `.env`, and screenshots are gitignored. A session is a
**live credential to the FIFA account** — never commit it; it belongs in a secret
manager, not in code.
