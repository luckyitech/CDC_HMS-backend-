const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { sendPasswordResetEmail } = require('../utils/emailService');
const db = require('../models');

const { User, DoctorProfile, StaffProfile, LabTechProfile, Patient } = db;

// Maps the three staff-type roles to their profile models.
// Keeps buildUserResponse DRY — no if/else chain needed.
const profileModelMap = {
  doctor: DoctorProfile,
  staff:  StaffProfile,
  lab:    LabTechProfile,
};


// ------------------------------------
// Helper: builds the user response object with role-specific profile data
// ------------------------------------
const buildUserResponse = async (user) => {
  const userData = {
    id: user.id,
    name: `${user.firstName} ${user.lastName}`,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.isActive ? 'Active' : 'Inactive',
  };

  const ProfileModel = profileModelMap[user.role];

  if (ProfileModel) {
    // doctor, staff, or lab — fetch their profile and spread the fields
    const profile = await ProfileModel.findOne({ where: { UserId: user.id } });
    if (profile) {
      const { id, UserId, createdAt, updatedAt, ...fields } = profile.dataValues;
      Object.assign(userData, fields);
    }
  } else if (user.role === 'patient') {
    // patient — attach uhid and diabetesType from the Patient table
    const patient = await Patient.findOne({ where: { userId: user.id } });
    if (patient) {
      userData.uhid = patient.uhid;
      userData.diabetesType = patient.diabetesType;
    }
  }

  return userData;
};

// ------------------------------------
// POST /api/auth/login
// ------------------------------------
const login = async (req, res) => {
  const { email, password, role } = req.body;

  // 1. Find user by email + role + active
  const user = await User.findOne({ where: { email, role, isActive: true } });
  if (!user) return error(res, 'User not found or account is inactive', 401);

  // 2. Compare password
  const match = await bcrypt.compare(password, user.password);
  if (!match) return error(res, 'Invalid password', 401);

  // 3. Sign JWT
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );

  // 4. Build response with profile
  const userData = await buildUserResponse(user);

  return success(res, { token, user: userData });
};

// ------------------------------------
// POST /api/auth/forgot-password
// ------------------------------------
const forgotPassword = async (req, res) => {
  const { email } = req.body;

  const user = await User.findOne({ where: { email } });
  if (!user) return error(res, 'Email not found', 404);

  // Generate token and expiry (from .env: RESET_TOKEN_EXPIRES_IN in ms)
  const resetToken = uuidv4();
  const resetTokenExpires = new Date(Date.now() + parseInt(process.env.RESET_TOKEN_EXPIRES_IN));

  await user.update({ resetToken, resetTokenExpires });

  // Send password reset email
  sendPasswordResetEmail({
    to: email,
    name: `${user.firstName} ${user.lastName}`,
    resetToken,
  }).catch(() => {});

  return success(res, { message: 'Password reset link sent to your email' });
};

// ------------------------------------
// POST /api/auth/reset-password
// ------------------------------------
const resetPassword = async (req, res) => {
  const { token, password } = req.body;

  // Find user with valid (non-expired) token
  const user = await User.findOne({
    where: {
      resetToken: token,
      resetTokenExpires: { [Op.gt]: new Date() }, // token must not be expired
    },
  });

  if (!user) return error(res, 'Invalid or expired reset token', 400);

  // Hash new password and clear the token
  const hashedPassword = await bcrypt.hash(password, 10);
  await user.update({
    password: hashedPassword,
    resetToken: null,
    resetTokenExpires: null,
  });

  return success(res, { message: 'Password reset successfully' });
};

// ------------------------------------
// GET /api/auth/me
// ------------------------------------
const getMe = async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return error(res, 'User not found', 404);

  const userData = await buildUserResponse(user);
  return success(res, userData);
};

// ------------------------------------
// PUT /api/auth/change-password
// ------------------------------------
const changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  try {
    // Get user from database (req.user comes from auth middleware)
    const user = await User.findByPk(req.user.id);
    if (!user) return error(res, 'User not found', 404);

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) return error(res, 'Current password is incorrect', 400);

    // Prevent using same password
    const isSamePassword = await bcrypt.compare(newPassword, user.password);
    if (isSamePassword) return error(res, 'New password must be different from current password', 400);

    // Hash and save new password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await user.update({ password: hashedPassword });

    return success(res, { message: 'Password changed successfully' });
  } catch (err) {
    console.error('Change password error:', err.message);
    return error(res, 'Failed to change password. Please try again.', 500);
  }
};

// ------------------------------------
// Token blacklist for server-side logout
// In production, use Redis for distributed systems
// ------------------------------------
const tokenBlacklist = new Set();

const isTokenBlacklisted = (token) => tokenBlacklist.has(token);

// ------------------------------------
// POST /api/auth/logout
// ------------------------------------
const logout = async (req, res) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(res, 'No token provided', 400);
    }

    const token = authHeader.split(' ')[1];

    // Add token to blacklist
    tokenBlacklist.add(token);

    return success(res, { message: 'Logged out successfully' });
  } catch (err) {
    console.error('Logout error:', err.message);
    return error(res, 'Failed to logout. Please try again.', 500);
  }
};

module.exports = {
  login,
  forgotPassword,
  resetPassword,
  getMe,
  changePassword,
  logout,
  isTokenBlacklisted,
};
