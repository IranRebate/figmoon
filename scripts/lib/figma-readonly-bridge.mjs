import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { assertFigmaAcquisitionPluginIntegrity } from './figma-plugin-integrity.mjs';

const LISTEN_HOST = '127.0.0.1';
const DEFAULT_PORT = 29195;
const DEFAULT_CONNECTION_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUESTS = 1;
const MAX_BATCH_REQUESTS = 128;
const MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const PROTOCOL = 'figmoon-reference-acquisition/v1';
const PLUGIN = assertFigmaAcquisitionPluginIntegrity().plugin;

export const FIGMA_ACQUISITION_OPERATION = 'acquire_reference';
export const FIGMA_ACQUISITION_PROTOCOL = PROTOCOL;
export const FIGMA_ACQUISITION_PLUGIN = PLUGIN;
export const FIGMA_READ_REQUEST_TYPES = Object.freeze(['acquire_reference']);

export class FigmaReadonlyBridgeError extends Error {
  constructor(code, message, options = undefined) {
    super(message, options);
    this.name = 'FigmaReadonlyBridgeError';
    this.code = code;
  }
}

function bridgeError(code, message, cause = undefined) {
  return new FigmaReadonlyBridgeError(code, message, cause ? { cause } : undefined);
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw bridgeError(
      'FIGMA_BRIDGE_INVALID_PORT',
      'Bridge port must be an integer from 0 to 65535.'
    );
  }
}

function validateTimeout(timeoutMs, label) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw bridgeError(
      'FIGMA_BRIDGE_INVALID_TIMEOUT',
      `${label} must be a positive number of milliseconds.`
    );
  }
}

function validateMaxRequests(maxRequests) {
  if (
    !Number.isInteger(maxRequests) ||
    maxRequests < DEFAULT_MAX_REQUESTS ||
    maxRequests > MAX_BATCH_REQUESTS
  ) {
    throw bridgeError(
      'FIGMA_BRIDGE_INVALID_REQUEST',
      `maxRequests must be an integer from ${DEFAULT_MAX_REQUESTS} through ${MAX_BATCH_REQUESTS}.`
    );
  }
}

function validateFileKey(fileKey, label = 'fileKey') {
  if (
    typeof fileKey !== 'string' ||
    fileKey.length === 0 ||
    fileKey.length > 256 ||
    fileKey.trim() !== fileKey ||
    !/^[A-Za-z0-9_-]+$/.test(fileKey)
  ) {
    throw bridgeError(
      'FIGMA_BRIDGE_INVALID_IDENTITY',
      `${label} must be a non-empty Figma file key containing only letters, digits, underscores, or hyphens.`
    );
  }
  return fileKey;
}

function validateFileName(fileName, label = 'fileName') {
  if (
    typeof fileName !== 'string' ||
    fileName.length === 0 ||
    fileName.length > 512 ||
    fileName.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/.test(fileName)
  ) {
    throw bridgeError(
      'FIGMA_BRIDGE_INVALID_IDENTITY',
      `${label} must be a non-empty Figma file name without control characters.`
    );
  }
  return fileName;
}

function validateNodeId(nodeId) {
  if (typeof nodeId !== 'string' || !/^(?:I)?\d+:\d+(?:;\d+:\d+)*$/.test(nodeId)) {
    throw bridgeError(
      'FIGMA_BRIDGE_INVALID_REQUEST',
      'acquire_reference requires one explicit Figma node ID.'
    );
  }
  return nodeId;
}

function validateExport(exportSpec) {
  if (
    !exportSpec ||
    typeof exportSpec !== 'object' ||
    Array.isArray(exportSpec) ||
    exportSpec.format !== 'PNG' ||
    exportSpec.scale !== 1 ||
    typeof exportSpec.clip !== 'boolean' ||
    Object.keys(exportSpec).length !== 3
  ) {
    throw bridgeError(
      'FIGMA_BRIDGE_READ_ONLY',
      'acquire_reference requires the fixed raw 1x PNG export specification.'
    );
  }
  return { format: 'PNG', scale: 1, clip: exportSpec.clip };
}

function parseHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string') return null;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/i.exec(hostHeader);
  if (!match) return null;
  const declaredPort = match[2] === undefined ? null : Number(match[2]);
  return declaredPort !== null && declaredPort > 65_535 ? null : { declaredPort };
}

function isTrustedHost(hostHeader, listenPort) {
  const parsed = parseHostHeader(hostHeader);
  return parsed !== null && (parsed.declaredPort === null || parsed.declaredPort === listenPort);
}

function isTrustedOrigin(originHeader) {
  if (originHeader === 'null') return true;
  if (typeof originHeader !== 'string') return false;
  try {
    const origin = new URL(originHeader);
    return (
      origin.protocol === 'https:' &&
      (origin.hostname === 'figma.com' || origin.hostname.endsWith('.figma.com')) &&
      (origin.port === '' || origin.port === '443') &&
      origin.username === '' &&
      origin.password === '' &&
      origin.pathname === '/' &&
      origin.search === '' &&
      origin.hash === ''
    );
  } catch {
    return false;
  }
}

function rejectUpgrade(socket, statusCode, reason) {
  if (!socket.writable) return socket.destroy();
  socket.end(`HTTP/1.1 ${statusCode} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function exactKeys(value, keys) {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function nonceMatches(actual, expected) {
  if (typeof actual !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(actual)) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function parseHello(raw, sessionNonce) {
  let hello;
  try {
    hello = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw bridgeError('FIGMA_BRIDGE_PROTOCOL_ERROR', 'Figma plugin sent malformed JSON.', error);
  }
  if (
    !hello ||
    typeof hello !== 'object' ||
    Array.isArray(hello) ||
    !exactKeys(hello, ['type', 'protocol', 'plugin', 'sessionNonce', 'file']) ||
    hello.type !== 'hello' ||
    hello.protocol !== PROTOCOL ||
    !hello.plugin ||
    typeof hello.plugin !== 'object' ||
    !exactKeys(hello.plugin, ['id', 'version', 'build']) ||
    hello.plugin.id !== PLUGIN.id ||
    hello.plugin.version !== PLUGIN.version ||
    hello.plugin.build !== PLUGIN.build ||
    !hello.file ||
    typeof hello.file !== 'object' ||
    !exactKeys(hello.file, ['key', 'name']) ||
    !nonceMatches(hello.sessionNonce, sessionNonce)
  ) {
    throw bridgeError(
      'FIGMA_BRIDGE_PROTOCOL_ERROR',
      'Figma plugin hello did not match the one-time acquisition contract.'
    );
  }
  return {
    fileKey: validateFileKey(hello.file.key, 'hello.file.key'),
    fileName: validateFileName(hello.file.name, 'hello.file.name'),
  };
}

/** Starts a transient, loopback-only broker for Figmoon's reference mode. */
export async function startFigmaReadonlyBridge({
  port = DEFAULT_PORT,
  maxRequests = DEFAULT_MAX_REQUESTS,
} = {}) {
  assertFigmaAcquisitionPluginIntegrity();
  validatePort(port);
  validateMaxRequests(maxRequests);
  const connections = new Map();
  const allRecords = new Set();
  const waiters = new Set();
  const sessionNonce = randomBytes(32).toString('base64url');
  let nonceConsumed = false;
  let closed = false;
  let closePromise = null;
  let listenPort = null;
  const httpServer = createServer((_request, response) => {
    response.writeHead(404, { 'cache-control': 'no-store', 'content-length': '0' });
    response.end();
  });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
  });

  function rejectPending(record, error) {
    for (const pending of record.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    record.pending.clear();
  }
  function removeConnection(record, cause) {
    allRecords.delete(record);
    clearTimeout(record.helloTimer);
    if (record.descriptor && connections.get(record.descriptor.id) === record)
      connections.delete(record.descriptor.id);
    rejectPending(
      record,
      bridgeError(
        'FIGMA_BRIDGE_PLUGIN_DISCONNECTED',
        `Figma plugin disconnected from file "${record.descriptor?.fileName ?? 'unauthenticated'}".`,
        cause
      )
    );
  }
  function matchingRecords(selector) {
    return [...connections.values()].filter(
      ({ descriptor }) =>
        (selector.fileKey === undefined || descriptor.fileKey === selector.fileKey) &&
        (selector.fileName === undefined || descriptor.fileName === selector.fileName)
    );
  }
  function settleWaiter(waiter) {
    const matches = matchingRecords(waiter.selector);
    if (!matches.length) return;
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    if (matches.length > 1)
      waiter.reject(
        bridgeError(
          'FIGMA_BRIDGE_AMBIGUOUS_CONNECTION',
          `Connection selection is ambiguous: ${matches.length} Figma files match. Select by fileKey.`
        )
      );
    else waiter.resolve(matches[0].descriptor);
  }
  function settleWaiters() {
    for (const waiter of [...waiters]) settleWaiter(waiter);
  }
  function failProtocol(record, message, cause) {
    rejectPending(record, bridgeError('FIGMA_BRIDGE_PROTOCOL_ERROR', message, cause));
    record.socket.close(1002, 'Invalid plugin response');
  }

  function handleMessage(record, raw, isBinary) {
    if (isBinary)
      return failProtocol(record, 'Figma plugin sent a binary frame; JSON text was required.');
    if (!record.authenticated) {
      let identity;
      try {
        identity = parseHello(raw, sessionNonce);
      } catch (error) {
        return failProtocol(record, error.message, error);
      }
      if (nonceConsumed)
        return failProtocol(record, 'Figma plugin attempted to reuse an acquisition nonce.');
      nonceConsumed = true;
      clearTimeout(record.helloTimer);
      record.authenticated = true;
      record.descriptor = Object.freeze({
        id: randomUUID(),
        ...identity,
        connectedAt: new Date().toISOString(),
      });
      connections.set(record.descriptor.id, record);
      record.socket.send(
        JSON.stringify({ type: 'hello_ack', protocol: PROTOCOL, accepted: true }),
        (error) => {
          if (error) removeConnection(record, error);
        }
      );
      settleWaiters();
      return;
    }
    let response;
    try {
      response = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      return failProtocol(record, 'Figma plugin sent malformed JSON.', error);
    }
    if (
      !response ||
      typeof response !== 'object' ||
      Array.isArray(response) ||
      !exactKeys(response, [
        'type',
        'protocol',
        'requestId',
        ...(Object.hasOwn(response, 'data') ? ['data'] : ['error']),
      ]) ||
      response.type !== 'acquisition_result' ||
      response.protocol !== PROTOCOL ||
      typeof response.requestId !== 'string'
    )
      return failProtocol(record, 'Figma plugin response did not match the acquisition contract.');
    const pending = record.pending.get(response.requestId);
    if (!pending)
      return failProtocol(record, 'Figma plugin sent an unsolicited acquisition response.');
    record.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (Object.hasOwn(response, 'error'))
      pending.reject(
        bridgeError(
          'FIGMA_BRIDGE_PLUGIN_ERROR',
          `Figma plugin rejected acquisition: ${typeof response.error?.message === 'string' ? response.error.message : 'Unknown plugin error'}`
        )
      );
    else pending.resolve(response.data);
  }

  webSocketServer.on('connection', (socket) => {
    const record = {
      socket,
      authenticated: false,
      descriptor: null,
      pending: new Map(),
      requestCount: 0,
      helloTimer: null,
    };
    allRecords.add(record);
    record.helloTimer = setTimeout(
      () => failProtocol(record, 'Figma plugin hello timed out.'),
      5_000
    );
    record.helloTimer.unref?.();
    socket.on('message', (data, isBinary) => handleMessage(record, data, isBinary));
    socket.once('error', (error) => removeConnection(record, error));
    socket.once('close', () => removeConnection(record));
  });
  httpServer.on('upgrade', (request, socket, head) => {
    if (closed || request.method !== 'GET') return rejectUpgrade(socket, 405, 'Method Not Allowed');
    if (
      !isTrustedHost(request.headers.host, listenPort) ||
      !isTrustedOrigin(request.headers.origin)
    )
      return rejectUpgrade(socket, 403, 'Forbidden');
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host}`);
    } catch {
      return rejectUpgrade(socket, 400, 'Bad Request');
    }
    if (url.pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
    if (url.search) return rejectUpgrade(socket, 400, 'Bad Request');
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) =>
      webSocketServer.emit('connection', webSocket, request)
    );
  });
  try {
    await new Promise((resolveListen, rejectListen) => {
      const onError = (error) => rejectListen(error);
      httpServer.once('error', onError);
      httpServer.listen(port, LISTEN_HOST, () => {
        httpServer.off('error', onError);
        resolveListen();
      });
    });
  } catch (error) {
    throw bridgeError(
      'FIGMA_BRIDGE_LISTEN_FAILED',
      `Could not start the Figma bridge on ${LISTEN_HOST}:${port}.`,
      error
    );
  }
  const address = httpServer.address();
  if (!address || typeof address === 'string') {
    httpServer.close();
    throw bridgeError('FIGMA_BRIDGE_LISTEN_FAILED', 'Figma bridge did not expose a TCP port.');
  }
  listenPort = address.port;
  async function waitForConnection({
    fileKey,
    fileName,
    timeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
  } = {}) {
    if (closed) throw bridgeError('FIGMA_BRIDGE_CLOSED', 'Figma bridge is closed.');
    validateTimeout(timeoutMs, 'Connection timeout');
    const selector = {
      ...(fileKey === undefined ? {} : { fileKey: validateFileKey(fileKey, 'selector.fileKey') }),
      ...(fileName === undefined
        ? {}
        : { fileName: validateFileName(fileName, 'selector.fileName') }),
    };
    if (!Object.keys(selector).length)
      throw bridgeError(
        'FIGMA_BRIDGE_INVALID_SELECTOR',
        'Connection selection requires an explicit fileKey, fileName, or both.'
      );
    return new Promise((resolveConnection, rejectConnection) => {
      const waiter = {
        selector,
        resolve: resolveConnection,
        reject: rejectConnection,
        timer: setTimeout(() => {
          waiters.delete(waiter);
          rejectConnection(
            bridgeError(
              'FIGMA_BRIDGE_CONNECTION_TIMEOUT',
              `Timed out waiting for the selected Figma file after ${timeoutMs}ms.`
            )
          );
        }, timeoutMs),
      };
      waiter.timer.unref?.();
      waiters.add(waiter);
      settleWaiter(waiter);
    });
  }
  async function request(connection, nodeId, exportSpec, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    if (closed) throw bridgeError('FIGMA_BRIDGE_CLOSED', 'Figma bridge is closed.');
    validateTimeout(timeoutMs, 'Request timeout');
    validateNodeId(nodeId);
    const exportValue = validateExport(exportSpec);
    const record = connection && connections.get(connection.id);
    if (!record || record.descriptor !== connection || record.socket.readyState !== WebSocket.OPEN)
      throw bridgeError(
        'FIGMA_BRIDGE_UNKNOWN_CONNECTION',
        'The selected Figma connection is not live.'
      );
    if (record.pending.size)
      throw bridgeError(
        'FIGMA_BRIDGE_READ_ONLY',
        'An acquisition is already in flight for this authenticated plugin session.'
      );
    if (record.requestCount >= maxRequests)
      throw bridgeError(
        'FIGMA_BRIDGE_READ_ONLY',
        `This authenticated plugin session may perform at most ${maxRequests} acquisition request${maxRequests === 1 ? '' : 's'}.`
      );
    record.requestCount += 1;
    const requestId = randomUUID();
    const payload = {
      type: 'acquire_reference',
      protocol: PROTOCOL,
      requestId,
      nodeId,
      export: exportValue,
    };
    return new Promise((resolveRequest, rejectRequest) => {
      const pending = {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer: setTimeout(() => {
          if (record.pending.delete(requestId))
            rejectRequest(
              bridgeError(
                'FIGMA_BRIDGE_REQUEST_TIMEOUT',
                `acquire_reference timed out after ${timeoutMs}ms.`
              )
            );
        }, timeoutMs),
      };
      pending.timer.unref?.();
      record.pending.set(requestId, pending);
      record.socket.send(JSON.stringify(payload), (error) => {
        if (!error || !record.pending.delete(requestId)) return;
        clearTimeout(pending.timer);
        rejectRequest(
          bridgeError(
            'FIGMA_BRIDGE_SEND_FAILED',
            'Could not send acquire_reference to the Figma plugin.',
            error
          )
        );
      });
    });
  }
  async function acquireReference(connection, { nodeId, exportSpec } = {}, timeoutMs) {
    return request(connection, nodeId, exportSpec, timeoutMs);
  }
  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      const closeError = bridgeError('FIGMA_BRIDGE_CLOSED', 'Figma bridge was closed.');
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(closeError);
      }
      waiters.clear();
      for (const record of allRecords) {
        clearTimeout(record.helloTimer);
        rejectPending(record, closeError);
        record.socket.terminate();
      }
      allRecords.clear();
      connections.clear();
      await Promise.all([
        new Promise((resolveClose) => webSocketServer.close(() => resolveClose())),
        new Promise((resolveClose, rejectClose) =>
          httpServer.close((error) => (error ? rejectClose(error) : resolveClose()))
        ),
      ]);
    })();
    return closePromise;
  }
  return Object.freeze({
    host: LISTEN_HOST,
    port: listenPort,
    url: `ws://${LISTEN_HOST}:${listenPort}/ws`,
    sessionNonce,
    maxRequests,
    waitForConnection,
    request,
    acquireReference,
    close,
  });
}
