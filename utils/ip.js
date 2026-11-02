// =====================================================================
// Client IP addresses — one place that decides what a request's address is,
// whether it is the clinic's own network, and whether it is worth looking up.
// Pure apart from reading req. Sign-in tracking (16 Oct 2026).
//
// WHY req.ip AND NOT X-Forwarded-For[0]
//   app.js sets `trust proxy` to 1: IIS (ARR) is the one proxy in front of
//   Node, and it APPENDS the address it saw to X-Forwarded-For. Express then
//   takes the right-most entry as req.ip. The LEFT-most entry is whatever the
//   browser sent — anyone can put any address there — so reading [0] (as the
//   login code used to) let a caller choose the address recorded against their
//   sign-in. IIS also writes the client as "a.b.c.d:port"; cleanIp drops it.
//
// The clinic's networks are a list of addresses and IPv4/IPv6 ranges the
// admin enters (Settings → Sign-in security). node:net's BlockList does the
// range maths — no package.
// =====================================================================

const net = require('node:net');

/** "::ffff:1.2.3.4", "1.2.3.4:5678", "[2001:db8::1]:443" → a bare address, or null. */
const cleanIp = (raw) => {
  if (raw == null) return null;
  let ip = String(raw).trim();
  if (!ip) return null;
  if (ip.includes(',')) ip = ip.split(',').pop().trim();       // a stray list: the right-most hop
  const bracketed = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) ip = bracketed[1];
  ip = ip.replace(/^::ffff:/i, '');
  const v4port = ip.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4port) ip = v4port[1];
  ip = ip.replace(/%.*$/, '');                                  // fe80::1%eth0 → fe80::1
  return net.isIP(ip) ? ip.toLowerCase() : null;
};

/** The address this request came from, as trusted by the proxy setting. */
const clientIp = (req) => cleanIp(req?.ip) || cleanIp(req?.socket?.remoteAddress);

const familyOf = (ip) => (net.isIPv6(ip) ? 'ipv6' : 'ipv4');

/**
 * One clinic-network entry as typed: "197.248.95.205", "197.248.95.0/24",
 * "2001:db8::/48". Returns { address, prefix|null, family } or null.
 */
const parseNetwork = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  const [addrRaw, prefixRaw, extra] = text.split('/');
  if (extra !== undefined) return null;
  const address = cleanIp(addrRaw);
  if (!address) return null;
  const family = familyOf(address);
  if (prefixRaw === undefined) return { address, prefix: null, family };
  if (!/^\d{1,3}$/.test(prefixRaw)) return null;
  const prefix = Number(prefixRaw);
  if (prefix < 0 || prefix > (family === 'ipv6' ? 128 : 32)) return null;
  return { address, prefix, family };
};

/** "a.b.c.d" or "a.b.c.d/nn" — the canonical text stored for an entry. */
const formatNetwork = (n) => (n.prefix == null ? n.address : `${n.address}/${n.prefix}`);

/**
 * Which of the clinic's networks (each { value, label }) this address falls in.
 * Returns that entry, or null.
 */
const matchNetwork = (ip, networks = []) => {
  const address = cleanIp(ip);
  if (!address) return null;
  const family = familyOf(address);
  for (const entry of networks) {
    const n = parseNetwork(entry?.value);
    if (!n || n.family !== family) continue;
    const list = new net.BlockList();
    if (n.prefix == null) list.addAddress(n.address, n.family);
    else list.addSubnet(n.address, n.prefix, n.family);
    if (list.check(address, family)) return entry;
  }
  return null;
};

// Addresses no lookup service can place: private LANs, loopback, link-local,
// carrier-grade NAT, documentation ranges. A sign-in from one of these came
// from inside some network the server can see directly.
const NOT_PUBLIC = (() => {
  const list = new net.BlockList();
  [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['100.64.0.0', 10], ['0.0.0.0', 8], ['192.0.2.0', 24],
    ['198.51.100.0', 24], ['203.0.113.0', 24]].forEach(([a, p]) => list.addSubnet(a, p, 'ipv4'));
  [['fc00::', 7], ['fe80::', 10], ['2001:db8::', 32]].forEach(([a, p]) => list.addSubnet(a, p, 'ipv6'));
  list.addAddress('::1', 'ipv6');
  list.addAddress('::', 'ipv6');
  return list;
})();

const isPublicIp = (ip) => {
  const address = cleanIp(ip);
  if (!address) return false;
  return !NOT_PUBLIC.check(address, familyOf(address));
};

module.exports = { cleanIp, clientIp, parseNetwork, formatNetwork, matchNetwork, isPublicIp };
