// Departments and Positions — the clinic's managed lists (HR Tier 3 Phase 1,
// T3-2a, decisions L-1…L-4, Emu 2 Oct 2026).
//
// THE ONE WRITE PATH for a staff member's department and position:
//   resolveListFields()  turns what a screen sent (an id, or legacy text) into
//                        the four columns to write — departmentId + department
//                        (display copy), positionId + position (display copy).
//                        Used by onboarding (userController.createStaffAccount),
//                        the staff file (staffController.update) and Manage Users
//                        (userController.updateUser).
//   renameEntry()        renames a list entry AND rewrites the display copy on
//                        every file that uses it, in one transaction.
//   tidyGroups()/applyTidy()  the one-off tidy screen: today's free text,
//                        grouped, mapped onto list entries.
//
// The text columns StaffProfile.department / position stay because about
// fifteen readers (leave, attendance, mail, approvals …) display them. They are
// written ONLY here, from the list, so they cannot drift (L-1).
//
// Before the clinic has any entry on a list, typed text is still accepted as it
// was (so onboarding keeps working on deploy day); once the list has entries, a
// screen must pick from it (UNKNOWN_DEPARTMENT / UNKNOWN_POSITION).

const db = require('../models');

const KINDS = {
  department: { model: () => db.Department, idField: 'departmentId', textField: 'department', label: 'department' },
  position:   { model: () => db.Position,   idField: 'positionId',   textField: 'position',   label: 'position' },
};
const CADRES = ['doctor', 'nurse', 'lab', 'staff'];

class ListError extends Error {
  constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

/** Grouping key for free text: case, spaces and punctuation ignored. */
const normalise = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const cleanName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// The lists
// ---------------------------------------------------------------------------

/** Both lists with how many (non-archived) staff files use each entry. */
const lists = async () => {
  const [departments, positions, profiles] = await Promise.all([
    db.Department.findAll({ order: [['name', 'ASC']], raw: true }),
    db.Position.findAll({ order: [['name', 'ASC']], raw: true }),
    db.StaffProfile.findAll({ where: { deletedAt: null }, attributes: ['departmentId', 'positionId'], raw: true }),
  ]);
  const tally = (field) => profiles.reduce((m, p) => { if (p[field]) m.set(p[field], (m.get(p[field]) || 0) + 1); return m; }, new Map());
  const d = tally('departmentId'); const p = tally('positionId');
  return {
    departments: departments.map((x) => ({ id: x.id, name: x.name, status: x.status, staffCount: d.get(x.id) || 0 })),
    positions: positions.map((x) => ({ id: x.id, name: x.name, cadre: x.cadre, status: x.status, staffCount: p.get(x.id) || 0 })),
  };
};

const findByName = async (kind, name, { transaction, exceptId } = {}) => {
  const rows = await KINDS[kind].model().findAll({ attributes: ['id', 'name', 'status'], transaction });
  const key = normalise(name);
  return rows.find((r) => normalise(r.name) === key && r.id !== exceptId) || null;
};

/** Add an entry. Names are unique ignoring case and punctuation (L-3). */
const createEntry = async (kind, { name, cadre }, actorId) => {
  const clean = cleanName(name);
  if (clean.length < 2 || clean.length > 120) throw new ListError(`Give the ${KINDS[kind].label} a name`, 'NAME_REQUIRED');
  if (kind === 'position' && cadre != null && cadre !== '' && !CADRES.includes(cadre)) throw new ListError('Unknown cadre', 'BAD_CADRE');
  const clash = await findByName(kind, clean);
  if (clash) throw new ListError(`"${clash.name}" is already on the list${clash.status === 'archived' ? ' (archived — restore it instead)' : ''}`, 'NAME_EXISTS', 409);
  const row = await KINDS[kind].model().create({
    name: clean, createdById: actorId, status: 'active',
    ...(kind === 'position' ? { cadre: cadre || null } : {}),
  });
  return row.get({ plain: true });
};

/**
 * Rename, re-cadre, archive or restore an entry. A rename rewrites the display
 * copy on every staff file that uses it (same transaction). Archiving a
 * department or position is refused while an active (non-archived) staff file
 * still uses it (L-3).
 * Returns { entry, before, after, filesRenamed }.
 */
const updateEntry = async (kind, id, { name, cadre, status }) => {
  const { model, idField, textField, label } = KINDS[kind];
  return db.sequelize.transaction(async (transaction) => {
    const row = await model().findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw new ListError(`Unknown ${label}`, 'NOT_FOUND', 404);
    // A copy: get({ plain: true }) hands back the live dataValues, which the
    // update below would rewrite (the audit trail would then see no change).
    const before = { ...row.get({ plain: true }) };
    const patch = {};
    let filesRenamed = 0;

    if (name !== undefined) {
      const clean = cleanName(name);
      if (clean.length < 2 || clean.length > 120) throw new ListError(`Give the ${label} a name`, 'NAME_REQUIRED');
      if (clean !== row.name) {
        const clash = await findByName(kind, clean, { transaction, exceptId: row.id });
        if (clash) throw new ListError(`"${clash.name}" is already on the list`, 'NAME_EXISTS', 409);
        patch.name = clean;
      }
    }
    if (kind === 'position' && cadre !== undefined) {
      if (cadre !== null && cadre !== '' && !CADRES.includes(cadre)) throw new ListError('Unknown cadre', 'BAD_CADRE');
      patch.cadre = cadre || null;
    }
    if (status !== undefined) {
      if (!['active', 'archived'].includes(status)) throw new ListError('Unknown status', 'BAD_STATUS');
      if (status === 'archived' && row.status !== 'archived') {
        const inUse = await db.StaffProfile.count({ where: { [idField]: row.id, deletedAt: null }, transaction });
        if (inUse) throw new ListError(`${inUse} staff file${inUse === 1 ? '' : 's'} still use this ${label}. Move them first.`, 'IN_USE', 409);
      }
      patch.status = status;
    }
    if (!Object.keys(patch).length) return { entry: before, before, after: before, filesRenamed };

    await row.update(patch, { transaction });
    if (patch.name) {
      const [n] = await db.StaffProfile.update({ [textField]: patch.name }, { where: { [idField]: row.id }, transaction });
      filesRenamed = n;
    }
    const after = row.get({ plain: true });
    return { entry: after, before, after, filesRenamed };
  });
};

// ---------------------------------------------------------------------------
// The one write path for a staff file's department / position
// ---------------------------------------------------------------------------

/**
 * What to write to StaffProfile for the department and position a screen sent.
 * Accepts { departmentId, department, positionId, position } (any subset);
 * returns only the columns to change. Throws ListError.
 *
 * @param current   the profile as it is now (null when creating) — keeping an
 *                  entry that has since been archived is allowed; choosing one
 *                  is not.
 * @param lenient   text that matches nothing is kept as text (role defaults
 *                  such as "Laboratory" at onboarding) rather than refused.
 */
const resolveListFields = async (input, { current = null, lenient = false, transaction } = {}) => {
  const out = {};
  for (const kind of Object.keys(KINDS)) {
    const { model, idField, textField, label } = KINDS[kind];
    const hasId = Object.prototype.hasOwnProperty.call(input, idField) && input[idField] !== undefined;
    const hasText = Object.prototype.hasOwnProperty.call(input, textField) && input[textField] !== undefined;
    if (!hasId && !hasText) continue;

    if (hasId) {
      const raw = input[idField];
      if (raw === null || raw === '') { out[idField] = null; out[textField] = null; continue; }
      const id = Number(raw);
      const row = Number.isInteger(id) ? await model().findByPk(id, { transaction }) : null;
      if (!row) throw new ListError(`Choose a ${label} from the list`, kind === 'department' ? 'UNKNOWN_DEPARTMENT' : 'UNKNOWN_POSITION');
      const keeping = current && Number(current[idField]) === row.id;
      if (row.status !== 'active' && !keeping) throw new ListError(`That ${label} is archived`, 'ARCHIVED_ENTRY');
      out[idField] = row.id; out[textField] = row.name;
      continue;
    }

    // Legacy text (older screens, Manage Users, onboarding defaults).
    const text = cleanName(input[textField]);
    // The same text sent back unchanged (a screen that posts every field) is
    // not a change — never refuse a save over a field nobody touched.
    if (current && normalise(current[textField]) === normalise(text)) continue;
    if (!text) { out[idField] = null; out[textField] = null; continue; }
    const match = await findByName(kind, text, { transaction });
    if (match && match.status === 'active') { out[idField] = match.id; out[textField] = match.name; continue; }
    const anyActive = await model().count({ where: { status: 'active' }, transaction });
    if (!anyActive || lenient) { out[idField] = null; out[textField] = text; continue; }
    throw new ListError(`Choose a ${label} from the list — "${text}" is not on it`, kind === 'department' ? 'UNKNOWN_DEPARTMENT' : 'UNKNOWN_POSITION');
  }
  return out;
};

// ---------------------------------------------------------------------------
// The one-off tidy screen
// ---------------------------------------------------------------------------

/**
 * Free text on staff files that is not yet linked to a list entry, grouped by
 * spelling (case/space/punctuation ignored), with how many files use it and a
 * suggested entry when one matches by name.
 */
const tidyGroups = async () => {
  const [profiles, departments, positions] = await Promise.all([
    db.StaffProfile.findAll({ attributes: ['id', 'department', 'departmentId', 'position', 'positionId', 'deletedAt'], raw: true }),
    db.Department.findAll({ where: { status: 'active' }, raw: true }),
    db.Position.findAll({ where: { status: 'active' }, raw: true }),
  ]);
  const build = (idField, textField, entries) => {
    const groups = new Map();
    profiles.filter((p) => !p[idField]).forEach((p) => {
      const key = normalise(p[textField]);
      const g = groups.get(key) || { key, spellings: new Set(), staff: 0, archived: 0 };
      if (p[textField]) g.spellings.add(cleanName(p[textField]));
      if (p.deletedAt) g.archived += 1; else g.staff += 1;
      groups.set(key, g);
    });
    return [...groups.values()]
      .map((g) => ({
        key: g.key, spellings: [...g.spellings].sort(), staff: g.staff, archived: g.archived,
        suggestedId: g.key ? (entries.find((e) => normalise(e.name) === g.key)?.id || null) : null,
      }))
      .sort((a, b) => (a.key === '') - (b.key === '') || (b.staff + b.archived) - (a.staff + a.archived) || a.key.localeCompare(b.key));
  };
  return {
    departments: build('departmentId', 'department', departments),
    positions: build('positionId', 'position', positions),
  };
};

/**
 * Apply the tidy mapping. mapping = { departments: [{ key, departmentId|null }],
 * positions: [{ key, positionId|null }] } — null leaves those files as they
 * are. Only files still unlinked are touched. Every file changed gets a
 * UserEditLog row. Returns { departments: n, positions: n } files changed.
 */
const applyTidy = async (mapping, actor) => {
  return db.sequelize.transaction(async (transaction) => {
    const counts = { departments: 0, positions: 0 };
    const profiles = await db.StaffProfile.findAll({ transaction, lock: transaction.LOCK.UPDATE });
    const plans = [
      ['departments', 'department', 'departmentId', db.Department],
      ['positions', 'position', 'positionId', db.Position],
    ];
    const changesByUser = new Map();
    for (const [listKey, textField, idField, Model] of plans) {
      for (const m of (Array.isArray(mapping?.[listKey]) ? mapping[listKey] : [])) {
        const targetId = m?.[idField];
        if (targetId == null || targetId === '') continue;
        const entry = await Model.findByPk(Number(targetId), { transaction });
        if (!entry || entry.status !== 'active') throw new ListError(`Choose an active ${textField} for "${m.key || 'blank'}"`, 'ARCHIVED_ENTRY');
        const key = String(m.key ?? '');
        for (const p of profiles) {
          if (p[idField] || normalise(p[textField]) !== key) continue;
          const before = p[textField];
          await p.update({ [idField]: entry.id, [textField]: entry.name, updatedBy: actor.id }, { transaction });
          counts[listKey] += 1;
          const c = changesByUser.get(p.UserId) || {};
          c[textField] = { from: before ?? null, to: entry.name };
          changesByUser.set(p.UserId, c);
        }
      }
    }
    for (const [userId, changes] of changesByUser) {
      await db.UserEditLog.create({
        targetUserId: userId, editedBy: actor.id,
        editedByName: `${actor.name || `user #${actor.id}`} (lists tidy)`,
        changes, editedAt: new Date(),
      }, { transaction });
    }
    return counts;
  });
};

module.exports = {
  ListError, CADRES, normalise,
  lists, createEntry, updateEntry, resolveListFields, tidyGroups, applyTidy,
  // for scope checks on a department change (L-7)
  KINDS,
};
