const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let slackHits;
let slackServer;

test.before(async () => {
  slackHits = [];
  slackServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      slackHits.push(JSON.parse(body));
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((r) => slackServer.listen(0, r));
  process.env.SLACK_WEBHOOK_URL = `http://localhost:${slackServer.address().port}`;
  process.env.WEBHOOK_TOKEN = 'test-token';
});

test.after(() => slackServer.close());

function makeRequest(pathSuffix, body) {
  const app = require('../server');
  const server = app.listen(0);
  const port = server.address().port;
  return fetch(`http://localhost:${port}${pathSuffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => {
    const json = await res.json();
    server.close();
    return { status: res.status, json };
  });
}

const mock = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'mock-payload.json'), 'utf8'),
);

test('rejects bad token', async () => {
  const { status, json } = await makeRequest('/webhook/bolna/wrong', mock);
  assert.equal(status, 401);
  assert.equal(json.error, 'unauthorized');
});

test('rejects payload missing id', async () => {
  const { status } = await makeRequest('/webhook/bolna/test-token', { agent_id: 'a' });
  assert.equal(status, 400);
});

test('ignores non-terminal status', async () => {
  const { status, json } = await makeRequest('/webhook/bolna/test-token', {
    ...mock,
    id: 'in-flight-1',
    status: 'in-progress',
  });
  assert.equal(status, 200);
  assert.equal(json.ignored, 'in-progress');
});

test('forwards terminal call to Slack', async () => {
  const before = slackHits.length;
  const { status, json } = await makeRequest('/webhook/bolna/test-token', mock);
  assert.equal(status, 200);
  assert.equal(json.ok, true);

  for (let i = 0; i < 20 && slackHits.length === before; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(slackHits.length, before + 1);
  const sent = JSON.stringify(slackHits[before]);
  assert.match(sent, new RegExp(mock.id));
  assert.match(sent, new RegExp(mock.agent_id));
});

test('dedups repeated id', async () => {
  await makeRequest('/webhook/bolna/test-token', { ...mock, id: 'dup-1' });
  const { json } = await makeRequest('/webhook/bolna/test-token', { ...mock, id: 'dup-1' });
  assert.equal(json.duplicate, 'dup-1');
});

test('retries on 429 then succeeds', async () => {
  const before = slackHits.length;

  let calls = 0;
  const realListeners = slackServer.listeners('request').slice();
  slackServer.removeAllListeners('request');
  slackServer.on('request', (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { 'retry-after': '0' });
        return res.end('rate limited');
      }
      slackHits.push(JSON.parse(body));
      res.writeHead(200);
      res.end('ok');
    });
  });

  try {
    await makeRequest('/webhook/bolna/test-token', { ...mock, id: 'retry-1' });
    for (let i = 0; i < 40 && slackHits.length === before; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(calls, 2, 'should have tried twice');
    assert.equal(slackHits.length, before + 1);
  } finally {
    slackServer.removeAllListeners('request');
    realListeners.forEach((l) => slackServer.on('request', l));
  }
});
