// Staff photos (2 Oct 2026, B27 debt). ONE place a photo is set, cleared and
// streamed — used by the staff file (HR, users.write) and My profile (the
// person, decision D11: saved directly, logged).
//
// StaffProfile.photoUrl holds the stored file NAME in private/staff-photos/
// (the column predates this; it was never written by any screen). Only the
// name is trusted — utils/staffDocumentStorage.resolveStoredPhoto joins it onto
// the private folder, so a tampered value cannot point anywhere else.

const fs = require('fs');
const { resolveStoredPhoto } = require('../utils/staffDocumentStorage');
const { error } = require('../utils/response');
const db = require('../models');
const sequelize = require('../config/database');

const { UserEditLog } = db;

const fullName = (u) => (u ? `${u.firstName} ${u.lastName}`.trim() : '');

const removeFile = (name) => {
  const old = resolveStoredPhoto(name);
  if (old) fs.promises.unlink(old).catch(() => {});
};

/**
 * Set (file) or clear (file = null) a person's photo, with a UserEditLog row.
 * @param {object} profile   StaffProfile (with .User)
 * @param {object|null} file multer file
 * @param {object} actor     { id, firstName, lastName }
 * @param {boolean} self     the person is changing their own
 */
const savePhoto = async ({ profile, file, actor, self }) => {
  const before = profile.photoUrl || null;
  const next = file ? file.filename : null;
  await sequelize.transaction(async (t) => {
    await profile.update({ photoUrl: next, updatedBy: actor.id }, { transaction: t });
    await UserEditLog.create({
      targetUserId: profile.UserId,
      editedBy: actor.id,
      editedByName: self ? `${fullName(actor)} (themselves)` : fullName(actor),
      changes: { photo: { from: before ? 'photo' : null, to: next ? 'new photo' : null } },
      editedAt: new Date(),
    }, { transaction: t });
  });
  if (before && before !== next) removeFile(before);
  return { hasPhoto: !!next };
};

/** Stream the photo, or 404. Private cache: it is behind a login. */
const sendPhoto = (res, profile) => {
  const resolved = profile?.photoUrl ? resolveStoredPhoto(profile.photoUrl) : null;
  if (!resolved) return error(res, 'No photo', 404);
  res.set('Cache-Control', 'private, max-age=300');
  return res.sendFile(resolved);
};

module.exports = { savePhoto, sendPhoto, removeFile };
