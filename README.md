# Bolna to Slack alerts

When a Bolna voice agent finishes a call, this service posts a summary
to a Slack channel: the execution `id`, the `agent_id`, how long the
call ran, and the transcript. It's a single Express endpoint sitting
between Bolna's outbound webhook and a Slack incoming-webhook URL.

## How it actually works

Bolna POSTs the full execution payload to whatever URL you configure
on the agent, and it does so on every status transition during the
call: `queued`, `in-progress`, `completed`, and so on. We only care
about the moment the call ends, so the handler ignores everything
that isn't a terminal status (`completed`, `call-disconnected`,
`busy`, `no-answer`, `failed`, `error`, `canceled`).

When a terminal event lands, we ACK Bolna with `200` immediately so
their webhook timeout never bites us, and then post to Slack in the
background. The Slack message is a Block Kit payload with a header,
a 2x2 grid of fields (id, agent, duration, status), and a code block
for the transcript.

Duration's a small puzzle. Bolna's normal calls populate
`conversation_time` (in seconds), but browser/demo calls sometimes
ship without it. The fallback chain is `conversation_time` →
`telephony_data.duration` → `(updated_at - created_at)`. It's caught
every payload I've thrown at it so far.

## Running locally

```
npm install
cp .env.example .env
```

Edit `.env` and set:

- `SLACK_WEBHOOK_URL` — create one at https://api.slack.com/apps
  (Incoming Webhooks → add to workspace → copy the URL).
- `WEBHOOK_TOKEN` — anything long and random. The webhook URL becomes
  `/webhook/bolna/<token>`; without a matching token requests get
  rejected with `401`. Without setting `WEBHOOK_TOKEN` at all the
  endpoint is open, which is fine for local dev but obviously not
  what you want in production.
- `BOLNA_WEBHOOK_IPS` — optional, comma-separated. Bolna's
  [webhook docs](https://www.bolna.ai/docs/polling-call-status-webhooks)
  say all webhooks come from `13.203.39.153`. Set this in production
  and any request from another IP gets a `403`. Leave it unset for
  local dev so the smoke test on `127.0.0.1` still works. The list
  format means Bolna can add an IP and we update the env var without
  redeploying.
- `DEDUP_FILE` — optional path. If set, the dedup state survives
  process restarts.
- `TRANSCRIPT_LIMIT` — optional, defaults to `2800`.
- `PORT` — defaults to `3000`.

Then:

```
npm start
```

You should see `live at http://localhost:3000/webhook/bolna` in the
console.

## Smoke tests

```
npm test            # 6 tests against a stub Slack server, no network
npm run test:local  # POSTs test/mock-payload.json to a running instance
```

`npm run test:local` is the one-liner I used after every change. It
hits the local server and forwards through to the real Slack URL in
your `.env`, so a "Bolna call ended" message should land in your
channel within a second or two.

If you'd rather curl it yourself:

```
curl -X POST http://localhost:3000/webhook/bolna/$WEBHOOK_TOKEN \
  -H 'content-type: application/json' \
  -d @test/mock-payload.json
```

## Pointing Bolna at it

Inside the Bolna dashboard, open your agent, go to the Analytics tab,
and you'll see a section called "Push all execution data to webhook".
Paste your public URL there (path-token included) and save the agent.
For a quick demo without a real deployment, `ngrok http 3000` and use
the ngrok URL.

## Deploying it

Anywhere that runs Node 20 works: Render, Fly, Railway, Vercel, an EC2
box. Set the same env vars in the platform's dashboard, deploy from
this repo, and update the agent's webhook URL in Bolna to match. The
GitHub Actions workflow at `.github/workflows/test.yml` runs the test
suite on every push, which is enough CI hygiene for a service this
size.

## What it looks like in Slack

![Slack alert](docs/slack-screenshot.png)

## Auth, retries, dedup, the boring stuff

A few things were worth thinking through.

Webhook authentication. Bolna does not sign webhooks (verified
against their docs at
[/docs/polling-call-status-webhooks](https://www.bolna.ai/docs/polling-call-status-webhooks)).
Their published recommendation is IP whitelisting from
`13.203.39.153`. This service implements IP-based source
verification using `X-Forwarded-For` (with Express's `trust proxy`
enabled) since deployments behind a reverse proxy don't preserve
the original client IP on `req.socket.remoteAddress`. Allowed IPs
are read from `BOLNA_WEBHOOK_IPS` so we can add IPs without
redeploying. As a second layer, the webhook URL itself carries a
path token (`WEBHOOK_TOKEN`); requests without it get a `401`.

Limitations:

- IP rotation by Bolna will silently drop webhooks until the env
  var is updated. Mitigation: monitor the `403` rate from this
  endpoint.
- IP-based auth is weaker than HMAC. If Bolna adds signing later,
  swap the token check for a signature verifier — the call site
  in `server.js` is one line.

Idempotency. Because the webhook fires on every status change, a
single call can ship two terminal events back-to-back — for example a
`call-disconnected` immediately followed by `completed`. Without
dedup, that's two Slack messages for one call. The handler keeps a
`Map<id, timestamp>` with a 1-hour TTL and quietly drops repeats.
The TTL is swept on access so the map can't grow without bound. If
`DEDUP_FILE` is set, the map gets serialized to JSON (debounced) so
restarts don't replay alerts. The obvious caveat: this is still
single-process. Multi-replica deployments need to move dedup to
Redis or a small DB table.

Slack delivery. The handler ACKs Bolna with `200` before it touches
Slack, and the post happens in the background. Slack returns `429`
under load and `5xx` occasionally; `postToSlack` retries up to twice
with linear backoff and honours `Retry-After` on rate limits. After
that it gives up and logs `slack_fail` with the status and body. For
an alerting service that's fine — losing a single notification is
annoying but recoverable. If you needed stricter delivery you'd push
the message onto a queue and have a worker drain it.

Graceful shutdown. On `SIGTERM` or `SIGINT` the server stops
accepting new connections and waits up to 5 seconds for in-flight
Slack posts to finish before exiting. Without that, a deploy mid-post
silently drops the alert.

Transcripts. Slack's `section` block caps at roughly 3000 characters.
Transcripts longer than that get truncated with a tail line noting
the full length and pointing back at Bolna's `GET /executions/{id}`
so a curious reader can pull the complete record. The cap itself is
configurable via `TRANSCRIPT_LIMIT`.

## Logs

Every log line is a single line of JSON, ready for any log aggregator:

```
{"t":"2026-04-29T10:15:58.355Z","event":"listening","port":3000}
{"t":"2026-04-29T10:16:02.110Z","event":"slack_ok","id":"4c06b...","ms":182}
{"t":"2026-04-29T10:16:09.901Z","event":"dedup","id":"4c06b..."}
```

Events you'll see: `listening`, `ignored` (non-terminal status),
`dedup`, `slack_ok` with latency, `slack_fail` with the error,
`shutdown` and `shutdown_done` around process exit.

## Files

- `server.js` — the whole service, around 180 lines.
- `test/server.test.js` — six tests using `node:test`, with a stub
  Slack server.
- `test/mock-payload.json` — a representative `completed` execution.
- `test/send-mock.js` — small helper that POSTs the mock through a
  running server.

Node 20 or later, because the code uses `--env-file=.env` and the
global `fetch`.
