/**
 * The relay.
 *
 * It carries every byte between phones now, so it gets tested like the
 * infrastructure it is: routing, the awkward WebSocket cases browsers actually
 * produce (fragmented and masked frames), and the limits that stop a public
 * endpoint being someone else's free message bus.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let proc;
let PORT;
let BASE;

/** Start one relay for the whole file, on a port nothing else is using. */
test.before(async () => {
  PORT = 8900 + Math.floor(Math.random() * 400);
  BASE = `ws://127.0.0.1:${PORT}/ws`;
  proc = spawn(process.execPath, [join(ROOT, 'server/relay.mjs'), '--port', String(PORT), '--host', '127.0.0.1'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 8000);
    proc.stdout.on('data', (b) => {
      if (b.toString().includes('listening')) { clearTimeout(timer); resolve(); }
    });
    proc.on('error', reject);
  });
});

test.after(() => { proc?.kill(); });

/** A connected client with a queue, so tests can await the next message. */
async function connect(room, role, id) {
  const ws = new WebSocket(`${BASE}?room=${room}&role=${role}&id=${id}`);
  const queue = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (waiters.length) waiters.shift()(msg);
    else queue.push(msg);
  });
  const closed = new Promise((r) => ws.addEventListener('close', (e) => r(e)));
  // Fail fast rather than hang: a refused handshake closes without ever opening.
  await Promise.race([
    once(ws, 'open'),
    closed.then(() => { throw new Error(`connection to ${room} as ${role}/${id} was refused`); }),
  ]);
  return {
    ws,
    closed,
    send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    next(timeout = 4000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeout);
        waiters.push((m) => { clearTimeout(timer); resolve(m); });
      });
    },
    close: () => ws.close(),
  };
}

test('the health endpoint reports what the relay is doing', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(Number.isFinite(body.rooms));
  assert.ok(Number.isFinite(body.uptimeS));
});

test('a plain HTTP request is told what this endpoint is for', async () => {
  const res = await fetch(`http://127.0.0.1:${PORT}/ws`);
  assert.equal(res.status, 426);
});

test('a host claims a room and is told when a guest arrives', async () => {
  const host = await connect('AAAA', 'host', 'host-1');
  assert.deepEqual(await host.next(), { t: 'joined', room: 'AAAA', role: 'host' });

  const guest = await connect('AAAA', 'guest', 'guest-1');
  const welcome = await guest.next();
  assert.equal(welcome.t, 'joined');
  assert.equal(welcome.hostPresent, true);
  assert.deepEqual(await host.next(), { t: 'peer-join', id: 'guest-1' });

  host.close(); guest.close();
});

test('messages go from a guest to the host, tagged with who sent them', async () => {
  const host = await connect('BBBB', 'host', 'h');
  await host.next();
  const guest = await connect('BBBB', 'guest', 'g1');
  await guest.next();
  await host.next();                              // peer-join

  guest.send('{"t":"hello","from":"the guest"}');
  const relayed = await host.next();
  assert.equal(relayed.t, 'msg');
  assert.equal(relayed.from, 'g1');
  assert.equal(JSON.parse(relayed.d).from, 'the guest');

  host.close(); guest.close();
});

test('the host can address one guest or all of them', async () => {
  const host = await connect('CCCC', 'host', 'h');
  await host.next();
  const a = await connect('CCCC', 'guest', 'a');
  const b = await connect('CCCC', 'guest', 'b');
  await a.next(); await b.next();
  await host.next(); await host.next();           // two peer-joins

  host.send({ t: 'msg', to: 'a', d: 'for-a-only' });
  assert.equal((await a.next()).d, 'for-a-only');

  host.send({ t: 'msg', to: '*', d: 'for-everyone' });
  assert.equal((await a.next()).d, 'for-everyone');
  assert.equal((await b.next()).d, 'for-everyone');

  host.close(); a.close(); b.close();
});

test('a guest never receives another guest\'s traffic', async () => {
  const host = await connect('DDDD', 'host', 'h');
  await host.next();
  const a = await connect('DDDD', 'guest', 'a');
  const b = await connect('DDDD', 'guest', 'b');
  await a.next(); await b.next();
  await host.next(); await host.next();

  a.send('a private thing');
  const seen = await host.next();
  assert.equal(seen.from, 'a');
  // b must hear nothing at all.
  await assert.rejects(() => b.next(600), /timed out/);

  host.close(); a.close(); b.close();
});

test('the host is told when a guest goes away', async () => {
  const host = await connect('EEEE', 'host', 'h');
  await host.next();
  const guest = await connect('EEEE', 'guest', 'gone');
  await guest.next();
  await host.next();
  guest.close();
  assert.deepEqual(await host.next(), { t: 'peer-left', id: 'gone' });
  host.close();
});

test('guests are told when the host disappears', async () => {
  const host = await connect('FFFF', 'host', 'h');
  await host.next();
  const guest = await connect('FFFF', 'guest', 'g');
  await guest.next();
  await host.next();
  host.close();
  assert.deepEqual(await guest.next(), { t: 'host-gone' });
  guest.close();
});

test('a host that reloads reclaims its room and hears who is waiting', async () => {
  const host = await connect('GGGG', 'host', 'stable-id');
  await host.next();
  const guest = await connect('GGGG', 'guest', 'patient');
  await guest.next();
  await host.next();

  host.close();
  await guest.next();                             // host-gone
  const again = await connect('GGGG', 'host', 'stable-id');
  assert.equal((await again.next()).t, 'joined');
  // The room is not empty, and the returning host is told so.
  assert.deepEqual(await again.next(), { t: 'peer-join', id: 'patient' });

  again.send({ t: 'msg', to: 'patient', d: 'back' });
  assert.equal((await guest.next()).d, 'back');
  again.close(); guest.close();
});

test('someone else cannot steal an occupied room', async () => {
  const host = await connect('HHHH', 'host', 'the-real-host');
  await host.next();
  const impostor = await connect('HHHH', 'host', 'someone-else');
  assert.deepEqual(await impostor.next(), { t: 'error', e: 'room-taken' });
  await impostor.closed;
  // The real host is untouched.
  const guest = await connect('HHHH', 'guest', 'g');
  await guest.next();
  assert.deepEqual(await host.next(), { t: 'peer-join', id: 'g' });
  host.close(); guest.close();
});

test('a guest with no host is told so rather than shouting into a void', async () => {
  const guest = await connect('IIII', 'guest', 'lonely');
  const welcome = await guest.next();
  assert.equal(welcome.hostPresent, false);
  guest.send('anyone there?');
  assert.deepEqual(await guest.next(), { t: 'no-host' });
  guest.close();
});

test('malformed connections are refused at the handshake', async () => {
  const refused = [
    '?room=&role=host&id=x',                 // no room
    '?room=TOOLONGCODE&role=host&id=x',      // room code too long
    '?room=JJJJ&role=host&id=..%2Fetc',      // path characters in the id
    '?room=JJJJ&role=host&id=',              // no id
    '?room=JJ$$&role=host&id=abc',           // punctuation in the room code
  ];
  for (const query of refused) {
    const ws = new WebSocket(`${BASE}${query}`);
    // A refused handshake may surface as an error, a close, or both, depending
    // on how far it got — any of them means it did not connect.
    const settled = await Promise.race([
      once(ws, 'error').then(() => 'error'),
      once(ws, 'close').then(() => 'close'),
      once(ws, 'open').then(() => 'open'),
    ]);
    assert.notEqual(settled, 'open', `expected ${query} to be refused`);
    try { ws.close(); } catch { /* already gone */ }
  }
});

test('lobby codes are case-insensitive, so a shouted code still works', async () => {
  const host = await connect('PQRS', 'host', 'h');
  await host.next();
  // The guest types it in lower case, as people do.
  const guest = await connect('pqrs'.toUpperCase(), 'guest', 'g');
  await guest.next();
  assert.deepEqual(await host.next(), { t: 'peer-join', id: 'g' });

  // And straight through the query string, unchanged.
  const ws = new WebSocket(`${BASE}?room=pqrs&role=guest&id=lower`);
  await Promise.race([once(ws, 'open'), once(ws, 'close')]);
  assert.equal(ws.readyState, WebSocket.OPEN, 'a lower-case code was refused');
  assert.deepEqual(await host.next(), { t: 'peer-join', id: 'lower' });
  ws.close();
  host.close(); guest.close();
});

test('a big message survives the round trip in one piece', async () => {
  const host = await connect('KKKK', 'host', 'h');
  await host.next();
  const guest = await connect('KKKK', 'guest', 'g');
  await guest.next();
  await host.next();

  // Comfortably past the 125-byte and 64KB frame-length boundaries, and large
  // enough that a browser will fragment it.
  const big = 'x'.repeat(100_000);
  guest.send(big);
  const got = await host.next(8000);
  assert.equal(got.d.length, 100_000);
  assert.equal(got.d, big);

  host.close(); guest.close();
});

test('an oversized message does not take the relay down', async () => {
  const host = await connect('LLLL', 'host', 'h');
  await host.next();
  const guest = await connect('LLLL', 'guest', 'g');
  await guest.next();
  await host.next();

  guest.send('y'.repeat(200_000));                // over the cap
  // Whatever happens to that message, the relay must still be serving.
  await new Promise((r) => setTimeout(r, 400));
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(res.status, 200);

  host.close(); guest.close();
});

test('a flood is throttled without killing the process', async () => {
  const host = await connect('MMMM', 'host', 'h');
  await host.next();
  const guest = await connect('MMMM', 'guest', 'g');
  await guest.next();
  await host.next();

  for (let i = 0; i < 500; i++) guest.send(`flood ${i}`);
  await new Promise((r) => setTimeout(r, 600));
  const res = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal((await res.json()).ok, true);

  host.close(); guest.close();
});

test('a room fills up and says so', async () => {
  const host = await connect('NNNN', 'host', 'h');
  await host.next();
  const guests = [];
  for (let i = 0; i < 16; i++) {
    const g = await connect('NNNN', 'guest', `g${i}`);
    await g.next();
    guests.push(g);
  }
  const extra = await connect('NNNN', 'guest', 'one-too-many');
  assert.deepEqual(await extra.next(), { t: 'error', e: 'room-full' });
  host.close();
  for (const g of guests) g.close();
});

test('an empty room is forgotten', async () => {
  const host = await connect('OOOO', 'host', 'h');
  await host.next();
  let stats = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  const withRoom = stats.rooms;
  host.close();
  await new Promise((r) => setTimeout(r, 400));
  stats = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  assert.ok(stats.rooms < withRoom, `rooms went ${withRoom} -> ${stats.rooms}`);
});
