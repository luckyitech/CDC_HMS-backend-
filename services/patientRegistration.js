// ---------------------------------------------------------------------------
// services/patientRegistration.js
//
// The single place a Patient row (and, optionally, its linked patient login) is
// created for STAFF-facing flows. Consolidates what was copy-pasted across
// patientController.create, patientController.quickCreate and the login half of
// completeRegistration.
//
// NOT used by the public website booking path (controllers/publicBookingController.js)
// — that flow is deliberately left untouched; it already does its own
// merge-aware REUSE and composes an appointment in the same request.
//
// Returns a discriminated result object rather than throwing for expected
// outcomes, so the thin controllers can map each case to the exact HTTP shape
// the frontend already expects:
//   { status: 'duplicate',   candidates }        -> 409 POSSIBLE_DUPLICATE (unless force)
//   { status: 'uhid_taken',  uhid }              -> 400
//   { status: 'email_taken', email }             -> 400
//   { status: 'created',      patient, user, tempPassword, candidates }
// ---------------------------------------------------------------------------

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const sequelize = require('../config/database');
const db = require('../models');
const { generateUHID } = require('../utils/generateId');
const { findMatches } = require('../utils/patientMatch');
const { sendPatientWelcomeEmail } = require('../utils/emailService');

const { Patient, User } = db;

/**
 * Create the patient portal login. Shared by registerPatient (full create) and
 * completeRegistration (upgrading a stub). Throws { code: 'EMAIL_TAKEN' } if the
 * email already backs a User, so callers can roll their transaction back.
 *
 * When requireEmail is false (the full-create path historically always minted a
 * User row even with a null email — a temp password is still generated), a null
 * email produces a User with a null email and no duplicate check.
 */
const createPatientLogin = async (
  { email, password, firstName, lastName, phone, requireEmail = false },
  transaction,
) => {
  if (email) {
    const existing = await User.findOne({ where: { email }, transaction });
    if (existing) {
      const err = new Error('EMAIL_TAKEN');
      err.code = 'EMAIL_TAKEN';
      err.email = email;
      throw err;
    }
  } else if (requireEmail) {
    return { user: null, tempPassword: null };
  }

  const tempPassword = password || crypto.randomBytes(6).toString('hex');
  const hashed = await bcrypt.hash(tempPassword, 10);
  const user = await User.create(
    { email: email || null, password: hashed, role: 'patient', firstName, lastName, phone, isActive: true },
    { transaction },
  );
  return { user, tempPassword };
};

/**
 * Register a new patient file, with a merge-aware duplicate WARN gate.
 *
 * @param {object} args
 * @param {object} args.fields         normalized patient fields (firstName, lastName, phone, email?, dateOfBirth?, idNumber?, uhid?, ...)
 * @param {boolean} [args.createLogin] create a linked patient User (full create) vs. a stub (quick)
 * @param {string}  [args.password]    explicit temp password (else generated)
 * @param {boolean} [args.force]       proceed despite duplicate candidates
 * @param {number}  [args.matchExcludeId] canonical patient id to exclude from matching (self)
 * @param {object}  args.attribution   { registeredBy, registeredByRole } — derived from the JWT by the caller
 * @param {boolean} [args.registrationComplete] defaults to createLogin
 * @param {object}  [args.extras]      extra Patient columns (primaryDoctorId, status, ...)
 * @param {boolean} [args.sendWelcome] fire-and-forget welcome email when an email is present
 * @param {object}  [args.transaction] external transaction to enlist in (else one is opened)
 */
const registerPatient = async (args) => {
  const {
    fields,
    createLogin = false,
    password = null,
    force = false,
    matchExcludeId = null,
    attribution,
    registrationComplete = createLogin,
    extras = {},
    sendWelcome = false,
    transaction: extTxn = null,
  } = args;

  // -- duplicate WARN gate (merge-aware) --
  const candidates = await findMatches(fields, { excludeId: matchExcludeId });
  if (candidates.length && !force) {
    return { status: 'duplicate', candidates };
  }

  // -- UHID: honour a provided one (collision-checked) or generate --
  let uhid = fields.uhid;
  if (uhid) {
    const clash = await Patient.findOne({ where: { uhid } });
    if (clash) return { status: 'uhid_taken', uhid };
  } else {
    uhid = await generateUHID(Patient);
  }

  const ownTxn = !extTxn;
  const t = extTxn || (await sequelize.transaction());
  try {
    let user = null;
    let tempPassword = null;

    if (createLogin) {
      // Full-create historically always created a User row (email may be null).
      ({ user, tempPassword } = await createPatientLogin(
        { email: fields.email, password, firstName: fields.firstName, lastName: fields.lastName, phone: fields.phone },
        t,
      ));
    }

    // Strip control keys that must never be written straight from the body.
    const { password: _pw, force: _f, uhid: _u, ...writable } = fields;

    const patient = await Patient.create(
      {
        ...writable,
        uhid,
        ...(user ? { UserId: user.id } : {}),
        registrationComplete,
        registeredBy: attribution.registeredBy,
        registeredByRole: attribution.registeredByRole,
        ...extras,
      },
      { transaction: t },
    );

    if (ownTxn) await t.commit();

    if (sendWelcome && fields.email && tempPassword) {
      sendPatientWelcomeEmail({
        to: fields.email,
        name: `${fields.firstName} ${fields.lastName}`,
        uhid,
        tempPassword,
      }).catch(() => {});
    }

    return { status: 'created', patient, user, tempPassword, candidates };
  } catch (err) {
    if (ownTxn) await t.rollback();
    if (err.code === 'EMAIL_TAKEN') return { status: 'email_taken', email: err.email };
    throw err;
  }
};

module.exports = { registerPatient, createPatientLogin };
