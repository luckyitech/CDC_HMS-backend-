// HR Suite (B21) — entrance tags. Keys are write-once: generated or pasted at
// registration, encrypted with utils/crypto.js, never echoed back.
const db = require('../models');
const { success, error } = require('../utils/response');
const { encrypt, decrypt } = require('../utils/crypto');
const { verifySun, parseTapUrl, generateTagKey } = require('../utils/ntag424');
const { recordSettingChanges } = require('../services/settingChangeLog');

const { HrNfcTag, User } = db;

const PUBLIC = { exclude: ['keyEncrypted'] };
const HEX = (n) => new RegExp(`^[0-9A-Fa-f]{${n}}$`);

const serialize = (t) => ({
  id: t.id, uid: t.uid, label: t.label, location: t.location, lastCounter: t.lastCounter, lastTapAt: t.lastTapAt,
  status: t.status, retiredAt: t.retiredAt, notes: t.notes, createdAt: t.createdAt,
  createdBy: t.createdBy ? `${t.createdBy.firstName} ${t.createdBy.lastName}` : null,
});

const list = async (req, res) => {
  try {
    const rows = await HrNfcTag.findAll({ attributes: PUBLIC, include: [{ model: User, as: 'createdBy', attributes: ['firstName', 'lastName'] }], order: [['status', 'ASC'], ['label', 'ASC']] });
    return success(res, rows.map(serialize));
  } catch (err) {
    console.error('HrNfcTag.list error:', err);
    return error(res, 'Failed to load tags', 500);
  }
};

/** GET /api/hr/tags/new-key — a fresh 32-hex K1, shown once by the UI. */
const newKey = async (req, res) => {
  try { return success(res, { key: generateTagKey() }); } catch (err) {
    console.error('HrNfcTag.newKey error:', err);
    return error(res, 'Failed to generate a key', 500);
  }
};

const create = async (req, res) => {
  try {
    const uid = String(req.body.uid || '').toUpperCase().trim();
    const key = String(req.body.key || '').toUpperCase().trim();
    const label = String(req.body.label || '').trim();
    if (!HEX(14).test(uid)) return error(res, 'The tag UID must be 14 hex characters', 400);
    if (!HEX(32).test(key)) return error(res, 'The tag key must be 32 hex characters', 400);
    if (!label) return error(res, 'A label is required', 400);
    if (await HrNfcTag.findOne({ where: { uid } })) return error(res, 'A tag with that UID is already registered', 409);
    const tag = await HrNfcTag.create({
      uid, label, location: req.body.location ? String(req.body.location).trim() : null,
      keyEncrypted: encrypt(key), notes: req.body.notes ? String(req.body.notes).trim() : null,
      status: 'active', createdById: req.user.id,
    });
    recordSettingChanges({ user: req.user, area: 'HR Suite', before: {}, after: { tag: `${label} (${uid})`, tagKey: 'set' }, secretsChanged: ['tagKey'],
      fields: { tag: { key: 'hr.tags', label: 'Entrance tag registered' }, tagKey: { key: `hr.tags.${uid}.key`, label: `Tag key (${label})` } } });
    const full = await HrNfcTag.findByPk(tag.id, { attributes: PUBLIC });
    return success(res, serialize(full), 201);
  } catch (err) {
    console.error('HrNfcTag.create error:', err);
    return error(res, 'Failed to register the tag', 500);
  }
};

/** PATCH /api/hr/tags/:id — relabel, move, retire or reactivate. Never the key. */
const update = async (req, res) => {
  try {
    const tag = await HrNfcTag.findByPk(req.params.id, { attributes: PUBLIC });
    if (!tag) return error(res, 'Tag not found', 404);
    const before = { label: tag.label, location: tag.location, status: tag.status, notes: tag.notes };
    const changes = {};
    if (req.body.label !== undefined) { const l = String(req.body.label).trim(); if (!l) return error(res, 'A label is required', 400); changes.label = l; }
    if (req.body.location !== undefined) changes.location = req.body.location ? String(req.body.location).trim() : null;
    if (req.body.notes !== undefined) changes.notes = req.body.notes ? String(req.body.notes).trim() : null;
    if (req.body.status !== undefined) {
      if (!['active', 'retired'].includes(req.body.status)) return error(res, 'Status must be active or retired', 400);
      changes.status = req.body.status;
      changes.retiredAt = req.body.status === 'retired' ? new Date() : null;
      changes.retiredById = req.body.status === 'retired' ? req.user.id : null;
    }
    if (!Object.keys(changes).length) return error(res, 'Nothing to update', 400);
    await tag.update(changes);
    recordSettingChanges({ user: req.user, area: 'HR Suite', before, after: { label: tag.label, location: tag.location, status: tag.status, notes: tag.notes },
      fields: { label: { key: `hr.tags.${tag.uid}.label`, label: `Tag label (${tag.uid})` }, location: { key: `hr.tags.${tag.uid}.location`, label: `Tag location (${tag.uid})` },
        status: { key: `hr.tags.${tag.uid}.status`, label: `Tag status (${tag.label})` }, notes: { key: `hr.tags.${tag.uid}.notes`, label: `Tag notes (${tag.label})` } } });
    return success(res, serialize(tag));
  } catch (err) {
    console.error('HrNfcTag.update error:', err);
    return error(res, 'Failed to update the tag', 500);
  }
};

/**
 * POST /api/hr/tags/:id/test { url } — verify a real tap URL against the
 * stored key WITHOUT advancing the counter. Tells the admin whether the tag
 * was keyed correctly before it is mounted.
 */
const test = async (req, res) => {
  try {
    const tag = await HrNfcTag.findByPk(req.params.id);
    if (!tag) return error(res, 'Tag not found', 404);
    const p = parseTapUrl(req.body.url);
    if (!p) return error(res, 'That is not a tap URL — it needs uid, ctr and cmac', 400);
    if (p.uid !== tag.uid) return success(res, { ok: false, reason: 'different_tag', counter: null, message: `That URL came from tag ${p.uid}, not this one (${tag.uid}).` });
    const v = verifySun({ uidHex: p.uid, ctrHex: p.ctr, cmacHex: p.cmac, keyHex: decrypt(tag.keyEncrypted) });
    const replay = v.ok && v.counter <= tag.lastCounter;
    return success(res, {
      ok: v.ok, counter: v.counter, lastCounter: tag.lastCounter, replay,
      reason: v.ok ? (replay ? 'replayed_counter' : null) : v.reason,
      message: v.ok
        ? (replay ? `Signature is genuine but counter ${v.counter} has already been used (last seen ${tag.lastCounter}) — a real tap will refuse it.` : `Genuine tap from "${tag.label}", counter ${v.counter}. The tag is keyed correctly.`)
        : 'The signature does not match this tag\'s key. Check the key written into the tag (Key 1 / SDM file-read key) and the SDM settings.',
    });
  } catch (err) {
    console.error('HrNfcTag.test error:', err);
    return error(res, 'Failed to test the URL', 500);
  }
};

module.exports = { list, newKey, create, update, test };
