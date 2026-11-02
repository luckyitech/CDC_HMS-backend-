// =====================================================================
// Approximate place of an outside IP address — country, region, town and
// network operator. Sign-in tracking (16 Oct 2026).
//
// Only ever called for an address that is public and NOT one of the clinic's
// networks, and only when the clinic has switched lookup on (Settings →
// Sign-in security). Each address is sent out ONCE: the answer, or the fact
// that the lookup failed, is kept in IpLocations. Nothing but the bare IP
// address leaves the server — no name, no account, no time.
//
// Accuracy: country is reliable; the town is a guess (mobile-data addresses in
// Kenya usually place in Nairobi wherever the phone is). The screens say so.
//
// Built-in fetch, no package. A slow or failing service never delays or fails
// a sign-in: this runs after the sign-in has been answered.
// =====================================================================

const db = require('../models');
const { isPublicIp, cleanIp } = require('../utils/ip');

const { IpLocation } = db;

const TIMEOUT_MS = 5000;
const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n));

/** Provider → { url, parse(json) → place | null }. Exported for the tests. */
const PROVIDERS = {
  // ipapi.co — no key; returns { error: true, reason } when it cannot answer.
  ipapi: {
    url: (ip) => `https://ipapi.co/${encodeURIComponent(ip)}/json/`,
    parse: (j) => (!j || j.error ? null : {
      countryCode: clip(j.country_code || j.country, 2),
      country: clip(j.country_name, 80),
      region: clip(j.region, 100),
      city: clip(j.city, 100),
      isp: clip(j.org, 150),
    }),
  },
  // ipinfo.io with the clinic's token. Its full API gives city/region/org;
  // the free "Lite" answer gives country and network only — both read here.
  ipinfo: {
    url: (ip, token) => `https://ipinfo.io/${encodeURIComponent(ip)}/json${token ? `?token=${encodeURIComponent(token)}` : ''}`,
    parse: (j) => {
      if (!j || j.error || j.bogon) return null;
      const code = j.country_code || (typeof j.country === 'string' && j.country.length === 2 ? j.country : null);
      const name = j.country_code ? j.country : (j.country_name || null);
      return {
        countryCode: clip(code, 2),
        country: clip(name, 80),
        region: clip(j.region, 100),
        city: clip(j.city, 100),
        isp: clip(j.as_name || (j.org ? String(j.org).replace(/^AS\d+\s+/, '') : null), 150),
      };
    },
  },
};

const fetchPlace = async (ip, provider, token) => {
  const p = PROVIDERS[provider];
  if (!p) return null;
  const res = await fetch(p.url(ip, token), {
    headers: { Accept: 'application/json', 'User-Agent': 'CDC-HMS' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`lookup ${provider} answered ${res.status}`);
  return p.parse(await res.json());
};

/**
 * The place for an address, from the cache or (once) the service.
 * Never throws. Returns { countryCode, country, region, city, isp } or null.
 */
const lookupIp = async (rawIp, { provider = 'ipapi', token = null } = {}) => {
  const ip = cleanIp(rawIp);
  if (!ip || !isPublicIp(ip)) return null;
  try {
    const known = await IpLocation.findOne({ where: { ip } });
    if (known) return known.status === 'ok' ? known.get({ plain: true }) : null;

    let place = null;
    try {
      place = await fetchPlace(ip, provider, token);
    } catch (err) {
      console.error('IpLookup.fetch error:', err.message);   // the address is not logged
      return null;                                         // not cached: a later sign-in retries
    }
    // Only a real answer is kept. A provider that could not place the address
    // (or was rate-limited) is asked again at a later sign-in.
    if (!place || !(place.countryCode || place.city)) return null;
    try {
      const row = await IpLocation.create({ ip, provider, lookedUpAt: new Date(), status: 'ok', ...place });
      return row.get({ plain: true });
    } catch (err) {
      if (err.name !== 'SequelizeUniqueConstraintError') throw err;
      const known = await IpLocation.findOne({ where: { ip } });     // a simultaneous sign-in stored it first
      return known && known.status === 'ok' ? known.get({ plain: true }) : place;
    }
  } catch (err) {
    console.error('IpLookup error:', err.message);
    return null;
  }
};

module.exports = { lookupIp, PROVIDERS };
