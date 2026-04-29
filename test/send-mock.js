const fs = require('fs');
const path = require('path');

const token = process.env.WEBHOOK_TOKEN || '';
const url = `http://localhost:${process.env.PORT || 3000}/webhook/bolna/${token}`;
const payload = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'mock-payload.json'), 'utf8'),
);

fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
}).then(async (res) => {
  console.log(`POST ${url} -> ${res.status}`);
  console.log(await res.text());
  process.exit(res.ok ? 0 : 1);
});
