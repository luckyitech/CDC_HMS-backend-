const { success, error } = require('../utils/response');
const db = require('../models');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendStaffWelcomeEmail } = require('../utils/emailService');

const { User, DoctorProfile, StaffProfile, LabTechProfile, Patient, UserEditLog } = db;

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
  };

  if (user.role === 'doctor' && profile) {
    Object.assign(baseData, {
      specialty:      profile.specialty,
      subSpecialty:   profile.subSpecialty,
      department:     profile.department,
      licenseNumber:  profile.licenseNumber,
      qualification:  profile.qualification,
      medicalSchool:  profile.medicalSchool,
      yearsExperience:profile.yearsExperience,
      employmentType: profile.employmentType,
      address:        profile.address,
      city:           profile.city,
    });
  } else if (user.role === 'staff' && profile) {
    Object.assign(baseData, {
      position:   profile.position,
      department: profile.department,
      shift:      profile.shift,
    });
  } else if (user.role === 'lab' && profile) {
    Object.assign(baseData, {
      specialization:      profile.specialization,
      certificationNumber: profile.certificationNumber,
      qualification:       profile.qualification,
      institution:         profile.institution,
      yearsExperience:     profile.yearsExperience,
      shift:               profile.shift,
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
 * POST /api/users/doctors
 * Creates a new doctor user with profile
 *
 * Authorization: Admin only
 */
const createDoctor = async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    licenseNumber,
    specialty,
    subSpecialty,
    department,
    qualification,
    medicalSchool,
    yearsExperience,
    employmentType,
    startDate,
    address,
    city,
    password: providedPassword,
  } = req.body;

  let transaction;
  try {
    // Check if email already exists
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return error(res, 'Email already in use', 400);
    }

    // Use admin-provided password or auto-generate
    const tempPassword = providedPassword || generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Start database transaction - ensures User and Profile are created together
    transaction = await sequelize.transaction();

    // Create user
    const user = await User.create({
      email,
      password: hashedPassword,
      role: 'doctor',
      firstName,
      lastName,
      phone,
      isActive: true,
      createdBy: req.user.name || 'Unknown',
    }, { transaction });

    // Create doctor profile
    const doctorProfile = await DoctorProfile.create({
      UserId: user.id,
      licenseNumber,
      specialty,
      subSpecialty,
      department,
      qualification,
      medicalSchool,
      yearsExperience,
      employmentType,
      startDate,
      address,
      city,
    }, { transaction });

    // Commit transaction
    await transaction.commit();

    // Send welcome email with login credentials
    sendStaffWelcomeEmail({ to: email, name: `${firstName} ${lastName}`, role: 'doctor', tempPassword }).catch(() => {});

    return success(
      res,
      {
        user: formatUserResponse(user, doctorProfile),
        message: 'Account created. Login credentials have been sent to the provided email.',
      },
      201
    );
  } catch (err) {
    // Rollback transaction on error
    if (transaction) await transaction.rollback();
    console.error('Create doctor error:', err.message);
    return error(res, 'Failed to create doctor account. Please try again.', 500);
  }
};

/**
 * POST /api/users/staff
 * Creates a new staff user with profile
 *
 * Authorization: Admin only
 */
const createStaff = async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    position,
    department,
    shift,
    startDate,
    password: providedPassword,
  } = req.body;

  let transaction;
  try {
    // Check if email already exists
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return error(res, 'Email already in use', 400);
    }

    // Use admin-provided password or auto-generate
    const tempPassword = providedPassword || generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Start database transaction - ensures User and Profile are created together
    transaction = await sequelize.transaction();

    // Create user
    const user = await User.create({
      email,
      password: hashedPassword,
      role: 'staff',
      firstName,
      lastName,
      phone,
      isActive: true,
      createdBy: req.user.name || 'Unknown',
    }, { transaction });

    // Create staff profile
    const staffProfile = await StaffProfile.create({
      UserId: user.id,
      position,
      department,
      shift,
      startDate,
    }, { transaction });

    // Commit transaction
    await transaction.commit();

    // Send welcome email with login credentials
    sendStaffWelcomeEmail({ to: email, name: `${firstName} ${lastName}`, role: 'staff', tempPassword }).catch(() => {});

    return success(
      res,
      {
        user: formatUserResponse(user, staffProfile),
        message: 'Account created. Login credentials have been sent to the provided email.',
      },
      201
    );
  } catch (err) {
    // Rollback transaction on error
    if (transaction) await transaction.rollback();
    console.error('Create staff error:', err.message);
    return error(res, 'Failed to create staff account. Please try again.', 500);
  }
};

/**
 * POST /api/users/lab-techs
 * Creates a new lab tech user with profile
 *
 * Authorization: Admin only
 */
const createLabTech = async (req, res) => {
  const {
    firstName,
    lastName,
    email,
    phone,
    specialization,
    certificationNumber,
    qualification,
    institution,
    yearsExperience,
    shift,
    startDate,
    password: providedPassword,
  } = req.body;

  let transaction;
  try {
    // Check if email already exists
    const existingUser = await User.findOne({ where: { email } });
    if (existingUser) {
      return error(res, 'Email already in use', 400);
    }

    // Use admin-provided password or auto-generate
    const tempPassword = providedPassword || generateTempPassword();
    const hashedPassword = await bcrypt.hash(tempPassword, 10);

    // Start database transaction - ensures User and Profile are created together
    transaction = await sequelize.transaction();

    // Create user
    const user = await User.create({
      email,
      password: hashedPassword,
      role: 'lab',
      firstName,
      lastName,
      phone,
      isActive: true,
      createdBy: req.user.name || 'Unknown',
    }, { transaction });

    // Create lab tech profile
    const labTechProfile = await LabTechProfile.create({
      UserId: user.id,
      specialization,
      certificationNumber,
      qualification,
      institution,
      yearsExperience,
      shift,
      startDate,
    }, { transaction });

    // Commit transaction
    await transaction.commit();

    // Send welcome email with login credentials
    sendStaffWelcomeEmail({ to: email, name: `${firstName} ${lastName}`, role: 'lab', tempPassword }).catch(() => {});

    return success(
      res,
      {
        user: formatUserResponse(user, labTechProfile),
        message: 'Account created. Login credentials have been sent to the provided email.',
      },
      201
    );
  } catch (err) {
    // Rollback transaction on error
    if (transaction) await transaction.rollback();
    console.error('Create lab tech error:', err.message);
    return error(res, 'Failed to create lab tech account. Please try again.', 500);
  }
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
        attributes: ['id', 'firstName', 'lastName', 'email', 'phone', 'role', 'isActive', 'createdAt'],
        include: [
          { model: DoctorProfile,  required: false },
          { model: StaffProfile,   required: false },
          { model: LabTechProfile, required: false },
          { model: Patient,        required: false },
        ],
        order: [['createdAt', 'DESC']],
      }),
      includePatients
        ? Patient.findAll({ where: { UserId: null }, order: [['createdAt', 'DESC']] })
        : Promise.resolve([]),
    ]);

    const formattedUsers = users.map((user) => {
      // Profile is already eager-loaded — no extra queries needed
      const profile =
        user.role === 'doctor'  ? user.DoctorProfile  :
        user.role === 'staff'   ? user.StaffProfile   :
        user.role === 'lab'     ? user.LabTechProfile  :
        user.role === 'patient' ? user.Patient         : null;

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
// Fields allowed per role for updateUser
const ROLE_PROFILE_FIELDS = {
  doctor:  ['licenseNumber', 'specialty', 'subSpecialty', 'department', 'qualification', 'medicalSchool', 'yearsExperience', 'employmentType', 'address', 'city'],
  staff:   ['position', 'department', 'shift'],
  lab:     ['specialization', 'certificationNumber', 'qualification', 'institution', 'yearsExperience', 'shift'],
  patient: ['firstName', 'lastName', 'email', 'phone', 'dateOfBirth', 'gender', 'address', 'diagnosis', 'diagnosisDate', 'hba1c', 'emergencyContact', 'insurance'],
};

// Date fields that must be null — not empty string — when cleared, otherwise MySQL rejects them
const DATE_FIELDS = new Set(['dateOfBirth', 'diagnosisDate']);

const ROLE_PROFILE_MODEL = {
  doctor:  (userId) => DoctorProfile.findOne({ where: { UserId: userId } }),
  staff:   (userId) => StaffProfile.findOne({ where: { UserId: userId } }),
  lab:     (userId) => LabTechProfile.findOne({ where: { UserId: userId } }),
  patient: (userId) => Patient.findOne({ where: { UserId: userId } }),
};

// Build a changes object: { field: { from, to } } — only fields that actually changed
const buildChanges = (before, after) => {
  const changes = {};
  const serialize = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v ?? ''));
  Object.keys(after).forEach((field) => {
    if (serialize(before[field]) !== serialize(after[field])) {
      changes[field] = { from: before[field] ?? null, to: after[field] };
    }
  });
  return changes;
};

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

    const userBefore = {};
    userFields.forEach((f) => { userBefore[f] = user[f]; });

    if (Object.keys(userUpdates).length > 0) await user.update(userUpdates);

    // ── Role-specific profile fields ─────────────────────────────────────────
    let profile = null;
    let profileChanges = {};
    const profileFields = ROLE_PROFILE_FIELDS[user.role] || [];

    if (profileFields.length > 0 && ROLE_PROFILE_MODEL[user.role]) {
      profile = await ROLE_PROFILE_MODEL[user.role](user.id);
      if (profile) {
        const profileUpdates = {};
        profileFields.forEach((field) => {
          if (updates[field] === undefined) return;
          // Empty string on a date column would cause MySQL "Incorrect datetime value" — coerce to null
          profileUpdates[field] = DATE_FIELDS.has(field) && updates[field] === '' ? null : updates[field];
        });

        if (Object.keys(profileUpdates).length > 0) {
          const profileBefore = {};
          profileFields.forEach((f) => { profileBefore[f] = profile[f]; });
          await profile.update(profileUpdates);
          profileChanges = buildChanges(profileBefore, profileUpdates);
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

    // Get role-specific profile
    let profile = null;
    if (user.role === 'doctor') {
      profile = await DoctorProfile.findOne({ where: { UserId: user.id } });
    } else if (user.role === 'staff') {
      profile = await StaffProfile.findOne({ where: { UserId: user.id } });
    } else if (user.role === 'lab') {
      profile = await LabTechProfile.findOne({ where: { UserId: user.id } });
    } else if (user.role === 'patient') {
      profile = await Patient.findOne({ where: { UserId: user.id } });
    }

    return success(res, { user: formatUserResponse(user, profile) });
  } catch (err) {
    console.error('Get user by ID error:', err.message);
    return error(res, 'Failed to retrieve user. Please try again.', 500);
  }
};

/**
 * DELETE /api/users/:id
 * Deletes a user and their associated profile
 *
 * Authorization: Admin only
 *
 * Note: This is a hard delete. Consider using soft delete (isActive=false) instead.
 */
const deleteUser = async (req, res) => {
  const { id } = req.params;

  let transaction;
  try {
    // Find user
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

    // Start transaction
    transaction = await sequelize.transaction();

    // Delete role-specific profile first (due to FK constraints)
    if (user.role === 'doctor') {
      await DoctorProfile.destroy({ where: { UserId: user.id }, transaction });
    } else if (user.role === 'staff') {
      await StaffProfile.destroy({ where: { UserId: user.id }, transaction });
    } else if (user.role === 'lab') {
      await LabTechProfile.destroy({ where: { UserId: user.id }, transaction });
    } else if (user.role === 'patient') {
      await Patient.destroy({ where: { UserId: user.id }, transaction });
    }

    // Delete user
    await user.destroy({ transaction });

    // Commit transaction
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
    // Rollback on error
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
    include: [{ model: DoctorProfile, attributes: ['specialty'] }],
    order: [['firstName', 'ASC']],
  });

  const formatted = doctors.map(d => ({
    id: d.id,
    name: `Dr. ${d.firstName} ${d.lastName}`,
    specialty: d.DoctorProfile?.specialty || 'General Physician',
  }));

  return success(res, formatted);
};

// EXPORTS

module.exports = {
  createDoctor,
  createStaff,
  createLabTech,
  listDoctors,
  listUsers,
  getById,
  updateUser,
  updateStatus,
  deleteUser,
  getEditLogs,
};
