import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';
import {
  FIGMA_ACQUISITION_OPERATION,
  FIGMA_ACQUISITION_PLUGIN,
  FIGMA_ACQUISITION_PROTOCOL,
  startFigmaReadonlyBridge,
} from './lib/figma-readonly-bridge.mjs';

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data, isBinary) => {
      if (isBinary) return reject(new Error('Unexpected binary frame.'));
      resolve(JSON.parse(data.toString('utf8')));
    });
    socket.once('error', reject);
  });
}

function connect(url, origin = 'https://www.figma.com') {
  const socket = new WebSocket(url, origin === undefined ? {} : { origin });
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function authenticate(
  bridge,
  { fileKey = 'FileKey123', fileName = 'Final ', hello = {} } = {}
) {
  const socket = await connect(bridge.url);
  socket.send(
    JSON.stringify({
      type: 'hello',
      protocol: FIGMA_ACQUISITION_PROTOCOL,
      plugin: FIGMA_ACQUISITION_PLUGIN,
      sessionNonce: bridge.sessionNonce,
      file: { key: fileKey, name: fileName },
      ...hello,
    })
  );
  assert.deepEqual(await nextMessage(socket), {
    type: 'hello_ack',
    protocol: FIGMA_ACQUISITION_PROTOCOL,
    accepted: true,
  });
  return socket;
}

function rejectedUpgrade(url, origin) {
  const socket = new WebSocket(url, origin === undefined ? {} : { origin });
  return new Promise((resolve, reject) => {
    socket.once('unexpected-response', (_request, response) => {
      const status = response.statusCode;
      response.resume();
      socket.terminate();
      resolve(status);
    });
    socket.once('open', () => {
      socket.terminate();
      reject(new Error('WebSocket upgrade unexpectedly succeeded.'));
    });
    socket.once('error', (error) => {
      if (!error.message.includes('Unexpected server response')) reject(error);
    });
  });
}

async function fixture(t, options = {}) {
  const bridge = await startFigmaReadonlyBridge({ port: 0, ...options });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await bridge.close();
  });
  return {
    bridge,
    async plugin(options) {
      const socket = await authenticate(bridge, options);
      sockets.push(socket);
      return socket;
    },
  };
}

test('authenticates the pinned plugin and issues exactly one acquisition operation', async (t) => {
  const current = await fixture(t);
  const plugin = await current.plugin({ fileKey: 'PinnedFile123', fileName: 'Final ' });
  const connection = await current.bridge.waitForConnection({
    fileKey: 'PinnedFile123',
    fileName: 'Final ',
    timeoutMs: 500,
  });
  const requestPromise = nextMessage(plugin);
  const acquisitionPromise = current.bridge.acquireReference(
    connection,
    { nodeId: '12:34', exportSpec: { format: 'PNG', scale: 1, clip: false } },
    500
  );
  const request = await requestPromise;
  assert.deepEqual(
    { ...request, requestId: '<id>' },
    {
      type: FIGMA_ACQUISITION_OPERATION,
      protocol: FIGMA_ACQUISITION_PROTOCOL,
      requestId: '<id>',
      nodeId: '12:34',
      export: { format: 'PNG', scale: 1, clip: false },
    }
  );
  const data = { before: {}, export: {}, after: {} };
  plugin.send(
    JSON.stringify({
      type: 'acquisition_result',
      protocol: FIGMA_ACQUISITION_PROTOCOL,
      requestId: request.requestId,
      data,
    })
  );
  assert.deepEqual(await acquisitionPromise, data);
  await assert.rejects(
    current.bridge.acquireReference(connection, {
      nodeId: '12:34',
      exportSpec: { format: 'PNG', scale: 1, clip: false },
    }),
    (error) => error.code === 'FIGMA_BRIDGE_READ_ONLY'
  );
});

test('permits a reviewed bounded batch on one authenticated connection, sequentially', async (t) => {
  const current = await fixture(t, { maxRequests: 2 });
  const plugin = await current.plugin({ fileKey: 'BatchFile123', fileName: 'Final ' });
  const connection = await current.bridge.waitForConnection({ fileKey: 'BatchFile123' });
  for (const nodeId of ['12:34', '56:78']) {
    const requestPromise = nextMessage(plugin);
    const acquisitionPromise = current.bridge.acquireReference(
      connection,
      { nodeId, exportSpec: { format: 'PNG', scale: 1, clip: false } },
      500
    );
    const request = await requestPromise;
    assert.equal(request.nodeId, nodeId);
    plugin.send(
      JSON.stringify({
        type: 'acquisition_result',
        protocol: FIGMA_ACQUISITION_PROTOCOL,
        requestId: request.requestId,
        data: { before: {}, export: {}, after: {} },
      })
    );
    await acquisitionPromise;
  }
  await assert.rejects(
    current.bridge.acquireReference(connection, {
      nodeId: '90:12',
      exportSpec: { format: 'PNG', scale: 1, clip: false },
    }),
    (error) => error.code === 'FIGMA_BRIDGE_READ_ONLY'
  );
});

test('rejects mutation-like or noncanonical export requests before sending a frame', async (t) => {
  const current = await fixture(t);
  const plugin = await current.plugin({ fileKey: 'ReadOnly123', fileName: 'Read only' });
  const connection = await current.bridge.waitForConnection({ fileKey: 'ReadOnly123' });
  let frames = 0;
  plugin.on('message', () => {
    frames += 1;
  });
  await assert.rejects(
    current.bridge.acquireReference(connection, {
      nodeId: '12:34',
      exportSpec: { format: 'SVG', scale: 1, clip: false },
    }),
    (error) => error.code === 'FIGMA_BRIDGE_READ_ONLY'
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(frames, 0);
});

test('rejects untrusted or missing browser origins and URL identity smuggling', async (t) => {
  const current = await fixture(t);
  assert.equal(await rejectedUpgrade(current.bridge.url, 'https://attacker.example'), 403);
  assert.equal(await rejectedUpgrade(current.bridge.url, undefined), 403);
  assert.equal(await rejectedUpgrade(`${current.bridge.url}?fileKey=forged`, 'null'), 400);
});

test('rejects a wrong nonce or plugin build before exposing a connection', async (t) => {
  const current = await fixture(t);
  for (const hello of [
    { sessionNonce: 'A'.repeat(43) },
    { plugin: { ...FIGMA_ACQUISITION_PLUGIN, build: 'untrusted-build' } },
  ]) {
    const socket = await connect(current.bridge.url, 'null');
    socket.send(
      JSON.stringify({
        type: 'hello',
        protocol: FIGMA_ACQUISITION_PROTOCOL,
        plugin: FIGMA_ACQUISITION_PLUGIN,
        sessionNonce: current.bridge.sessionNonce,
        file: { key: 'ForgedFile123', name: 'Forged' },
        ...hello,
      })
    );
    await new Promise((resolve) => socket.once('close', resolve));
  }
  await assert.rejects(
    current.bridge.waitForConnection({ fileKey: 'ForgedFile123', timeoutMs: 30 }),
    (error) => error.code === 'FIGMA_BRIDGE_CONNECTION_TIMEOUT'
  );
});

test('selects only the authenticated exact file and rejects nonce reuse', async (t) => {
  const current = await fixture(t);
  await current.plugin({ fileKey: 'FirstFile123', fileName: 'Shared design' });
  const selected = await current.bridge.waitForConnection({
    fileKey: 'FirstFile123',
    fileName: 'Shared design',
    timeoutMs: 100,
  });
  assert.equal(selected.fileKey, 'FirstFile123');

  const duplicate = await connect(current.bridge.url);
  duplicate.send(
    JSON.stringify({
      type: 'hello',
      protocol: FIGMA_ACQUISITION_PROTOCOL,
      plugin: FIGMA_ACQUISITION_PLUGIN,
      sessionNonce: current.bridge.sessionNonce,
      file: { key: 'FirstFile123', name: 'Duplicate' },
    })
  );
  await new Promise((resolve) => duplicate.once('close', resolve));
});

test('rejects an in-flight acquisition when the plugin disconnects', async (t) => {
  const current = await fixture(t);
  const plugin = await current.plugin({ fileKey: 'Disconnect123', fileName: 'Disconnect' });
  const connection = await current.bridge.waitForConnection({ fileKey: 'Disconnect123' });
  plugin.once('message', () => plugin.close());
  await assert.rejects(
    current.bridge.acquireReference(
      connection,
      { nodeId: '12:34', exportSpec: { format: 'PNG', scale: 1, clip: false } },
      5_000
    ),
    (error) => error.code === 'FIGMA_BRIDGE_PLUGIN_DISCONNECTED'
  );
});
