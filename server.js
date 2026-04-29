const express = require('express');
const fs = require('fs');

const app = express();
app.use(express.json({ limit: '2mb' }));

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.WEBHOOK_TOKEN;
const IP_ALLOWLIST = (process.env.BOLNA_IP_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DEDUP_FILE = process.env.DEDUP_FILE || '';
const DEDUP_TTL_MS = 60 * 60 * 1000;
const TRANSCRIPT_LIMIT = Number(process.env.TRANSCRIPT_LIMIT) || 2800;

const seen = loadDedup();
function loadDedup() {
  if (!DEDUP_FILE) return new Map();
  try {
    return new Map(JSON.parse(fs.readFileSync(DEDUP_FILE, 'utf8')));
  } catch {
    return new Map();
  }
}

let dedupWriteTimer = null;
function persistDedup() {
  if (!DEDUP_FILE) return;
  clearTimeout(dedupWriteTimer);
  dedupWriteTimer = setTimeout(() => {
    fs.writeFile(DEDUP_FILE, JSON.stringify([...seen]), () => {});
  }, 100);
}

function alreadyHandled(id) {
  const now = Date.now();
  for (const [k, t] of seen) if (now - t > DEDUP_TTL_MS) seen.delete(k);
  if (seen.has(id)) return true;
  seen.set(id, now);
  persistDedup();
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
  if (IP_ALLOWLIST.length) {
    const ip = clientIp(req);
    if (!IP_ALLOWLIST.includes(ip)) {
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

const server = app.listen(PORT, () => {
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
