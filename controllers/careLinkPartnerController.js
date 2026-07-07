const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { resolvePatient } = require('../utils/patientFamily');
const db = require('../models');

const { CareLinkPartner, User } = db;

// ── Helpers ───────────────────────────────────────────────────────────────────

const userInclude = {
  model:      User,
  as:         'addedByUser',
  attributes: ['firstName', 'lastName'],
  foreignKey: 'addedBy',
};

const formatPartner = (p) => ({
  id:           p.id,
  firstName:    p.firstName,
  lastName:     p.lastName,
  email:        p.email,
  relationship: p.relationship,
  phone:        p.phone,
  addedBy:      p.addedByUser ? `${p.addedByUser.firstName} ${p.addedByUser.lastName}` : null,
  addedDate:    p.addedDate,
});

// ── Controller actions ────────────────────────────────────────────────────────

// GET /api/patients/:uhid/carelink-partners
const getAll = async (req, res) => {
  const { uhid } = req.params;
  try {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);

    const partners = await CareLinkPartner.findAll({
      where:   { PatientId: { [Op.in]: family.patientIds }, isActive: true },
      include: [userInclude],
      order:   [['addedDate', 'ASC']],
    });

    return success(res, { partners: partners.map(formatPartner) });
  } catch (err) {
    console.error('CareLink partners GET error:', err.message);
    return error(res, 'Failed to retrieve CareLink partners. Please try again.', 500);
  }
};

// POST /api/patients/:uhid/carelink-partners
const add = async (req, res) => {
  const { uhid } = req.params;
  const { firstName, lastName, email, relationship, phone } = req.body;

  try {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. No new CareLink partners can be added.', 403);

    const partner = await CareLinkPartner.create({
      PatientId:    family.patient.id,
      firstName,
      lastName,
      email,
      relationship,
      phone:        phone || null,
      addedBy:      req.user.id,
      addedDate:    new Date(),
    });

    const full = await CareLinkPartner.findByPk(partner.id, { include: [userInclude] });
    return success(res, { partner: formatPartner(full) }, 201);
  } catch (err) {
    console.error('CareLink partner ADD error:', err.message);
    return error(res, 'Failed to add CareLink partner. Please try again.', 500);
  }
};

// PUT /api/patients/:uhid/carelink-partners/:id
const update = async (req, res) => {
  const { uhid, id } = req.params;
  const { firstName, lastName, email, relationship, phone } = req.body;

  try {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. CareLink partners cannot be modified.', 403);

    const partner = await CareLinkPartner.findOne({
      where: { id, PatientId: { [Op.in]: family.patientIds } },
    });
    if (!partner) return error(res, 'CareLink partner not found', 404);

    const updateData = {};
    if (firstName    !== undefined) updateData.firstName    = firstName;
    if (lastName     !== undefined) updateData.lastName     = lastName;
    if (email        !== undefined) updateData.email        = email;
    if (relationship !== undefined) updateData.relationship = relationship;
    if (phone        !== undefined) updateData.phone        = phone || null;

    await partner.update(updateData);

    const full = await CareLinkPartner.findByPk(partner.id, { include: [userInclude] });
    return success(res, { partner: formatPartner(full) });
  } catch (err) {
    console.error('CareLink partner UPDATE error:', err.message);
    return error(res, 'Failed to update CareLink partner. Please try again.', 500);
  }
};

// DELETE /api/patients/:uhid/carelink-partners/:id
const remove = async (req, res) => {
  const { uhid, id } = req.params;

  try {
    const family = await resolvePatient(uhid);
    if (!family) return error(res, 'Patient not found', 404);
    if (family.isDeactivated) return error(res, 'This patient profile is inactive. CareLink partners cannot be removed.', 403);

    const partner = await CareLinkPartner.findOne({
      where: { id, PatientId: { [Op.in]: family.patientIds }, isActive: true },
    });
    if (!partner) return error(res, 'CareLink partner not found', 404);

    await partner.update({ isActive: false });
    return success(res, { message: 'CareLink partner removed' });
  } catch (err) {
    console.error('CareLink partner REMOVE error:', err.message);
    return error(res, 'Failed to remove CareLink partner. Please try again.', 500);
  }
};

module.exports = { getAll, add, update, remove };
