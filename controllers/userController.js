const { success, error } = require('../utils/response');
const db = require('../models');
const sequelize = require('../config/database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { sendStaffWelcomeEmail } = require('../utils/emailService');

const { User, DoctorProfile, StaffProfile, LabTechProfile } = db;

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
    id: user.id,
    name: `${user.firstName} ${user.lastName}`,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.isActive ? 'Active' : 'Inactive',
    createdAt: user.createdAt,
  };

  // Add role-specific fields
  if (user.role === 'doctor' && profile) {
    baseData.specialty = profile.specialty;
    baseData.department = profile.department;
    baseData.licenseNumber = profile.licenseNumber;
  } else if (user.role === 'staff' && profile) {
    baseData.position = profile.position;
    baseData.department = profile.department;
    baseData.shift = profile.shift;
  } else if (user.role === 'lab' && profile) {
    baseData.specialization = profile.specialization;
    baseData.certificationNumber = profile.certificationNumber;
    baseData.shift = profile.shift;
  }

  return baseData;
};

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
    // Build where clause
    const where = {};
    if (role) {
      where.role = role;
    }

    // Get all users
    const users = await User.findAll({
      where,
      attributes: ['id', 'firstName', 'lastName', 'email', 'phone', 'role', 'isActive', 'createdAt'],
      order: [['createdAt', 'DESC']],
    });

    // Fetch profiles for each user
    const usersWithProfiles = await Promise.all(
      users.map(async (user) => {
        let profile = null;

        if (user.role === 'doctor') {
          profile = await DoctorProfile.findOne({ where: { UserId: user.id } });
        } else if (user.role === 'staff') {
          profile = await StaffProfile.findOne({ where: { UserId: user.id } });
        } else if (user.role === 'lab') {
          profile = await LabTechProfile.findOne({ where: { UserId: user.id } });
        }

        return formatUserResponse(user, profile);
      })
    );

    return success(res, { users: usersWithProfiles });
  } catch (err) {
    console.error('List users error:', err.message);
    return error(res, 'Failed to retrieve users. Please try again.', 500);
  }
};

/**
 * PUT /api/users/:id
 * Updates user and profile information
 *
 * Authorization: Admin only
 */
const updateUser = async (req, res) => {
  const { id } = req.params;
  const updates = req.body;

  try {
    // Find user
    const user = await User.findByPk(id);
    if (!user) {
      return error(res, 'User not found', 404);
    }

    // Update user fields
    const userFields = ['firstName', 'lastName', 'phone', 'email'];
    const userUpdates = {};
    userFields.forEach((field) => {
      if (updates[field] !== undefined) {
        userUpdates[field] = updates[field];
      }
    });

    if (Object.keys(userUpdates).length > 0) {
      await user.update(userUpdates);
    }

    // Update role-specific profile
    let profile = null;
    if (user.role === 'doctor') {
      profile = await DoctorProfile.findOne({ where: { UserId: user.id } });
      if (profile) {
        const profileFields = [
          'licenseNumber',
          'specialty',
          'subSpecialty',
          'department',
          'qualification',
          'medicalSchool',
          'yearsExperience',
          'employmentType',
          'address',
          'city',
        ];
        const profileUpdates = {};
        profileFields.forEach((field) => {
          if (updates[field] !== undefined) {
            profileUpdates[field] = updates[field];
          }
        });
        if (Object.keys(profileUpdates).length > 0) {
          await profile.update(profileUpdates);
        }
      }
    } else if (user.role === 'staff') {
      profile = await StaffProfile.findOne({ where: { UserId: user.id } });
      if (profile) {
        const profileFields = ['position', 'department', 'shift'];
        const profileUpdates = {};
        profileFields.forEach((field) => {
          if (updates[field] !== undefined) {
            profileUpdates[field] = updates[field];
          }
        });
        if (Object.keys(profileUpdates).length > 0) {
          await profile.update(profileUpdates);
        }
      }
    } else if (user.role === 'lab') {
      profile = await LabTechProfile.findOne({ where: { UserId: user.id } });
      if (profile) {
        const profileFields = [
          'specialization',
          'certificationNumber',
          'qualification',
          'institution',
          'yearsExperience',
          'shift',
        ];
        const profileUpdates = {};
        profileFields.forEach((field) => {
          if (updates[field] !== undefined) {
            profileUpdates[field] = updates[field];
          }
        });
        if (Object.keys(profileUpdates).length > 0) {
          await profile.update(profileUpdates);
        }
      }
    }

    // Refresh user data
    await user.reload();

    return success(res, { user: formatUserResponse(user, profile) });
  } catch (err) {
    console.error('Update user error:', err.message);
    return error(res, 'Failed to update user. Please try again.', 500);
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
};
