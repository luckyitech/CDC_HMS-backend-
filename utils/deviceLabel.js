// A short, human label for the browser a request came from — "iPhone · Safari",
// "Windows · Edge". Shared by remembered phones (HR Suite, B21) and the
// sign-in record (16 Oct 2026), so both name a device the same way. A label,
// not an identity: two Windows PCs running Chrome read the same.

const osOf = (ua) => {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Linux/.test(ua)) return 'Linux';
  return null;
};

const browserOf = (ua) => {
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
  if (/FxiOS|Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return null;
};

/** User-Agent → "OS · Browser". `fallbackOs` names an unrecognised system. */
const deviceLabel = (ua = '', fallbackOs = 'Unknown device') => {
  const text = String(ua || '');
  return `${osOf(text) || fallbackOs} · ${browserOf(text) || 'browser'}`;
};

module.exports = { deviceLabel };
