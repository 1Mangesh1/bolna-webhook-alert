const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.WEBHOOK_TOKEN;
const IP_ALLOWLIST = (process.env.BOLNA_IP_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

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
  if (t.length <= 2800) return t;
  return `${t.slice(0, 2800)}\n... (truncated, full ${t.length} chars - fetch via Bolna GET /executions/{id})`;
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

app.post('/webhook/bolna/:token?', async (req, res) => {
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
    return res.json({ ignored: p.status });
  }

  await fetch(SLACK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildMessage(p)),
  });

  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`live on :${PORT}`));
