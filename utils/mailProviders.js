// ---------------------------------------------------------------------------
// Mail provider presets — Staff Email (B26).
//
// Staff never see server settings: an admin maps each allowed domain to a
// preset (System Settings → Email), and the preset supplies IMAP/SMTP. Adding
// a provider for another clinic is one entry here. 'custom' takes the servers
// the admin typed for that domain.
//
// Only password auth exists today. Microsoft 365 and Google increasingly
// refuse password IMAP; supporting them means an OAuth sign-in (authType
// 'oauth' is already a column) — deliberately not listed as presets until
// that exists, so nobody picks one and gets a confusing failure.
// ---------------------------------------------------------------------------

const PROVIDERS = {
  onecom: {
    label: 'one.com',
    imap: { host: 'imap.one.com', port: 993, secure: true },
    // The one.com control panel lists 465 (SSL). 587 STARTTLS also works.
    smtp: { host: 'send.one.com', port: 465, secure: true },
  },
  custom: {
    label: 'Custom servers',
    imap: null,
    smtp: null,
  },
};

const PROVIDER_KEYS = Object.keys(PROVIDERS);

const isValidHost = (h) => typeof h === 'string' && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h.trim());
const isValidPort = (p) => Number.isInteger(Number(p)) && Number(p) > 0 && Number(p) < 65536;

/**
 * The IMAP + SMTP servers for one domain entry
 * ({ domain, provider, imapHost?, imapPort?, imapSecure?, smtpHost?, smtpPort?, smtpSecure? }).
 * Returns null when a custom entry is incomplete.
 */
const serversFor = (entry) => {
  if (!entry) return null;
  const preset = PROVIDERS[entry.provider];
  if (preset && preset.imap && preset.smtp) {
    return { provider: entry.provider, imap: { ...preset.imap }, smtp: { ...preset.smtp } };
  }
  if (entry.provider === 'custom'
    && isValidHost(entry.imapHost) && isValidPort(entry.imapPort)
    && isValidHost(entry.smtpHost) && isValidPort(entry.smtpPort)) {
    return {
      provider: 'custom',
      imap: { host: entry.imapHost.trim(), port: Number(entry.imapPort), secure: entry.imapSecure !== false },
      smtp: { host: entry.smtpHost.trim(), port: Number(entry.smtpPort), secure: entry.smtpSecure !== false },
    };
  }
  return null;
};

const publicProviders = () => PROVIDER_KEYS.map((key) => ({
  key,
  label: PROVIDERS[key].label,
  imap: PROVIDERS[key].imap,
  smtp: PROVIDERS[key].smtp,
}));

module.exports = { PROVIDERS, PROVIDER_KEYS, serversFor, publicProviders, isValidHost, isValidPort };
