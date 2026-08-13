/**
 * Constraining what the capture proxy binds to and connects to (issue #7).
 *
 * The v0.2 mechanism (SPEC §3) is a plaintext h2c pass-through in front of an emulator that performs
 * no authentication of its own. That makes both of its endpoints security-relevant, in different
 * ways:
 *
 * - **What it binds to.** Bound to a wildcard address on a shared CI runner or a laptop on an
 *   untrusted network, the proxy is an open, unauthenticated read/write channel into the emulator's
 *   dataset for anyone who can reach the port.
 * - **What it connects to.** Nothing makes the upstream actually be an emulator. A misconfigured
 *   `FIRESTORE_EMULATOR_HOST`, or a project seeded from production, routes real documents and gRPC
 *   `authorization` metadata through this process.
 *
 * The second is the one that arrives on its own. `FIRESTORE_EMULATOR_HOST` is read from the
 * environment, so a value nobody typed becomes the upstream — the same ambient-resolution problem
 * issue #8 rules out for `check`'s replay target, in the package that reads the environment first.
 *
 * Neither is hypothetical in the sense that matters: both are defaults, and defaults are what people
 * run. So the default is loopback at both ends and anything else has to be asked for, which is why
 * this module answers only *whether* an address is loopback and never resolves or connects to
 * anything. It holds no I/O, like `readiness.ts` and `reconcile.ts`, so the rule that decides whether
 * a run is allowed to start is testable without opening a socket.
 */

export class EndpointError extends Error {
  override readonly name = 'EndpointError';
}

/**
 * Split a `host:port` into its parts.
 *
 * Here rather than in `proxy.ts` because both the proxy and the argument parser need it, and the
 * parser refuses a non-loopback upstream before anything is started — so it has to read the host out
 * of the same string, with the same rules, or the two could disagree about what the host even is.
 */
export function parseHostPort(value: string): { host: string; port: number } {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) throw new Error(`expected host:port, got "${value}"`);
  const rawHost = value.slice(0, separator);
  // A bare IPv6 literal is all colons, so `lastIndexOf` would split it into a host of "::" and a
  // port of whatever followed the final colon. Brackets are what make the port unambiguous, and
  // an unbracketed literal is a usage error rather than an address to guess at.
  if (rawHost.includes(':') && !(rawHost.startsWith('[') && rawHost.endsWith(']'))) {
    throw new Error(`expected host:port with an IPv6 literal in brackets, got "${value}"`);
  }
  const host = rawHost.replace(/^\[|\]$/g, '');
  const port = Number(value.slice(separator + 1));
  if (!/^\d+$/.test(value.slice(separator + 1)) || port < 1 || port > 65535) {
    throw new Error(`expected host:port with a valid port, got "${value}"`);
  }
  return { host, port };
}

export type HostClass =
  /** Reachable only from this host. */
  | 'loopback'
  /** Every interface — the case that makes the proxy reachable from off the machine. */
  | 'wildcard'
  /** Anything else: a routable address, or a name this module will not resolve. */
  | 'remote';

/** Each octet of a dotted-quad, so `127.999.0.1` is not read as loopback. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Reduce a host to the form the tests below expect.
 *
 * Brackets, because an IPv6 literal may arrive still wearing them; a trailing dot, because
 * `localhost.` is the fully-qualified spelling of `localhost` and resolves the same; case, because
 * neither DNS names nor hex literals are case-sensitive.
 */
function normalise(host: string): string {
  return host.trim().replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

function isLoopbackIpv4(host: string): boolean {
  const octets = IPV4.exec(host);
  if (octets === null) return false;
  const values = octets.slice(1).map(Number);
  if (values.some((value) => value > 255)) return false;
  // The whole of 127.0.0.0/8, not just 127.0.0.1: every address in it is loopback, and 127.0.0.2 is
  // a real thing to bind to.
  return values[0] === 127;
}

export function classifyHost(host: string): HostClass {
  const value = normalise(host);

  // Trusted by convention rather than verified. `localhost` can be repointed in /etc/hosts, but
  // anyone who can edit that file already has more authority over this process than the proxy could
  // grant them, and refusing the name would reject the overwhelmingly common spelling of the safe
  // case — including this package's own default.
  if (value === 'localhost') return 'loopback';

  if (isLoopbackIpv4(value)) return 'loopback';
  // `::ffff:127.0.0.1` and `::ffff:7f00:1` are the same address wearing IPv4-mapped clothing.
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice('::ffff:'.length);
    if (isLoopbackIpv4(mapped)) return 'loopback';
    if (/^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(mapped)) return 'loopback';
  }
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return 'loopback';

  if (value === '0.0.0.0' || value === '::' || value === '0:0:0:0:0:0:0:0') return 'wildcard';

  return 'remote';
}

export function isLoopbackHost(host: string): boolean {
  return classifyHost(host) === 'loopback';
}

/** How the value being refused reached the process, which decides what the caller has to change. */
export type HostOrigin =
  /** Typed on the command line. */
  | { readonly kind: 'flag'; readonly option: string }
  /** Inherited from the environment, so possibly not known to the person running the command. */
  | { readonly kind: 'env'; readonly variable: string }
  /** Passed to the JavaScript API. */
  | { readonly kind: 'option'; readonly field: string };

export interface EndpointCheck {
  /** The host the decision is made on. */
  readonly host: string;
  /**
   * What the origin literally holds, when that is more than the host.
   *
   * An `--emulator` or a `FIRESTORE_EMULATOR_HOST` holds `host:port`, so a message quoting only the
   * host would be saying something untrue about what the variable contains — and the reader's next
   * move is to go and look at it.
   */
  readonly value?: string;
  readonly origin: HostOrigin;
  /** What the caller would pass to permit this, quoted back to them verbatim. */
  readonly override: string;
  readonly allowed?: boolean;
}

/** `<origin> "<value>"`, naming the host separately when the value is more than the host. */
function describe({ host, value, origin }: EndpointCheck): string {
  const held = value ?? host;
  const verb =
    origin.kind === 'flag'
      ? `${origin.option} was given`
      : origin.kind === 'env'
        ? `${origin.variable} is set to`
        : `${origin.field} was passed`;
  const where = `${verb} "${held}"`;
  return held === host ? where : `${where}, whose host "${host}" is not on this machine`;
}

/**
 * Refuse a non-loopback upstream, naming where the value came from.
 *
 * The provenance is in the message because the dangerous case is the one nobody typed: a run that
 * inherits `FIRESTORE_EMULATOR_HOST` from a shell profile or a CI environment looks, from the
 * command line, exactly like a run against the default. Being told which variable is responsible is
 * the difference between fixing it and adding the override.
 */
export function requireLoopbackUpstream(check: EndpointCheck): void {
  if (check.allowed === true || isLoopbackHost(check.host)) return;
  throw new EndpointError(
    `refusing to forward to a non-loopback emulator: ${describe(check)}. ` +
      'The capture proxy performs no authentication and forwards every request verbatim, so a ' +
      'non-loopback upstream routes whatever documents and credentials it holds through this ' +
      `process. Point it at an emulator on this host, or pass ${check.override} if that is what ` +
      'you mean.',
  );
}

/**
 * Refuse a bind address the proxy would be reachable from off the machine at.
 *
 * `wildcard` is called out separately because it is the case that is easy to reach by habit — it is
 * what a container image or a compose file usually wants — and the consequence is the strongest one
 * in this module: an open, unauthenticated channel into the emulator's dataset.
 */
export function requireLoopbackBind(check: EndpointCheck): void {
  const classified = classifyHost(check.host);
  if (check.allowed === true || classified === 'loopback') return;
  const consequence =
    classified === 'wildcard'
      ? 'binding every interface makes the emulator readable and writable by anyone who can reach ' +
        'the port'
      : 'binding a routable address makes the emulator readable and writable from off this host';
  throw new EndpointError(
    `refusing to bind a non-loopback address: ${describe(check)}. ` +
      `The capture proxy performs no authentication of its own, so ${consequence}. ` +
      `Leave it on loopback, or pass ${check.override} if that is what you mean.`,
  );
}
