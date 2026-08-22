// Staff profiles — the admin-side record for every member of staff (doctor,
// nurse, lab tech and the 'staff' front-desk role).
//
// Kept separate from userController, which already carries the four account
// creation paths and the Manage Users list. This file owns the profile itself:
// reading it, editing it, changing employment status and archiving it.
//
// Routes resolve on employeeId (EMP014), not the database PK — the same choice
// the patient routes make with uhid. See STAFF_PROFILE_DESIGN.md.

const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const { buildChanges } = require('../utils/auditChanges');
const db = require('../models');
const sequelize = require('../config/database');
const { STAFF_ROLES } = require('../constants/staffRoles');
const {
  PERMISSIONS, ALL_PERMISSIONS, PERMISSION_GROUPS, PERMISSIBLE_ROLES,
  hasPermission, isTrueAdmin, sanitizePermissions, sanitizeDeniedPermissions, toList,
} = require('../constants/permissions');

const { collectAllEvents } = require('./activityController');

const { User, StaffProfile, UserEditLog, UserLoginLog } = db;

// Never load these into memory on a read path, let alone risk serialising them.
const SECRET_USER_COLUMNS = ['password', 'resetToken', 'resetTokenExpires'];

// Fields the admin may edit, split by which table they live on.
const USER_FIELDS = ['firstName', 'lastName', 'email', 'phone'];

const PROFILE_FIELDS = [
  'dateOfBirth', 'gender', 'idNumber', 'photoUrl',
  'address', 'city', 'emergencyContact',
  'position', 'department', 'ward', 'employmentType', 'shift',
  'startDate', 'endDate', 'reportsToId',
  'licenseNumber', 'licenseBody', 'licenseExpiry', 'specialty',
  'qualification', 'institution', 'yearsExperience',
  'roleDetails',
];

// An empty string on a DATE column makes MySQL raise "Incorrect datetime
// value", so cleared date inputs have to become null. Same guard userController
// applies for the same reason.
const DATE_FIELDS = new Set(['dateOfBirth', 'startDate', 'endDate', 'licenseExpiry']);

// Days of notice before a licence expiry is worth surfacing.
const LICENCE_WARNING_DAYS = 60;

// =====================================
// HELPERS
// =====================================

const daysUntil = (date) => {
  if (!date) return null;
  const ms = new Date(date).getTime() - Date.now();
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
};

// One response shape for the list and the detail view, so the frontend never
// has to branch on which endpoint the data came from.
const formatStaff = (profile, user) => {
  const expiresInDays = daysUntil(profile.licenseExpiry);

  return {
    employeeId: profile.employeeId,
    userId:     user.id,

    firstName: user.firstName,
    lastName:  user.lastName,
    name:      `${user.firstName} ${user.lastName}`,
    email:     user.email,
    phone:     user.phone,
    role:      user.role,

    dateOfBirth: profile.dateOfBirth,
    gender:      profile.gender,
    idNumber:    profile.idNumber,
    photoUrl:    profile.photoUrl,

    address:          profile.address,
    city:             profile.city,
    emergencyContact: profile.emergencyContact,

    position:         profile.position,
    department:       profile.department,
    ward:             profile.ward,
    employmentType:   profile.employmentType,
    shift:            profile.shift,
    startDate:        profile.startDate,
    endDate:          profile.endDate,
    employmentStatus: profile.employmentStatus,
    reportsToId:      profile.reportsToId,

    licenseNumber:   profile.licenseNumber,
    licenseBody:     profile.licenseBody,
    licenseExpiry:   profile.licenseExpiry,
    specialty:       profile.specialty,
    qualification:   profile.qualification,
    institution:     profile.institution,
    yearsExperience: profile.yearsExperience,

    roleDetails: profile.roleDetails || {},

    // Derived for the header pills, so every caller shows the same warning at
    // the same threshold instead of each screen inventing its own.
    licenceExpiresInDays: expiresInDays,
    licenceExpiringSoon:  expiresInDays !== null && expiresInDays <= LICENCE_WARNING_DAYS,
    licenceExpired:       expiresInDays !== null && expiresInDays < 0,

    // --- Access ---
    // Read from the live user row rather than a JWT, so a revoke shows here
    // immediately. A real admin holds every permission implicitly and stores
    // none, which is why the list can be empty while the flags are true.
    permissions:     toList(user.permissions),
    // What has been explicitly WITHDRAWN, sent alongside the grants so the
    // Permissions tab can show a section as denied rather than merely
    // not-granted — two states that look identical without this.
    deniedPermissions: toList(user.deniedPermissions),
    canManageStock:  hasPermission(user, PERMISSIONS.STOCK_ACCESS),
    hasAdminAccess:  hasPermission(user, PERMISSIONS.ADMIN_ACCESS),
    canHoldPermissions: PERMISSIBLE_ROLES.includes(user.role),
    isTrueAdmin:     isTrueAdmin(user),
    passwordChangedAt: user.passwordChangedAt,

    isActive:   user.isActive,
    isArchived: !!profile.deletedAt,
    archivedAt: profile.deletedAt,

    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
};

// employmentStatus is the HR-facing detail; isActive stays the single source of
// truth for whether login is permitted. Only these two states allow a login —
// notably 'On Leave' does, because someone on annual leave should not be locked
// out of the system. Suspension is what blocks access.
const LOGIN_ALLOWED_STATUSES = new Set(['Active', 'On Leave']);

// =====================================
// CONTROLLER ACTIONS
// =====================================

/**
 * GET /api/staff
 * Lists staff with optional filters. Archived records are excluded unless
 * explicitly asked for.
 *
 * Authorization: Admin only
 */
const list = async (req, res) => {
  const { role, department, ward, status, search, includeArchived } = req.query;

  try {
    const profileWhere = {};
    if (department) profileWhere.department = department;
    if (ward)       profileWhere.ward = ward;
    if (status)     profileWhere.employmentStatus = status;
    if (includeArchived !== 'true') profileWhere.deletedAt = null;

    const userWhere = { role: role ? role : { [Op.in]: STAFF_ROLES } };

    if (search) {
      const like = { [Op.like]: `%${search}%` };
      userWhere[Op.or] = [{ firstName: like }, { lastName: like }, { email: like }];
    }

    const profiles = await StaffProfile.findAll({
      where: profileWhere,
      include: [{
        model: User,
        where: userWhere,
        required: true,
        attributes: { exclude: SECRET_USER_COLUMNS },
      }],
      order: [['employeeId', 'ASC']],
    });

    return success(res, profiles.map((p) => formatStaff(p, p.User)));
  } catch (err) {
    console.error('List staff error:', err.message);
    return error(res, 'Failed to load staff', 500);
  }
};

/**
 * GET /api/staff/:employeeId
 * Full profile. findStaff has already resolved and attached the record.
 *
 * Authorization: Admin, or the staff member themselves
 */
const getOne = async (req, res) => {
  try {
    return success(res, formatStaff(req.staffProfile, req.staffUser));
  } catch (err) {
    console.error('Get staff error:', err.message);
    return error(res, 'Failed to load staff member', 500);
  }
};

/**
 * PUT /api/staff/:employeeId
 * Updates the profile and/or the underlying user record, recording what
 * changed in UserEditLog.
 *
 * Authorization: Admin only
 */
const update = async (req, res) => {
  const profile = req.staffProfile;
  const user    = req.staffUser;
  const updates = req.body;

  if (profile.deletedAt) {
    return error(res, 'This staff member is archived. Restore them before editing.', 409);
  }

  let transaction;
  try {
    // A duplicate email would otherwise surface as a raw unique-constraint
    // error from the driver.
    if (updates.email && updates.email !== user.email) {
      const taken = await User.findOne({ where: { email: updates.email, id: { [Op.ne]: user.id } } });
      if (taken) return error(res, 'Email already in use', 400);
    }

    const userUpdates = {};
    USER_FIELDS.forEach((field) => {
      if (updates[field] !== undefined) userUpdates[field] = updates[field];
    });

    const profileUpdates = {};
    PROFILE_FIELDS.forEach((field) => {
      if (updates[field] === undefined) return;
      profileUpdates[field] = DATE_FIELDS.has(field) && updates[field] === ''
        ? null
        : updates[field];
    });

    if (!Object.keys(userUpdates).length && !Object.keys(profileUpdates).length) {
      return error(res, 'No changes supplied', 400);
    }

    const userBefore = {};
    USER_FIELDS.forEach((f) => { userBefore[f] = user[f]; });
    const profileBefore = {};
    PROFILE_FIELDS.forEach((f) => { profileBefore[f] = profile[f]; });

    transaction = await sequelize.transaction();

    if (Object.keys(userUpdates).length) {
      await user.update(userUpdates, { transaction });
    }
    if (Object.keys(profileUpdates).length) {
      await profile.update({ ...profileUpdates, updatedBy: req.user.id }, { transaction });
    }

    const changes = {
      ...buildChanges(userBefore, userUpdates),
      ...buildChanges(profileBefore, profileUpdates),
    };

    if (Object.keys(changes).length) {
      await UserEditLog.create({
        targetUserId: user.id,
        editedBy:     req.user.id,
        editedByName: `${req.user.firstName} ${req.user.lastName}`,
        changes,
        editedAt:     new Date(),
      }, { transaction });
    }

    await transaction.commit();

    await profile.reload();
    await user.reload();

    return success(res, formatStaff(profile, user));
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Update staff error:', err.message);
    return error(res, 'Failed to update staff member', 500);
  }
};

/**
 * PATCH /api/staff/:employeeId/status
 * Changes employmentStatus, keeping User.isActive in step.
 *
 * Authorization: Admin only
 */
const updateStatus = async (req, res) => {
  const { employmentStatus } = req.body;
  const profile = req.staffProfile;
  const user    = req.staffUser;

  let transaction;
  try {
    const before = {
      employmentStatus: profile.employmentStatus,
      isActive:         user.isActive,
    };

    const isActive = LOGIN_ALLOWED_STATUSES.has(employmentStatus);

    transaction = await sequelize.transaction();

    // Both writes share a transaction: if one succeeded and the other did not,
    // the account state and the HR state would disagree and nothing would
    // reconcile them.
    await profile.update({ employmentStatus, updatedBy: req.user.id }, { transaction });
    await user.update({ isActive }, { transaction });

    await UserEditLog.create({
      targetUserId: user.id,
      editedBy:     req.user.id,
      editedByName: `${req.user.firstName} ${req.user.lastName}`,
      changes:      buildChanges(before, { employmentStatus, isActive }),
      editedAt:     new Date(),
    }, { transaction });

    await transaction.commit();

    await profile.reload();
    await user.reload();

    return success(res, formatStaff(profile, user));
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Update staff status error:', err.message);
    return error(res, 'Failed to update employment status', 500);
  }
};

/**
 * DELETE /api/staff/:employeeId
 * Archives — does not destroy. A departed doctor's name is still attached to
 * prescriptions, consultation notes and lab results, so the row has to survive.
 * Login is disabled and they drop out of every list.
 *
 * Authorization: Admin only
 */
const archive = async (req, res) => {
  const profile = req.staffProfile;
  const user    = req.staffUser;

  if (profile.deletedAt) return error(res, 'This staff member is already archived', 400);

  // Without this an admin could archive themselves and immediately lose the
  // access needed to undo it.
  if (user.id === req.user.id) {
    return error(res, 'You cannot archive your own account', 400);
  }

  let transaction;
  try {
    transaction = await sequelize.transaction();

    await profile.update({
      deletedAt:        new Date(),
      deletedBy:        req.user.id,
      employmentStatus: profile.employmentStatus === 'Active' ? 'Resigned' : profile.employmentStatus,
    }, { transaction });

    await user.update({ isActive: false }, { transaction });

    await UserEditLog.create({
      targetUserId: user.id,
      editedBy:     req.user.id,
      editedByName: `${req.user.firstName} ${req.user.lastName}`,
      changes:      { archived: { from: false, to: true } },
      editedAt:     new Date(),
    }, { transaction });

    await transaction.commit();

    return success(res, { employeeId: profile.employeeId, archived: true });
  } catch (err) {
    if (transaction) await transaction.rollback();
    console.error('Archive staff error:', err.message);
    return error(res, 'Failed to archive staff member', 500);
  }
};

/**
 * PATCH /api/staff/:employeeId/restore
 * Undoes an archive. Login stays disabled until an admin reactivates the
 * account deliberately — restoring the record and restoring access are two
 * decisions, and conflating them would silently let someone back in.
 *
 * Authorization: Admin only
 */
const restore = async (req, res) => {
  const profile = req.staffProfile;
  const user    = req.staffUser;

  if (!profile.deletedAt) return error(res, 'This staff member is not archived', 400);

  try {
    await profile.update({
      deletedAt: null,
      deletedBy: null,
      updatedBy: req.user.id,
    });

    await UserEditLog.create({
      targetUserId: user.id,
      editedBy:     req.user.id,
      editedByName: `${req.user.firstName} ${req.user.lastName}`,
      changes:      { archived: { from: true, to: false } },
      editedAt:     new Date(),
    });

    await profile.reload();
    return success(res, formatStaff(profile, user));
  } catch (err) {
    console.error('Restore staff error:', err.message);
    return error(res, 'Failed to restore staff member', 500);
  }
};

/**
 * PATCH /api/staff/:employeeId/permissions
 * Replaces the granted permission list.
 *
 * Authorization: a REAL admin account, not merely someone holding admin.access.
 * If a granted user could grant, the capability would propagate on its own and
 * could never be reliably revoked — the same reasoning as requireTrueAdmin in
 * middleware/auth.js.
 */
const updatePermissions = async (req, res) => {
  const user = req.staffUser;
  const { permissions, deniedPermissions } = req.body;

  if (!PERMISSIBLE_ROLES.includes(user.role)) {
    return error(res, `Permissions cannot be granted to a ${user.role} account`, 400);
  }

  try {
    // Unknown names are dropped rather than stored, so a typo grants nothing
    // instead of persisting a string that is never checked.
    const nextGranted = sanitizePermissions(permissions);

    // Denials are optional in the payload: a caller that sends only
    // `permissions` (the pre-split API, and the Manage Users screen) leaves the
    // withdrawals untouched rather than silently clearing them.
    const nextDenied = deniedPermissions === undefined
      ? (user.deniedPermissions || [])
      : sanitizeDeniedPermissions(deniedPermissions);

    // A capability cannot be granted and withdrawn at once. The withdrawal
    // wins — it is the more restrictive statement, and it is what
    // effectivePermissions() would conclude anyway, so storing anything else
    // would leave a row that reads differently from how it behaves.
    const conflicting = nextGranted.filter((p) => nextDenied.includes(p));
    const granted = nextGranted.filter((p) => !nextDenied.includes(p));

    const before = {
      permissions:       user.permissions || [],
      deniedPermissions: user.deniedPermissions || [],
    };
    const after = { permissions: granted, deniedPermissions: nextDenied };

    await user.update(after);

    // Granting and withdrawing are both auditable admin actions, so both sides
    // go into the same UserEditLog row the Activity tab already reads — who,
    // when, and the before/after of each list.
    await UserEditLog.create({
      targetUserId: user.id,
      editedBy:     req.user.id,
      editedByName: `${req.user.firstName} ${req.user.lastName}`,
      changes:      buildChanges(before, after),
      editedAt:     new Date(),
    });

    if (conflicting.length) {
      console.warn(
        `Permissions for user ${user.id}: ${conflicting.join(', ')} sent as both granted and withdrawn — withdrawal applied.`
      );
    }

    await user.reload();
    return success(res, formatStaff(req.staffProfile, user));
  } catch (err) {
    console.error('Update staff permissions error:', err.message);
    return error(res, 'Failed to update permissions', 500);
  }
};

/**
 * GET /api/staff/permissions/catalog
 * The permission vocabulary, so the Access tab renders one toggle per
 * capability without the frontend keeping its own copy of the list.
 *
 * Authorization: Admin only
 */
const permissionCatalog = async (_req, res) =>
  success(res, {
    permissions: ALL_PERMISSIONS,
    // The group/area/toggle shape the tab renders. Served from the backend so
    // the screen cannot drift from the vocabulary the routes actually enforce.
    groups: PERMISSION_GROUPS,
    permissibleRoles: PERMISSIBLE_ROLES,
  });

/**
 * GET /api/staff/expiring-licences
 * Licences already expired or expiring within LICENCE_WARNING_DAYS.
 * A clinician practising on a lapsed licence is a real liability, so this is
 * surfaced rather than left for someone to notice.
 *
 * Authorization: Admin only
 */
const expiringLicences = async (req, res) => {
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + LICENCE_WARNING_DAYS);

    const profiles = await StaffProfile.findAll({
      where: {
        deletedAt:     null,
        licenseExpiry: { [Op.ne]: null, [Op.lte]: cutoff },
      },
      include: [{ model: User, required: true, attributes: { exclude: SECRET_USER_COLUMNS } }],
      order: [['licenseExpiry', 'ASC']],
    });

    return success(res, profiles.map((p) => formatStaff(p, p.User)));
  } catch (err) {
    console.error('Expiring licences error:', err.message);
    return error(res, 'Failed to load expiring licences', 500);
  }
};

/**
 * GET /api/staff/:employeeId/activity
 * Login history and edit history for the Activity tab.
 *
 * Authorization: Admin only
 */
const activity = async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const { startDate, endDate } = req.query;

  // Optional date window, applied to every source.
  const dateFilter = {};
  if (startDate) dateFilter[Op.gte] = new Date(startDate);
  if (endDate) { const e = new Date(endDate); e.setHours(23, 59, 59, 999); dateFilter[Op.lte] = e; }
  const hasDateFilter = !!(startDate || endDate);

  try {
    const [logins, edits, allEvents] = await Promise.all([
      UserLoginLog.findAll({
        where: { userId: req.staffUser.id, ...(hasDateFilter ? { loginAt: dateFilter } : {}) },
        order: [['loginAt', 'DESC']], limit,
      }),
      UserEditLog.findAll({
        where: { targetUserId: req.staffUser.id, ...(hasDateFilter ? { editedAt: dateFilter } : {}) },
        order: [['editedAt', 'DESC']], limit,
      }),
      // Clinical/operational activity — same derivation as the admin Activity Log
      // (one source of truth), filtered to this staff.
      collectAllEvents(dateFilter, hasDateFilter),
    ]);

    // Match events to this staff member by name (event.staff is a display string:
    // "Dr. First Last" for doctors, "First Last" otherwise — both contain the name).
    const fullName = `${req.staffUser.firstName} ${req.staffUser.lastName}`.trim().toLowerCase();
    const clinical = allEvents
      .filter((e) => e.staff && e.staff.toLowerCase().includes(fullName))
      // Logins come from UserLoginLog below (authoritative, by id); account_created
      // is about creating OTHER accounts, not this person's own activity.
      .filter((e) => e.type !== 'user_login' && e.type !== 'account_created')
      .map((e) => ({ type: e.type, label: e.label, patient: e.patient, uhid: e.uhid, detail: e.detail, timestamp: e.timestamp }));

    const loginEvents = logins.map((l) => ({
      type: 'user_login', label: 'Logged in', patient: null, uhid: null,
      detail: l.ipAddress ? `IP ${l.ipAddress}` : null, timestamp: l.loginAt,
    }));

    const editEvents = edits.map((e) => {
      const fields = Object.keys(e.changes || {});
      const who = e.editedByName && !/undefined/i.test(e.editedByName) ? e.editedByName : 'System';
      const isPerm = fields.includes('permissions') || fields.includes('deniedPermissions');
      return {
        type: isPerm ? 'permissions_changed' : 'profile_updated',
        label: isPerm ? 'Permissions changed' : 'Profile updated',
        patient: null, uhid: null,
        detail: `${fields.join(', ') || 'no fields'} · by ${who}`,
        timestamp: e.editedAt,
      };
    });

    // One chronological stream — logins + profile edits + every recorded action.
    const timeline = [...clinical, ...loginEvents, ...editEvents]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);

    return success(res, { timeline });
  } catch (err) {
    console.error('Staff activity error:', err.message);
    return error(res, 'Failed to load activity', 500);
  }
};

module.exports = {
  list,
  getOne,
  update,
  updateStatus,
  updatePermissions,
  permissionCatalog,
  archive,
  restore,
  expiringLicences,
  activity,
  // Exported for reuse by userController so both files format staff identically.
  formatStaff,
};
