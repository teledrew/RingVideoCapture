/**
 * IP address matching for the web UI's trusted-network check.
 *
 * Kept separate from server.js so the CIDR logic can be unit tested directly —
 * an off-by-one in a prefix comparison is an authentication bypass, not a
 * cosmetic bug, so it deserves tests that do not need an HTTP server.
 */

/** Parses an IPv4 dotted quad into 4 bytes, or null if it is not one. */
const parseIpv4 = (value) => {
  const parts = value.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const bytes = [];
  for (const part of parts) {
    // Reject empty, non-numeric, and zero-padded forms ("01"), which some
    // parsers read as octal — a classic way to sneak past an address filter.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) {
      return null;
    }
    const byte = Number(part);
    if (byte > 255) {
      return null;
    }
    bytes.push(byte);
  }

  return Uint8Array.from(bytes);
};

/**
 * Parses an address into its raw bytes: 4 for IPv4, 16 for IPv6.
 *
 * IPv4-mapped IPv6 (`::ffff:192.168.1.5`) is normalised to plain IPv4, because
 * that is how a dual-stack Node server reports IPv4 clients and we want one
 * rule set rather than two.
 */
export const parseIp = (input) => {
  if (typeof input !== 'string' || input === '') {
    return null;
  }

  // Strip a link-local zone index, e.g. "fe80::1%eth0".
  const value = input.split('%')[0];

  if (!value.includes(':')) {
    return parseIpv4(value);
  }

  // IPv4-mapped or IPv4-compatible: take the trailing dotted quad.
  const mapped = /^::(?:ffff:)?((?:\d{1,3}\.){3}\d{1,3})$/i.exec(value);
  if (mapped) {
    return parseIpv4(mapped[1]);
  }

  const [head, tail, ...extra] = value.split('::');
  if (extra.length > 0) {
    return null;
  }

  const toGroups = (section) => (section === '' ? [] : section.split(':'));
  const headGroups = toGroups(head);
  const tailGroups = tail === undefined ? [] : toGroups(tail);

  // A trailing dotted quad inside a longer IPv6 address occupies two groups.
  const expandTrailingIpv4 = (groups) => {
    if (groups.length === 0) {
      return groups;
    }
    const last = groups.at(-1);
    if (!last.includes('.')) {
      return groups;
    }
    const quad = parseIpv4(last);
    if (!quad) {
      return null;
    }
    const hex = (a, b) => ((a << 8) | b).toString(16);
    return [...groups.slice(0, -1), hex(quad[0], quad[1]), hex(quad[2], quad[3])];
  };

  const head2 = expandTrailingIpv4(headGroups);
  const tail2 = expandTrailingIpv4(tailGroups);
  if (!head2 || !tail2) {
    return null;
  }

  const missing = 8 - (head2.length + tail2.length);
  if (tail === undefined) {
    // No "::" present, so the address must be fully written out.
    if (missing !== 0) {
      return null;
    }
  } else if (missing < 1) {
    // "::" must stand for at least one group.
    return null;
  }

  const groups = [...head2, ...Array.from({ length: Math.max(missing, 0) }, () => '0'), ...tail2];
  if (groups.length !== 8) {
    return null;
  }

  const bytes = new Uint8Array(16);
  for (const [index, group] of groups.entries()) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) {
      return null;
    }
    const word = Number.parseInt(group, 16);
    bytes[index * 2] = word >> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }

  return bytes;
};

/** Parses "192.168.0.0/16" into comparable bytes plus a prefix length. */
export const parseCidr = (input) => {
  const [address, rawPrefix, ...extra] = String(input).trim().split('/');
  if (extra.length > 0) {
    return null;
  }

  const bytes = parseIp(address);
  if (!bytes) {
    return null;
  }

  const maxPrefix = bytes.length * 8;
  if (rawPrefix === undefined) {
    // A bare address is a single host.
    return { bytes, prefix: maxPrefix };
  }

  if (!/^\d{1,3}$/.test(rawPrefix)) {
    return null;
  }
  const prefix = Number(rawPrefix);
  if (prefix > maxPrefix) {
    return null;
  }

  return { bytes, prefix };
};

/** True if `address` falls inside `cidr`. Mixed address families never match. */
export const ipInCidr = (address, cidr) => {
  const ip = parseIp(address);
  if (!ip || !cidr || ip.length !== cidr.bytes.length) {
    return false;
  }

  const wholeBytes = cidr.prefix >> 3;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (ip[index] !== cidr.bytes[index]) {
      return false;
    }
  }

  const remainingBits = cidr.prefix & 7;
  if (remainingBits === 0) {
    return true;
  }

  const mask = 0xff << (8 - remainingBits) & 0xff;
  return (ip[wholeBytes] & mask) === (cidr.bytes[wholeBytes] & mask);
};

/**
 * Private/link-local ranges, used as the default trusted set.
 *
 * Deliberately excludes 172.16.0.0/12 by default. That range contains Docker's
 * own bridge networks, and if the container sees connections as coming from the
 * bridge gateway (rather than the real client) then trusting it would exempt
 * *every* request from authentication, including one arriving from the internet
 * through a port forward. Add it explicitly only if you know your setup
 * preserves the original source address.
 */
export const DEFAULT_TRUSTED_NETWORKS = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '192.168.0.0/16',
  '169.254.0.0/16',
  'fe80::/10',
  'fc00::/7',
];
