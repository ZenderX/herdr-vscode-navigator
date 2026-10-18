// Read-only probe of the live herdr named pipe. Sends only ping, session.snapshot, events.subscribe.
import net from 'node:net';
import path from 'node:path';

const PREFIX = '\\\\.\\pipe\\';

function resolvePipe() {
  const raw = process.env.HERDR_SOCKET_PATH || path.join(process.env.APPDATA ?? '', 'herdr', 'herdr.sock');
  return raw.startsWith(PREFIX) ? raw : PREFIX + raw;
}

function parseListen(argv) {
  const i = argv.indexOf('--listen');
  if (i === -1) return 8;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n) || n < 0) {
    console.error('--listen requires a non-negative number of seconds');
    process.exit(2);
  }
  return n;
}

const DEFAULT_TYPES = ['workspace.focused', 'tab.focused', 'pane.focused', 'pane.updated'];

function parseTypes(argv) {
  const i = argv.indexOf('--types');
  if (i === -1) return DEFAULT_TYPES;
  const list = (argv[i + 1] ?? '').split(',').filter(Boolean);
  if (list.length === 0) {
    console.error('--types requires a comma-separated list of event types');
    process.exit(2);
  }
  return list;
}

function fail(pipe, err) {
  console.error(`herdr pipe unreachable (${pipe}): ${err.message}`);
  process.exit(1);
}

function call(pipe, method, params) {
  return new Promise((resolve) => {
    const sock = net.createConnection(pipe);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', (err) => fail(pipe, err));
    sock.on('connect', () => sock.write(JSON.stringify({ id: `probe_${method}`, method, params }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl !== -1) {
        sock.destroy();
        resolve(buf.slice(0, nl));
      }
    });
  });
}

function listen(pipe, seconds, eventTypes) {
  return new Promise((resolve) => {
    const sock = net.createConnection(pipe);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', (err) => fail(pipe, err));
    sock.on('connect', () => {
      const types = eventTypes.map((type) => ({ type }));
      sock.write(JSON.stringify({ id: 'probe_sub', method: 'events.subscribe', params: { subscriptions: types } }) + '\n');
      setTimeout(() => {
        sock.destroy();
        resolve();
      }, seconds * 1000);
    });
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        console.log(`subscribe line: ${buf.slice(0, nl)}`);
        buf = buf.slice(nl + 1);
      }
    });
  });
}

const pipe = resolvePipe();
const seconds = parseListen(process.argv.slice(2));
console.log(`pipe: ${pipe}`);
console.log(`ping: ${await call(pipe, 'ping', {})}`);
console.log(`session.snapshot: ${await call(pipe, 'session.snapshot', {})}`);
const eventTypes = parseTypes(process.argv.slice(2));
if (seconds > 0) await listen(pipe, seconds, eventTypes);
process.exit(0);
