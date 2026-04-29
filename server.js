const express = require('express');

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.WEBHOOK_TOKEN;
const ALLOWED_IPS = (process.env.BOLNA_WEBHOOK_IPS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEDUP_TTL_MS = 60 * 60 * 1000;
const TRANSCRIPT_LIMIT = Number(process.env.TRANSCRIPT_LIMIT) || 2800;

const seen = new Map();

function alreadyHandled(id) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > DEDUP_TTL_MS) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

const ENDED = new Set([
  'completed',
  'call-disconnected',
  'busy',
  'no-answer',
  'failed',
  'error',
  'canceled',
]);

function getDuration(p) {
  if (typeof p.conversation_time === 'number') return p.conversation_time;
  if (typeof p.duration === 'number') return p.duration;
  if (p.telephony_data && typeof p.telephony_data.duration === 'number') {
    return p.telephony_data.duration;
  }
  if (p.created_at && p.updated_at) {
    const ms = Date.parse(p.updated_at) - Date.parse(p.created_at);
    if (ms > 0) return ms / 1000;
  }
  return null;
}

function formatDuration(secs) {
  if (secs == null) return 'unknown';
  const t = Math.round(secs);
  return t >= 60 ? `${Math.floor(t / 60)}m ${t % 60}s` : `${t}s`;
}

function trimTranscript(raw) {
  const t = (raw || '').trim();
  if (!t) return '(no transcript)';
  if (t.length <= TRANSCRIPT_LIMIT) return t;
  const cut = t.slice(0, TRANSCRIPT_LIMIT);
  return `${cut}\n... (truncated, full ${t.length} chars - fetch via Bolna GET /executions/{id})`;
}

function buildMessage(p) {
  return {
    text: `Bolna call ended: ${p.id}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Bolna call ended' } },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*ID*\n\`${p.id}\`` },
          { type: 'mrkdwn', text: `*Agent*\n\`${p.agent_id}\`` },
          { type: 'mrkdwn', text: `*Duration*\n${formatDuration(getDuration(p))}` },
          { type: 'mrkdwn', text: `*Status*\n${p.status}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Transcript*\n\`\`\`${trimTranscript(p.transcript)}\`\`\`` },
      },
    ],
  };
}

// Bolna doesn't sign webhooks (no HMAC) at the time of writing; their docs
// at /docs/polling-call-status-webhooks recommend IP whitelisting from
// 13.203.39.153. We trust X-Forwarded-For (express trust proxy is on)
// because behind a reverse proxy req.socket.remoteAddress is the proxy.
// Allowed IPs come from BOLNA_WEBHOOK_IPS so we can add an IP without a
// redeploy. If Bolna adds HMAC later, swap this for signature verification.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postToSlack(message, attempt = 1) {
  const res = await fetch(SLACK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  });
  if (res.ok) return;

  const retriable = res.status === 429 || res.status >= 500;
  if (retriable && attempt < 3) {
    const wait = res.status === 429
      ? Number(res.headers.get('retry-after') || 1) * 1000
      : 500 * attempt;
    await sleep(wait);
    return postToSlack(message, attempt + 1);
  }
  throw new Error(`slack ${res.status}: ${await res.text()}`);
}

function log(event, fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

const inFlight = new Set();

app.post('/webhook/bolna/:token?', (req, res) => {
  if (TOKEN && req.params.token !== TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (ALLOWED_IPS.length) {
    const ip = clientIp(req);
    if (!ALLOWED_IPS.includes(ip)) {
      return res.status(403).json({ error: 'forbidden_ip', ip });
    }
  }

  const p = req.body || {};

  if (!p.id || !p.agent_id) {
    return res.status(400).json({ error: 'missing id or agent_id' });
  }

  if (!ENDED.has(p.status)) {
    log('ignored', { id: p.id, status: p.status });
    return res.json({ ignored: p.status });
  }

  if (alreadyHandled(p.id)) {
    log('dedup', { id: p.id });
    return res.json({ duplicate: p.id });
  }

  res.json({ ok: true, id: p.id });

  const start = Date.now();
  const job = postToSlack(buildMessage(p))
    .then(() => log('slack_ok', { id: p.id, ms: Date.now() - start }))
    .catch((err) => log('slack_fail', { id: p.id, err: err.message }))
    .finally(() => inFlight.delete(job));
  inFlight.add(job);
});

app.get('/', (req, res) => {
  res.json({
    service: 'bolna-webhook-alert',
    routes: ['POST /webhook/bolna/:token', 'GET /health'],
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

if (require.main === module) {
  const server = app.listen(PORT, () => {
    if (!SLACK_URL) console.warn('SLACK_WEBHOOK_URL not set');
    if (!TOKEN) console.warn('WEBHOOK_TOKEN not set, endpoint is open');
    console.log(`live at http://localhost:${PORT}/webhook/bolna`);
    log('listening', { port: PORT });
  });

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      log('shutdown', { sig, in_flight: inFlight.size });
      server.close();
      const drained = Promise.allSettled([...inFlight]).then(() => 'drained');
      const timeout = sleep(5000).then(() => 'timeout');
      log('shutdown_done', { result: await Promise.race([drained, timeout]) });
      process.exit(0);
    });
  }
}

module.exports = app;
