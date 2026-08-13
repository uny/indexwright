/**
 * A pass-through proxy in front of the Firestore emulator.
 *
 * The client under test is pointed at this port instead of the emulator's, so capture is
 * independent of language and framework: it reads the wire rather than the source. The proxy must
 * therefore be invisible — a suite that passes against the emulator has to pass against the proxy,
 * or the tool has changed what it was measuring.
 */
import { createServer as createHttp1Server, request as http1Request } from 'node:http';
import type { IncomingMessage, Server as Http1Server, ServerResponse } from 'node:http';
import { connect, constants, createServer as createHttp2Server, sensitiveHeaders } from 'node:http2';
import type {
  ClientHttp2Session,
  ClientHttp2Stream,
  Http2Server,
  Http2Session,
  IncomingHttpHeaders,
  OutgoingHttpHeaders,
  ServerHttp2Stream,
} from 'node:http2';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo, Server as TcpServer, Socket } from 'node:net';
import { parseHostPort, requireLoopbackBind, requireLoopbackUpstream } from './endpoints.js';

// Re-exported because it was part of this module's public surface before it moved to `endpoints.ts`,
// where both the proxy and the argument parser can reach it.
export { parseHostPort } from './endpoints.js';
import { Recorder } from './recorder.js';

const FIRESTORE_SERVICE = 'google.firestore.v1.Firestore';

/**
 * Methods on the Firestore service that carry no `StructuredQuery`.
 *
 * Listed rather than inferred, so that a method this package has never heard of is counted as
 * `unsupported-rpc` instead of assumed harmless. SPEC §7: `skipped: []` has to mean *nothing was
 * declined*, not *nothing the proxy happened to recognise was declined*.
 */
const NON_QUERY_METHODS = new Set([
  'BatchGetDocuments',
  'BatchWrite',
  'BeginTransaction',
  'Commit',
  'CreateDocument',
  'DeleteDocument',
  'GetDocument',
  'ListCollectionIds',
  'ListDocuments',
  'Rollback',
  'UpdateDocument',
  'Write',
]);

/** A request body larger than this is not a query anyone wrote; it is a message misread. */
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/** The HTTP/2 cleartext connection preface. A connection that does not open with it is HTTP/1.1. */
const HTTP2_PREFACE = Buffer.from('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n', 'latin1');

export interface CaptureOptions {
  /** `host:port` of the emulator the proxy forwards to. Must be loopback; see `allowRemoteUpstream`. */
  readonly upstream: string;
  /** Address to listen on. Defaults to an ephemeral port on 127.0.0.1. */
  readonly host?: string;
  readonly port?: number;
  /**
   * Bind a non-loopback address anyway (issue #7).
   *
   * Off by default because the proxy authenticates nothing: reachable from off the machine, it is an
   * open read/write channel into the emulator's dataset. `indexwright-record` exposes no way to set
   * this — the verb has no `--host`, deliberately, since adding one to guard it would be inventing
   * the exposure. It exists for a caller that has its own reason and is stating it.
   */
  readonly allowRemoteBind?: boolean;
  /**
   * Forward to a non-loopback upstream anyway (issue #7).
   *
   * Off by default because nothing makes an upstream actually be an emulator, and a wrong one routes
   * real documents and gRPC `authorization` metadata through this process.
   */
  readonly allowRemoteUpstream?: boolean;
  /** Called for anything that would otherwise be silent, such as an upstream connection failure. */
  readonly onWarning?: (message: string) => void;
}

export interface Capture {
  readonly recorder: Recorder;
  /** `host:port` to hand to `FIRESTORE_EMULATOR_HOST`. */
  readonly address: string;
  close(): Promise<void>;
}

export async function startCapture(options: CaptureOptions): Promise<Capture> {
  const recorder = new Recorder();
  const warn = options.onWarning ?? ((): void => {});
  const upstream = parseHostPort(options.upstream);

  // Before anything is opened. A refusal that arrived after the listener was up would have already
  // published the port it was refusing to publish.
  requireLoopbackUpstream({
    host: upstream.host,
    value: options.upstream,
    origin: { kind: 'option', field: 'upstream' },
    override: 'allowRemoteUpstream: true',
    allowed: options.allowRemoteUpstream,
  });
  const bindHost = options.host ?? '127.0.0.1';
  requireLoopbackBind({
    host: bindHost,
    origin: { kind: 'option', field: 'host' },
    override: 'allowRemoteBind: true',
    allowed: options.allowRemoteBind,
  });

  // `formatHost`, not the bare host: `parseHostPort` strips the brackets off an IPv6 literal, and
  // "http://::1:8080" is not a URL — an emulator addressed as [::1]:8080 would fail to connect at
  // all rather than proxy.
  const client = connect(`http://${formatHost(upstream.host)}:${upstream.port}`);
  client.on('error', (error) => warn(`upstream connection: ${error.message}`));

  const sessions = new Set<Http2Session>();
  const http2 = createHttp2Server();
  http2.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  http2.on('stream', (stream, headers) => proxyStream(stream, headers, client, recorder, warn));
  http2.on('sessionError', (error) => warn(`session: ${error.message}`));

  // A cleartext HTTP/2 server cannot negotiate HTTP/1.1 — `allowHTTP1` exists only where ALPN
  // does. Anything pointed at FIRESTORE_EMULATOR_HOST that speaks REST would therefore be refused
  // outright, including the emulator's own data-clearing endpoint, so the two are told apart by
  // the connection preface and each handed to a server that speaks it. HTTP/1.1 carries no gRPC
  // and is never captured; §3 names that as a transport gap.
  const http1 = createHttp1Server((request, response) => {
    recorder.countHttp1();
    proxyHttp1(request, response, upstream, warn);
  });

  // Tracked so that closing does not wait on a keep-alive connection the suite left open. The
  // suite has already exited by then; the only thing still holding the socket is politeness.
  const sockets = new Set<Socket>();
  const tcp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    route(socket, http2, http1, warn);
  });

  // The upstream session is already open by now, so a listen that fails has to take it down on the
  // way out. Left behind it keeps the event loop alive: `--port` on a port something else holds
  // reported the error and then hung instead of exiting 2, because nothing was ever going to close
  // the handle the rejected call had opened.
  try {
    await new Promise<void>((resolve, reject) => {
      tcp.once('error', reject);
      tcp.listen(options.port ?? 0, bindHost, () => {
        tcp.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await close(tcp, sessions, sockets, client);
    throw error;
  }

  const address = tcp.address() as AddressInfo;
  return {
    recorder,
    address: `${formatHost(address.address)}:${address.port}`,
    close: () => close(tcp, sessions, sockets, client),
  };
}

/**
 * Decide which protocol a connection speaks before either server sees it.
 *
 * Read in paused mode and pushed back with `unshift`, so the bytes consumed to make the decision
 * are still there for the server that ends up handling the connection.
 */
function route(socket: Socket, http2: Http2Server, http1: Http1Server, warn: (message: string) => void): void {
  let buffered: Buffer = Buffer.alloc(0);

  const onError = (error: Error): void => warn(`connection: ${error.message}`);
  socket.on('error', onError);

  const onReadable = (): void => {
    const chunk = socket.read() as Buffer | null;
    if (chunk === null) return;
    buffered = Buffer.concat([buffered, chunk]);

    const shared = Math.min(buffered.length, HTTP2_PREFACE.length);
    const isHttp2 = buffered.subarray(0, shared).equals(HTTP2_PREFACE.subarray(0, shared));
    // Still a prefix of the preface and not yet complete: undecidable, so wait for more.
    if (isHttp2 && buffered.length < HTTP2_PREFACE.length) return;

    socket.removeListener('readable', onReadable);
    socket.removeListener('error', onError);
    socket.unshift(buffered);
    (isHttp2 ? http2 : http1).emit('connection', socket);
  };

  socket.on('readable', onReadable);
}

function proxyStream(
  stream: ServerHttp2Stream,
  headers: IncomingHttpHeaders,
  client: ClientHttp2Session,
  recorder: Recorder,
  warn: (message: string) => void,
): void {
  const path = String(headers[constants.HTTP2_HEADER_PATH] ?? '');
  const intent = classify(path);
  const encoding = String(headers['grpc-encoding'] ?? 'identity');

  // The upstream session is shared by every stream and outlives any one of them, so an emulator
  // that restarts, sends GOAWAY, or drops the connection leaves it closed. `request` then throws
  // synchronously, and this is an event handler: an escaping throw would take the recorder — and
  // with it the suite it is running — down over one stream. Fail the stream instead.
  //
  // The error listener goes on first, because failing the stream makes it emit `error`, and an
  // http2 stream with no listener for that throws out of the emit — the same crash, one step on.
  let upstream: ClientHttp2Stream | null = null;
  stream.on('error', () => upstream?.destroy());
  try {
    upstream = client.request(forwardable(headers));
  } catch (error) {
    warn(`stream ${path}: ${(error as Error).message}`);
    if (!stream.destroyed) stream.close(constants.NGHTTP2_INTERNAL_ERROR);
    return;
  }

  if (intent.kind === 'record') {
    collect(
      stream,
      (body) => recorder.recordRunQuery(body, encoding),
      () => recorder.skip('undecodable-message'),
    );
  } else if (intent.kind === 'skip') {
    // Counted once per invocation rather than per message: a Listen stream is one query-bearing
    // call however many messages it goes on to exchange.
    recorder.skip(intent.reason);
  }

  stream.pipe(upstream);

  let trailers: IncomingHttpHeaders | null = null;
  upstream.on('trailers', (received) => {
    trailers = received;
  });

  upstream.on('response', (responseHeaders) => {
    if (stream.destroyed) return;
    const outgoing = forwardable(responseHeaders);
    outgoing[constants.HTTP2_HEADER_STATUS] = responseHeaders[constants.HTTP2_HEADER_STATUS] ?? 200;

    // A gRPC error before any body is a trailers-only response: the status rides on the response
    // headers and no trailers follow. Asking to send trailers in that case would append a second,
    // conflicting status.
    if (responseHeaders['grpc-status'] !== undefined) {
      stream.respond(outgoing, { endStream: true });
      upstream.resume();
      return;
    }

    stream.respond(outgoing, { waitForTrailers: true });
    stream.on('wantTrailers', () => {
      stream.sendTrailers(
        trailers ?? {
          // Not a fabricated success: upstream ended without saying how it went, and gRPC UNKNOWN
          // (2) is what that is. Reporting OK here would turn a broken run into a passing one.
          'grpc-status': '2',
          'grpc-message': 'indexwright-record: upstream ended without a gRPC status',
        },
      );
    });
    upstream.pipe(stream);
  });

  upstream.on('error', (error) => {
    warn(`stream ${path}: ${error.message}`);
    if (!stream.destroyed) stream.close(constants.NGHTTP2_INTERNAL_ERROR);
  });
}

export type Intent =
  | { readonly kind: 'record' }
  | {
      readonly kind: 'skip';
      readonly reason: 'listen-query' | 'partition-query' | 'aggregation-query' | 'unsupported-rpc';
    }
  | { readonly kind: 'ignore' };

/** Route by `:path`, which is where a gRPC call says which method it is. */
export function classify(path: string): Intent {
  const match = /^\/([^/]+)\/([^/?]+)/.exec(path);
  if (match === null) return { kind: 'ignore' };
  const service = match[1];
  const method = match[2];
  if (service !== FIRESTORE_SERVICE || method === undefined) return { kind: 'ignore' };

  switch (method) {
    case 'RunQuery':
      return { kind: 'record' };
    case 'Listen':
      return { kind: 'skip', reason: 'listen-query' };
    case 'PartitionQuery':
      return { kind: 'skip', reason: 'partition-query' };
    case 'RunAggregationQuery':
      return { kind: 'skip', reason: 'aggregation-query' };
    default:
      if (NON_QUERY_METHODS.has(method)) return { kind: 'ignore' };
      return { kind: 'skip', reason: 'unsupported-rpc' };
  }
}

/**
 * Buffer a request body for inspection without holding the stream open or growing without bound.
 *
 * The bytes are forwarded by the pipe regardless; this only tees them.
 */
function collect(stream: ServerHttp2Stream, done: (body: Uint8Array) => void, tooLarge: () => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  stream.on('data', (chunk: Buffer) => {
    if (overflowed) return;
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) {
      overflowed = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  stream.on('end', () => {
    if (overflowed) tooLarge();
    else done(Buffer.concat(chunks));
  });
}

/** Hop-by-hop and connection-specific headers a proxy must not copy onto the next connection. */
const NOT_FORWARDED = new Set<string>([
  constants.HTTP2_HEADER_AUTHORITY,
  constants.HTTP2_HEADER_SCHEME,
  constants.HTTP2_HEADER_STATUS,
  'connection',
  'host',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
]);

function forwardable(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (NOT_FORWARDED.has(name) || value === undefined) continue;
    forwarded[name] = value;
  }
  // Carried across explicitly: it is a symbol key, so `Object.entries` does not see it, and losing
  // it makes a header the client marked sensitive eligible for HPACK indexing on a session shared
  // by every stream of the run.
  const sensitive = (headers as Record<symbol, unknown>)[sensitiveHeaders];
  if (Array.isArray(sensitive)) {
    const kept = (sensitive as string[]).filter(
      (name) => !NOT_FORWARDED.has(name) && forwarded[name] !== undefined,
    );
    if (kept.length > 0) (forwarded as Record<symbol, unknown>)[sensitiveHeaders] = kept;
  }
  return forwarded;
}

/** HTTP/1.1 is forwarded untouched: it carries no gRPC, so there is nothing here to decode. */
function proxyHttp1(
  request: IncomingMessage,
  response: ServerResponse,
  upstream: { host: string; port: number },
  warn: (message: string) => void,
): void {
  const headers = { ...request.headers };
  delete headers['host'];
  const forwarded = http1Request(
    { host: upstream.host, port: upstream.port, method: request.method, path: request.url, headers },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  forwarded.on('error', (error) => {
    warn(`http/1.1 ${request.url ?? ''}: ${error.message}`);
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  request.pipe(forwarded);
}

/** An IPv6 literal has to keep its brackets to survive being written back into `host:port`. */
function formatHost(host: string): string {
  return host.includes(':') ? `[${host}]` : host;
}

async function close(
  tcp: TcpServer,
  sessions: Set<Http2Session>,
  sockets: Set<Socket>,
  client: ClientHttp2Session,
): Promise<void> {
  client.close();
  const closed = new Promise<void>((resolve) => tcp.close(() => resolve()));
  for (const session of sessions) session.destroy();
  for (const socket of sockets) socket.destroy();
  await closed;
}
