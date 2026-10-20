const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const WebSocket = require('ws');

const root = path.join(__dirname, '..');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=', 'base64');

test('shared notes support text, images, live updates, validation and deletion', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'notechat-test-'));
  await fs.copyFile(path.join(root, 'server.js'), path.join(fixture, 'server.js'));
  await fs.symlink(path.join(root, 'node_modules'), path.join(fixture, 'node_modules'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fixture, env: { ...process.env, PORT: '0', ACCESS_CODE: 'notes-test' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  // Discover the ephemeral port through the server's listening message.
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    if (output.includes('Server running on port')) break;
  }
  const port = output.match(/port (\d+)/)?.[1];
  assert.ok(port && port !== '0', `Server failed to start: ${output}`);
  const base = `http://127.0.0.1:${port}`;
  const login = async () => (await (await fetch(`${base}/access-token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'notes-test' }),
  })).json()).tabToken;
  const token = await login();
  const headers = { 'x-tab-token': token };
  const connect = async (tab) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
    t.after(() => ws.close());
    const events = [];
    ws.on('message', (raw) => {
      const packet = raw.toString();
      if (packet.startsWith('0')) ws.send(`40${JSON.stringify({ tab })}`);
      if (packet === '2') ws.send('3');
      if (packet.startsWith('42')) events.push(JSON.parse(packet.slice(2)));
    });
    await once(ws, 'open');
    return events;
  };
  const waitFor = async (condition) => {
    for (let i = 0; i < 100; i++) {
      if (await condition()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('Timed out waiting for live shared board update');
  };
  const events = await connect(await login());
  await waitFor(() => events.some(([event]) => event === 'shared-images'));
  const post = async (text, files = [], endpoint = '/shared-note') => {
    const form = new FormData();
    form.append('name', 'Test author');
    form.append('text', text);
    files.forEach(([name, mime]) => form.append(endpoint === '/shared-image' ? 'file' : 'images', new Blob([png], { type: mime }), name));
    return fetch(base + endpoint, { method: 'POST', headers, body: form });
  };
  assert.equal((await fetch(`${base}/shared-note`, { method: 'POST', body: new FormData() })).status, 403);
  assert.equal((await post('   ')).status, 400);
  assert.equal((await post('x'.repeat(10001), [['too-long.png', 'image/png']])).status, 400);
  assert.equal((await post('bad file', [['file.txt', 'text/plain']])).status, 400);
  assert.equal((await post('', Array.from({ length: 11 }, () => ['many.png', 'image/png']))).status, 400);

  assert.deepEqual(await fs.readdir(path.join(fixture, 'uploads')), [], 'Rejected uploads must be removed');
  const posts = [];
  for (const [text, files] of [
    ['Hello\n<script>alert("test")</script>', []],
    ['', [['one.png', 'image/png'], ['two.png', 'image/png']]],
    ['A note with photos', [['three.png', 'image/png']]],
  ]) {
    const response = await post(text, files);
    assert.equal(response.status, 200);
    const { note } = await response.json();
    posts.push(note);
    assert.equal(note.text, text);
    assert.equal(note.images.length, files.length);
    await waitFor(() => events.some(([event, list]) => event === 'shared-images' && list.some((item) => item.id === note.id)));
    for (const image of note.images) {
      assert.equal((await fetch(base + image.url)).status, 403);
      assert.equal((await fetch(base + image.url, { headers })).status, 200);
    }
  }
  const legacy = await post('', [['legacy.png', 'image/png']], '/shared-image');
  assert.equal(legacy.status, 200);
  posts.push((await legacy.json()).image);
  const reconnect = await connect(await login());
  await waitFor(() => reconnect.some(([event, list]) => event === 'shared-images' && list.length === 4));
  for (const note of posts) {
    assert.equal((await fetch(`${base}/shared-note/${note.id}`, { method: 'DELETE', headers })).status, 200);
    for (const image of note.images || [note]) {
      if (image.url) await waitFor(async () => (await fetch(base + image.url, { headers })).status === 404);
    }
  }
  await waitFor(() => events.some(([event, list]) => event === 'shared-images' && list.length === 0));
  assert.equal((await fetch(`${base}/shared-note/missing`, { method: 'DELETE', headers })).status, 404);
});

test('browser script parses', async () => {
  const html = await fs.readFile(path.join(root, 'public/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.length);
  scripts.forEach(([, source]) => new vm.Script(source));
});
