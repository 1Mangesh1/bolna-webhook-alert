const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
const PORT = Number(process.env.PORT) || 3000;

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

app.post('/webhook/bolna', async (req, res) => {
  const p = req.body || {};

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
