const { success, error } = require('../utils/response');
const {
  PERMISSIONS, PERMISSIBLE_ROLES, isTrueAdmin, sanitizePermissions, hasPermission,
} = require('../constants/permissions');
const db = require('../models');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendStaffWelcomeEmail } = require('../utils/emailService');
const { generateEmployeeId } = require('../utils/generateId');
const { buildChanges } = require('../utils/auditChanges');
const { STAFF_ROLES, DEFAULT_POSITION } = require('../constants/staffRoles');

// StaffProfile is now the single profile table for every cadre — doctor, nurse,
// lab tech and front-desk staff. DoctorProfile and LabTechProfile are no longer
// written to or read from; they remain in the codebase for one release as a
// rollback path and are dropped by a later migration.
// See STAFF_PROFILE_DESIGN.md.
const { User, StaffProfile, Patient, UserEditLog } = db;

// ====================================
// HELPER FUNCTIONS
// ====================================

/**
 * Generates a random temporary password
 */
const generateTempPassword = () => {
  return crypto.randomBytes(8).toString('hex');
};

/**
 * Formats user data with role-specific profile
 */
const formatUserResponse = (user, profile) => {
  const baseData = {
    id:        user.id,
    firstName: user.firstName,
    lastName:  user.lastName,
    name:      `${user.firstName} ${user.lastName}`,
    email:     user.email,
    phone:     user.phone,
    role:      user.role,
    status:    user.isActive ? 'Active' : 'Inactive',
    createdAt: user.createdAt,
    // Capabilities granted to this account — drives the Manage Users toggles.
    // Derived from `permissions`, NOT from the superseded canManageStock
    // column: writes go to `permissions`, so reading the old column here would
    // show a toggle that disagrees with what the server actually enforces.
    permissions: Array.isArray(user.permissions) ? user.permissions : [],
    canManageStock: hasPermission(user, PERMISSIONS.STOCK_MANAGE),
    hasAdminAccess: hasPermission(user, PERMISSIONS.ADMIN_ACCESS),
  };

  // All staff cadres now share one profile table, so one branch covers them.
  //
  // The role-specific aliases below (subSpecialty, medicalSchool,
  // specialization, certificationNumber) are kept in the RESPONSE even though
  // the columns behind them are gone. Manage Users, the create forms and the
  // prescription header all read those key names; renaming them here would
  // break those screens for no benefit. The mapping lives in this one function
  // instead of being scattered across the frontend.
  if (profile && STAFF_ROLES.includes(user.role)) {
    Object.assign(baseData, {
      employeeId:       profile.employeeId,
      position:         profile.position,
      department:       profile.department,
      ward:             profile.ward,
      shift:            profile.shift,
      employmentType:   profile.employmentType,
      employmentStatus: profile.employmentStatus,
      startDate:        profile.startDate,
      address:          profile.address,
      city:             profile.city,
      dateOfBirth:      profile.dateOfBirth,
      gender:           profile.gender,
      idNumber:         profile.idNumber,
      emergencyContact: profile.emergencyContact,

      licenseNumber:   profile.licenseNumber,
      specialty:       profile.specialty,
      qualification:   profile.qualification,
      institution:     profile.institution,
      yearsExperience: profile.yearsExperience,

      // Legacy aliases — see comment above
      subSpecialty:        profile.roleDetails?.subSpecialty ?? null,
      medicalSchool:       profile.institution,
      specialization:      profile.specialty,
      certificationNumber: profile.licenseNumber,

      isArchived: !!profile.deletedAt,
    });
  } else if (user.role === 'patient' && profile) {
    Object.assign(baseData, {
      dateOfBirth:      profile.dateOfBirth,
      gender:           profile.gender,
      address:          profile.address,
      diagnosis:        profile.diagnosis,
      diagnosisDate:    profile.diagnosisDate,
      hba1c:            profile.hba1c,
      riskLevel:        profile.riskLevel,
      emergencyContact: profile.emergencyContact,
      insurance:        profile.insurance,
    });
  }

  return baseData;
};

// Formats a Patient record that has no User account yet (quick-registered / incomplete)
// into the same shape as formatUserResponse so the frontend can treat both uniformly.
const formatPatientOnly = (p) => ({
  id:                   `patient_${p.id}`,   // prefixed so it never clashes with a User id
  patientId:            p.id,
  firstName:            p.firstName,
  lastName:             p.lastName,
  name:                 `${p.firstName || ''} ${p.lastName || ''}`.trim(),
  email:                p.email   || null,
  phone:                p.phone   || null,
  role:                 'patient',
  status:               p.status  || 'Active',
  uhid:                 p.uhid,
  registrationComplete: !!p.registrationComplete,
  hasUserAccount:       false,
  createdAt:            p.createdAt,
});

// ====================================
// CONTROLLER ACTIONS
// ====================================

/**
 * Shared account-creation path.
 *
 * All four cadres are created the same way — a User row plus a StaffProfile row
 * inside one transaction, then a welcome email. Only the field mapping differs,
 * so that is the only thing each caller supplies. Previously this logic was
 * copy-pasted four times, which is how createNurse ended up unable to record a
 * nursing licence: the fields were only ever added to one copy.
 *
 * The transaction matters: a User without a profile cannot be edited through
 * the profile page and cannot be given an employee ID, so a half-created
 * account is worse than no account.
 */
const createStaffAccount = async (req, res, { role, profileFields = {}, roleDetails = {}, label }) => {
  const { firstName, lastName, email, phone, password: providedPassword } = req.body;

  let transaction;
  try {
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) return error(res, 'Email already in use', 400);

    const tempPassword   = providedPassword || generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    transaction = await sequelize.transaction();

    const user = await User.create({
      email,
      password: hashedPassword,
      role,
      firstName,
      lastName,
      phone,
      isActive: true,
      createdBy: req.user.name || 'Unknown',
    }, { transaction });

    // Generated inside the transaction so a failed create does not consume an
    // employee number and leave a gap in the sequence.
    const employeeId = await generateEmployeeId(StaffProfile);

    const profile = await StaffProfile.create({
      UserId:           user.id,
      employeeId,
      position:         profileFields.position || DEFAULT_POSITION[role],
      employmentStatus: 'Active',
      roleDetails,
      createdBy:        req.user.id,
      ...profileFields,
    }, { transaction });

    await transaction.commit();

    // Deliberately after the commit and deliberately not awaited: a mail
    // server outage must not roll back an account that was created correctly.
    sendStaffWelcomeEmail({
      to: email,
      name: `${firstName} ${lastName}`,
      role,
      tempPassword,
    }).catch(() => {});

    return success(res, {
      user: formatUserResponse(user, profile),
      message: 'Account created. Login credentials have been sent to the provided email.',
    }, 201);
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error(`Create ${label} error:`, err.message);
    return error(res, `Failed to create ${label} account. Please try again.`, 500);
  }
};

// Strips undefined keys so a field the form did not send does not overwrite a
// column with undefined (which Sequelize would write as NULL).
const defined = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/**
 * POST /api/users/doctors
 * Creates a new doctor user with profile
 *
 * Authorization: Admin only
 */
const createDoctor = async (req, res) => {
  const {
    licenseNumber, licenseBody, licenseExpiry, specialty, subSpecialty,
    department, qualification, medicalSchool, institution, yearsExperience,
    employmentType, startDate, address, city,
    dateOfBirth, gender, idNumber, emergencyContact,
  } = req.body;

  return createStaffAccount(req, res, {
    role:  'doctor',
    label: 'doctor',
    profileFields: defined({
      licenseNumber, licenseBody, licenseExpiry, specialty,
      department, qualification,
      // The form still calls it medicalSchool; the column is `institution`
      // because lab techs and nurses train somewhere that is not a medical
      // school. Accept either so an older client keeps working.
      institution: institution ?? medicalSchool,
      yearsExperience, employmentType, startDate, address, city,
      dateOfBirth, gender, idNumber, emergencyContact,
    }),
    roleDetails: defined({ subSpecialty }),
  });
};

/**
 * POST /api/users/staff
 * Creates a new staff user (front desk / admission clerk) with profile
 *
 * Authorization: Admin only
 */
const createStaff = async (req, res) => {
  const {
    position, department, shift, startDate, employmentType,
    dateOfBirth, gender, idNumber, address, city, emergencyContact,
  } = req.body;

  return createStaffAccount(req, res, {
    role:  'staff',
    label: 'staff',
    profileFields: defined({
      position, department, shift, startDate, employmentType,
      dateOfBirth, gender, idNumber, address, city, emergencyContact,
    }),
  });
};

/**
 * POST /api/users/nurses  (HMIS V3)
 * Creates a nurse user. Nurses are the primary inpatient users and also do OPD
 * triage, vitals and injections.
 *
 * Authorization: Admin only
 */
const createNurse = async (req, res) => {
  const {
    position, department, ward, shift, startDate, employmentType,
    licenseNumber, licenseBody, licenseExpiry, qualification, institution,
    yearsExperience, nursingCadre, certifications,
    dateOfBirth, gender, idNumber, address, city, emergencyContact,
  } = req.body;

  return createStaffAccount(req, res, {
    role:  'nurse',
    label: 'nurse',
    profileFields: defined({
      position, department, ward,
      shift: shift || 'Morning',
      startDate, employmentType,
      licenseNumber, licenseBody, licenseExpiry, qualification, institution,
      yearsExperience,
      dateOfBirth, gender, idNumber, address, city, emergencyContact,
    }),
    roleDetails: defined({ nursingCadre, certifications }),
  });
};

/**
 * POST /api/users/lab-techs
 * Creates a new lab tech user with profile
 *
 * Authorization: Admin only
 */
const createLabTech = async (req, res) => {
  const {
    specialization, specialty, certificationNumber, licenseNumber,
    licenseBody, licenseExpiry, qualification, institution, yearsExperience,
    shift, startDate, department, employmentType, labSection,
    dateOfBirth, gender, idNumber, address, city, emergencyContact,
  } = req.body;

  return createStaffAccount(req, res, {
    role:  'lab',
    label: 'lab tech',
    profileFields: defined({
      // The lab form uses `specialization` / `certificationNumber`; the shared
      // columns are `specialty` / `licenseNumber`. Both spellings accepted.
      specialty:     specialty ?? specialization,
      licenseNumber: licenseNumber ?? certificationNumber,
      licenseBody, licenseExpiry, qualification, institution, yearsExperience,
      shift, startDate,
      department: department || 'Laboratory',
      employmentType,
      dateOfBirth, gender, idNumber, address, city, emergencyContact,
    }),
    roleDetails: defined({ labSection }),
  });
};

/**
 * GET /api/users
 * Lists all users with optional role filter
 *
 * Authorization: Admin only
 */
const listUsers = async (req, res) => {
  const { role } = req.query;

  try {
    const where = {};
    if (role) where.role = role;

    const includePatients = !role || role === 'patient';

    // Fetch users (with all role profiles eager-loaded) and unlinked patients in parallel
    const [users, unlinkedPatients] = await Promise.all([
      User.findAll({
        where,
        attributes: ['id', 'firstName', 'lastName', 'email', 'phone', 'role', 'isActive', 'createdAt', 'canManageStock'],
        // Two joins instead of four — every staff cadre shares StaffProfile now.
        include: [
          { model: StaffProfile, required: false },
          { model: Patient,      required: false },
        ],
        order: [['createdAt', 'DESC']],
      }),
      includePatients
        ? Patient.findAll({ where: { UserId: null }, order: [['createdAt', 'DESC']] })
        : Promise.resolve([]),
    ]);

    const formattedUsers = users.map((user) => {
      // Profile is already eager-loaded — no extra queries needed
      const profile = user.role === 'patient' ? user.Patient : user.StaffProfile;

      const formatted = formatUserResponse(user, profile);

      // Attach extra fields for patients so the frontend can show registration status
      if (user.role === 'patient' && profile) {
        formatted.uhid               = profile.uhid;
        formatted.registrationComplete = !!profile.registrationComplete;
        formatted.hasUserAccount     = true;
        formatted.patientId          = profile.id;
      }

      return formatted;
    });

    const allUsers = [
      ...formattedUsers,
      ...(includePatients ? unlinkedPatients.map(formatPatientOnly) : []),
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return success(res, { users: allUsers });
  } catch (err) {
    console.error('listUsers error:', err);
    return error(res, 'Failed to retrieve users', 500);
  }
};

/**
 * PUT /api/users/:id
 * Updates user and profile information
 *
 * Authorization: Admin only
 */
// Fields accepted per role by updateUser.
//
// Every staff cadre shares one list now, because they share one table. The
// role-specific names the Manage Users modal still sends (medicalSchool,
// specialization, certificationNumber, subSpecialty) remain accepted and are
// translated below — the frontend was not changed just because the columns were.
const STAFF_PROFILE_FIELDS = [
  'position', 'department', 'ward', 'shift', 'employmentType', 'startDate',
  'licenseNumber', 'licenseBody', 'licenseExpiry', 'specialty',
  'qualification', 'institution', 'yearsExperience',
  'address', 'city', 'dateOfBirth', 'gender', 'idNumber', 'emergencyContact',
  // Legacy request-field names
  'medicalSchool', 'specialization', 'certificationNumber', 'subSpecialty',
];

const ROLE_PROFILE_FIELDS = {
  patient: ['firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'gender', 'address', 'diagnosis', 'diagnosisDate', 'hba1c', 'emergencyContact', 'insurance'],
};

// Request-field name -> StaffProfile column.
const STAFF_FIELD_ALIASES = {
  medicalSchool:       'institution',
  specialization:      'specialty',
  certificationNumber: 'licenseNumber',
};

// Fields that live inside the roleDetails JSON rather than in a column.
const ROLE_DETAIL_FIELDS = new Set(['subSpecialty']);

// Date fields that must be null — not empty string — when cleared, otherwise MySQL rejects them
const DATE_FIELDS = new Set(['dateOfBirth', 'diagnosisDate', 'startDate', 'endDate', 'licenseExpiry']);

// Every staff cadre now resolves to the same table; only patients differ.
const ROLE_PROFILE_MODEL = {
  patient: (userId) => Patient.findOne({ where: { UserId: userId } }),
  staff:   (userId) => StaffProfile.findOne({ where: { UserId: userId } }),
};

const findProfileForRole = (role, userId) =>
  role === 'patient'
    ? ROLE_PROFILE_MODEL.patient(userId)
    : ROLE_PROFILE_MODEL.staff(userId);

const updateUser = async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    const user = await User.findByPk(id);
    if (!user) return error(res, 'User not found', 404);

    // ── Common user fields (User table) ─────────────────────────────────────
    const userFields = ['firstName', 'lastName', 'phone', 'email'];
    const userUpdates = {};
    userFields.forEach((field) => {
      if (updates[field] !== undefined) userUpdates[field] = updates[field];
    });

    // ── Permissions ──────────────────────────────────────────────────────────
    // Restricted to a REAL admin account, even though this route now admits
    // anyone holding admin.access. If a granted user could grant, the
    // capability would propagate on its own and could never be reliably taken
    // back — see middleware/auth.js requireTrueAdmin.
    //
    // Both branches write `permissions`, never canManageStock, so there is one
    // source of truth. Anything pushed into userFields is picked up by the
    // UserEditLog audit below, so grants and revokes are recorded with who did
    // them — which matters more for admin access than for anything else here.
    if (updates.permissions !== undefined) {
      if (!isTrueAdmin(req.user)) {
        return error(res, 'Only an administrator account can change permissions', 403);
      }
      if (!PERMISSIBLE_ROLES.includes(user.role)) {
        return error(res, `Permissions cannot be granted to a ${user.role} account`, 400);
      }
      userFields.push('permissions');
      userUpdates.permissions = sanitizePermissions(updates.permissions);

    // Back-compat: the Manage Users screen still sends a canManageStock
    // boolean. Translated into the permission rather than stored separately,
    // so the two can never disagree.
    } else if (updates.canManageStock !== undefined && PERMISSIBLE_ROLES.includes(user.role)) {
      if (!isTrueAdmin(req.user)) {
        return error(res, 'Only an administrator account can change permissions', 403);
      }
      const next = new Set(user.permissions || []);
      if (updates.canManageStock) next.add(PERMISSIONS.STOCK_MANAGE);
      else next.delete(PERMISSIONS.STOCK_MANAGE);
      userFields.push('permissions');
      userUpdates.permissions = [...next];
    }

    const userBefore = {};
    userFields.forEach((f) => { userBefore[f] = user[f]; });

    if (Object.keys(userUpdates).length > 0) await user.update(userUpdates);

    // ── Profile fields ───────────────────────────────────────────────────────
    let profile = null;
    let profileChanges = {};
    const isPatient    = user.role === 'patient';
    const profileFields = isPatient ? ROLE_PROFILE_FIELDS.patient : STAFF_PROFILE_FIELDS;

    if (isPatient || STAFF_ROLES.includes(user.role)) {
      profile = await findProfileForRole(user.role, user.id);
      if (profile) {
        const profileUpdates = {};
        const roleDetailUpdates = {};

        profileFields.forEach((field) => {
          if (updates[field] === undefined) return;

          // Empty string on a date column would cause MySQL "Incorrect datetime value" — coerce to null
          const value = DATE_FIELDS.has(field) && updates[field] === '' ? null : updates[field];

          if (!isPatient && ROLE_DETAIL_FIELDS.has(field)) {
            roleDetailUpdates[field] = value;
            return;
          }

          const column = (!isPatient && STAFF_FIELD_ALIASES[field]) || field;
          profileUpdates[column] = value;
        });

        // roleDetails is merged, not replaced — editing a doctor's sub-specialty
        // must not wipe the other keys stored alongside it.
        if (Object.keys(roleDetailUpdates).length > 0) {
          profileUpdates.roleDetails = { ...(profile.roleDetails || {}), ...roleDetailUpdates };
        }

        if (Object.keys(profileUpdates).length > 0) {
          if (!isPatient) profileUpdates.updatedBy = req.user.id;

          const profileBefore = {};
          Object.keys(profileUpdates).forEach((f) => { profileBefore[f] = profile[f]; });
          await profile.update(profileUpdates);

          profileChanges = buildChanges(profileBefore, profileUpdates);
          // updatedBy is bookkeeping, not an edit worth logging.
          delete profileChanges.updatedBy;
        }
      }
    }

    // ── Record audit log ─────────────────────────────────────────────────────
    const allChanges = {
      ...buildChanges(userBefore, userUpdates),
      ...profileChanges,
    };

    if (Object.keys(allChanges).length > 0) {
      await UserEditLog.create({
        targetUserId: user.id,
        editedBy:     req.user.id,
        editedByName: `${req.user.firstName} ${req.user.lastName}`,
        changes:      allChanges,
        editedAt:     new Date(),
      });
    }

    await user.reload();
    return success(res, { user: formatUserResponse(user, profile) });
  } catch (err) {
    console.error('Update user error:', err.message);
    return error(res, 'Failed to update user. Please try again.', 500);
  }
};

const getEditLogs = async (req, res) => {
  const { id } = req.params;
  try {
    const logs = await UserEditLog.findAll({
      where: { targetUserId: id },
      order: [['editedAt', 'DESC']],
    });
    return success(res, { logs });
  } catch (err) {
    console.error('Get edit logs error:', err.message);
    return error(res, 'Failed to retrieve edit history.', 500);
  }
};

/**
 * PUT /api/users/:id/status
 * Activates or deactivates a user account
 *
 * Authorization: Admin only
 */
const updateStatus = async (req, res) => {
  const { id } = req.params;
  const { isActive } = req.body;

  try {
    // Find user
    const user = await User.findByPk(id);
    if (!user) {
      return error(res, 'User not found', 404);
    }

    // Update status
    await user.update({ isActive });
    const newStatus = isActive ? 'Active' : 'Inactive';

    // Keep Patient.status in sync for patient accounts
    if (user.role === 'patient') {
      await Patient.update({ status: newStatus }, { where: { UserId: user.id } });
    }

    return success(res, {
      message: `User ${newStatus.toLowerCase()} successfully`,
      user: {
        id: user.id,
        name: `${user.firstName} ${user.lastName}`,
        status: newStatus,
      },
    });
  } catch (err) {
    console.error('Update status error:', err.message);
    return error(res, 'Failed to update user status. Please try again.', 500);
  }
};

/**
 * GET /api/users/:id
 * Gets a single user by ID with their profile
 *
 * Authorization: Admin only
 */
const getById = async (req, res) => {
  const { id } = req.params;

  try {
    // Find user
    const user = await User.findByPk(id, {
      attributes: ['id', 'firstName', 'lastName', 'email', 'phone', 'role', 'isActive', 'createdAt'],
    });

    if (!user) {
      return error(res, 'User not found', 404);
    }

    const profile = await findProfileForRole(user.role, user.id);

    return success(res, { user: formatUserResponse(user, profile) });
  } catch (err) {
    console.error('Get user by ID error:', err.message);
    return error(res, 'Failed to retrieve user. Please try again.', 500);
  }
};

/**
 * DELETE /api/users/:id
 * Archives a staff account. Patients are still hard-deleted here.
 *
 * Authorization: Admin only
 *
 * This used to destroy the User row and its profile. It no longer does for
 * staff: a departed doctor's name is still attached to prescriptions,
 * consultation notes, lab results and audit logs, and deleting the row orphans
 * all of it — the history then shows work done by nobody. Archiving disables
 * login and hides them from every list while the record survives.
 *
 * Restore is available at PATCH /api/staff/:employeeId/restore.
 */
const deleteUser = async (req, res) => {
  const { id } = req.params;

  let transaction;
  try {
    const user = await User.findByPk(id);
    if (!user) {
      return error(res, 'User not found', 404);
    }

    // Prevent deleting admin users
    if (user.role === 'admin') {
      return error(res, 'Cannot delete admin users', 403);
    }

    // Prevent self-deletion
    if (user.id === req.user.id) {
      return error(res, 'Cannot delete your own account', 403);
    }

    transaction = await sequelize.transaction();

    if (STAFF_ROLES.includes(user.role)) {
      const profile = await StaffProfile.findOne({ where: { UserId: user.id }, transaction });

      if (profile) {
        if (profile.deletedAt) {
          await transaction.rollback();
          return error(res, 'This account is already archived', 400);
        }

        await profile.update({
          deletedAt:        new Date(),
          deletedBy:        req.user.id,
          employmentStatus: profile.employmentStatus === 'Active' ? 'Resigned' : profile.employmentStatus,
        }, { transaction });
      }

      await user.update({ isActive: false }, { transaction });

      await UserEditLog.create({
        targetUserId: user.id,
        editedBy:     req.user.id,
        editedByName: `${req.user.firstName} ${req.user.lastName}`,
        changes:      { archived: { from: false, to: true } },
        editedAt:     new Date(),
      }, { transaction });

      await transaction.commit();

      return success(res, {
        message: 'Account archived. Their name remains on past records.',
        archivedUser: {
          id: user.id,
          name: `${user.firstName} ${user.lastName}`,
          role: user.role,
        },
      });
    }

    // Patients keep the previous behaviour — a patient record created in error
    // has no downstream clinical history to protect.
    await Patient.destroy({ where: { UserId: user.id }, transaction });
    await user.destroy({ transaction });

    await transaction.commit();

    return success(res, {
      message: 'User deleted successfully',
      deletedUser: {
        id: user.id,
        name: `${user.firstName} ${user.lastName}`,
        role: user.role,
      },
    });
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Delete user error:', err.message);
    return error(res, 'Failed to delete user. Please try again.', 500);
  }
};

/**
 * GET /api/users/doctors
 * Returns active doctors with name and specialty.
 * Accessible to any authenticated user (used by patients when booking).
 */
const listDoctors = async (_req, res) => {
  const doctors = await User.findAll({
    where: { role: 'doctor', isActive: true },
    attributes: ['id', 'firstName', 'lastName'],
    include: [{ model: StaffProfile, attributes: ['specialty'] }],
    order: [['firstName', 'ASC']],
  });

  const formatted = doctors.map(d => ({
    id: d.id,
    name: `Dr. ${d.firstName} ${d.lastName}`,
    specialty: d.StaffProfile?.specialty || 'General Physician',
  }));

  return success(res, formatted);
};

// EXPORTS

module.exports = {
  createDoctor,
  createStaff,
  createNurse,
  createLabTech,
  listDoctors,
  listUsers,
  getById,
  updateUser,
  updateStatus,
  deleteUser,
  getEditLogs,
};
