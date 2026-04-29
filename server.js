const express = require('express');

const app = express();
app.use(express.json());

const SLACK_URL = process.env.SLACK_WEBHOOK_URL;
const PORT = Number(process.env.PORT) || 3000;

app.post('/webhook/bolna', async (req, res) => {
  const p = req.body || {};
  const text =
    `Bolna call ended\n` +
    `id: ${p.id}\n` +
    `agent: ${p.agent_id}\n` +
    `duration: ${p.conversation_time ?? '?'}s\n` +
    `transcript:\n${p.transcript || ''}`;

  await fetch(SLACK_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`live on :${PORT}`));
