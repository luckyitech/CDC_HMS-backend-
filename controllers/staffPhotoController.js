// Staff photos (2 Oct 2026, B27 debt). The staff file (HR) and My profile
// (the person, D11 — saved directly, logged). services/staffPhoto does the work.
//
//   GET    /api/staff/:employeeId/photo   users.view, hr.view, or the person
//   PUT    /api/staff/:employeeId/photo   users.write (multipart 'photo')
//   DELETE /api/staff/:employeeId/photo   users.write
//   GET    /api/hr/me/photo               the person (SELF)
//   PUT    /api/hr/me/photo               the person (SELF)
//   DELETE /api/hr/me/photo               the person (SELF)

const { success, error } = require('../utils/response');
const { savePhoto, sendPhoto, removeFile } = require('../services/staffPhoto');
const db = require('../models');

const { StaffProfile, User } = db;

const actorOf = (req) => User.findByPk(req.user.id, { attributes: ['id', 'firstName', 'lastName'] });
const mine = (req) => StaffProfile.findOne({ where: { UserId: req.user.id } });

const staffGet = async (req, res) => {
  try {
    return sendPhoto(res, req.staffProfile);
  } catch (err) {
    console.error('StaffPhoto.get error:', err);
    return error(res, 'Failed to load the photo', 500);
  }
};

const staffPut = async (req, res) => {
  if (!req.file) return error(res, 'Choose a photo', 400);
  try {
    if (req.staffProfile.deletedAt) { removeFile(req.file.filename); return error(res, 'That staff file is archived', 409); }
    return success(res, await savePhoto({ profile: req.staffProfile, file: req.file, actor: await actorOf(req), self: req.staffUser.id === req.user.id }));
  } catch (err) {
    removeFile(req.file.filename);
    console.error('StaffPhoto.put error:', err);
    return error(res, 'Failed to save the photo', 500);
  }
};

const staffDelete = async (req, res) => {
  try {
    if (!req.staffProfile.photoUrl) return error(res, 'There is no photo to remove', 400);
    return success(res, await savePhoto({ profile: req.staffProfile, file: null, actor: await actorOf(req), self: req.staffUser.id === req.user.id }));
  } catch (err) {
    console.error('StaffPhoto.delete error:', err);
    return error(res, 'Failed to remove the photo', 500);
  }
};

const selfGet = async (req, res) => {
  try {
    return sendPhoto(res, await mine(req));
  } catch (err) {
    console.error('StaffPhoto.selfGet error:', err);
    return error(res, 'Failed to load your photo', 500);
  }
};

const selfPut = async (req, res) => {
  if (!req.file) return error(res, 'Choose a photo', 400);
  try {
    const profile = await mine(req);
    if (!profile || profile.deletedAt) {
      removeFile(req.file.filename);
      return error(res, 'You don\'t have a staff file yet', 404, { code: 'NO_STAFF_FILE' });
    }
    return success(res, await savePhoto({ profile, file: req.file, actor: await actorOf(req), self: true }));
  } catch (err) {
    removeFile(req.file.filename);
    console.error('StaffPhoto.selfPut error:', err);
    return error(res, 'Failed to save your photo', 500);
  }
};

const selfDelete = async (req, res) => {
  try {
    const profile = await mine(req);
    if (!profile || !profile.photoUrl) return error(res, 'There is no photo to remove', 400);
    return success(res, await savePhoto({ profile, file: null, actor: await actorOf(req), self: true }));
  } catch (err) {
    console.error('StaffPhoto.selfDelete error:', err);
    return error(res, 'Failed to remove your photo', 500);
  }
};

module.exports = { staffGet, staffPut, staffDelete, selfGet, selfPut, selfDelete };
