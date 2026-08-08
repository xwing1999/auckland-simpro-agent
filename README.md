# Auckland Simpro Agent (standalone)

Same pattern as wellington-ops-agent: a Claude API service, no Retool AI
credits. Covers Simpro Auckland job status only for now.

## Honest limitations vs. Wellington

- **Job status works generically** (`getJobStatus`) using the same
  `companies/{ID}/jobs/` endpoint pattern confirmed for Wellington — this is
  standard Simpro REST structure, so it should carry over, but has not
  actually been tested against Auckland's real instance yet. Treat the
  first real call as the real test.
- **Scheduling gaps is stubbed on purpose** — Wellington's version depends on
  knowing which status codes mean "needs organizing" vs "active" etc.
  Auckland's equivalent mapping isn't confirmed, so rather than guess (and
  risk silently wrong answers), this tool just explains that plainly.
- **Invoices, job P&L, purchase orders** — not implemented, same as
  Wellington was before we found the real endpoints. Same process applies:
  find Auckland's equivalent Retool queries (if any exist) or check
  Simpro's docs for this instance directly.

## Setup

```bash
cp .env.example .env
# fill in ANTHROPIC_API_KEY, a NEW random API_KEY (don't reuse Wellington's),
# and the real SIMPRO_BASE_URL, SIMPRO_BEARER_TOKEN, SIMPRO_COMPANY_ID
# from Auckland's own Simpro instance (Setup > API)
npm install
npm start
```

## Deployment

Same as Wellington — new GitHub repo, new Railway service, generate a
domain, add environment variables. Keep this as a genuinely separate
deployment from Wellington's, not merged into the same service — that's
what keeps the "one agent per data source" architecture real.

## Once real data comes through

Once `getJobStatus` returns real Auckland jobs, look at the actual status
names Simpro returns. If Auckland has an equivalent organizing/scheduling
workflow to Wellington's numbered statuses, we can build a proper
`STATUS_STAGE_MAP` for Auckland the same way, and un-stub
`getSchedulingGaps` with real logic instead of the placeholder message.
