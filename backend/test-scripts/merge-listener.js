const io = require('socket.io-client');
const fetch = global.fetch || require('node-fetch');

const SOURCE = process.argv[2];
const TARGET = process.argv[3];
const TOKEN = process.argv[4];
if (!SOURCE || !TARGET || !TOKEN) {
  console.error('Usage: node merge-listener.js <sourceSessionId> <targetSessionId> <adminToken>');
  process.exit(1);
}

function makeSocket(name) {
  const s = io('http://localhost:3000', { transports: ['websocket'] });
  s.on('connect', () => {
    console.log(`${name} connected`, s.id);
    s.emit('cart:join', { sessionId: SOURCE });
  });
  s.on('cart:synced', (c) => console.log(`${name} cart:synced`, JSON.stringify(c)));
  s.on('session:moved', (p) => console.log(`${name} session:moved`, JSON.stringify(p)));
  s.on('session:merged_or_moved', (p) => console.log(`${name} session:merged_or_moved`, JSON.stringify(p)));
  s.on('cart:error', (e) => console.error(`${name} cart:error`, e));
  return s;
}

(async () => {
  const a = makeSocket('clientA');
  const b = makeSocket('clientB');

  // wait a moment for sockets to join
  await new Promise((r) => setTimeout(r, 500));

  // call merge API
  console.log('Calling merge API', SOURCE, '->', TARGET);
  const res = await fetch('http://localhost:3000/sessions/merge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ sourceSessionId: SOURCE, targetSessionId: TARGET }),
  });
  const json = await res.json();
  console.log('merge response', json);

  // wait for events
  await new Promise((r) => setTimeout(r, 3000));

  a.close(); b.close();
  process.exit(0);
})();
