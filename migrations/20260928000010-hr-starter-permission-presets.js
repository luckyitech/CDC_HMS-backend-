'use strict';

// HR Suite Tier 3, Phase 0 (2 Oct 2026, decision P-10) — four starter
// permission presets for the delegated HR controls:
//   HR manager, HR officer, Nurse in charge, Line manager.
// See claude/hr-tier3-phase0-permissions-mockup.html (section D).
//
// Data only; no schema. A preset is a TEMPLATE (models/PermissionPreset.js):
// creating these changes nobody's access. The clinic can rename, edit or
// archive them in Admin → Settings → Permission presets.
//
// Never carries admin.access, permissions.grant, hr.confidential or hr.grant
// (PRESET_EXCLUDED) — so the HR manager preset does not make an HR grantor;
// a permissions administrator ticks "Grant HR permissions" by hand.
//
// The lists are written out literally rather than computed from
// constants/permissions.js, so a later vocabulary change cannot alter what this
// migration inserted. They are already in stored form (each acting capability
// with the read it needs). Department limits arrive with Tier 3 Phase 1.
//
// up: inserts each preset only if no ACTIVE preset already has that name.
// down: removes the ones this migration made (createdById NULL) — and REFUSES
// if any of them has since been edited or applied, because removing it would
// then lose the clinic's own work.

const TABLE = 'PermissionPresets';

const PRESETS = [
  {
    name: 'HR manager',
    description: 'Runs the HR Suite: staff files, onboarding, employment status, attendance, '
      + 'leave (including sick-leave details and the policy), CPD and HR settings. '
      + 'Does not include confidential documents or granting HR permissions — tick those by hand.',
    baseRole: 'staff', staffType: 'non_clinical', position: 'HR manager', department: null,
    permissions: [
      'staff.view', 'staff.edit', 'staff.onboard', 'staff.status', 'staff.documents', 'hr.profile.approve',
      'hr.view', 'hr.attendance.amend', 'hr.workhours', 'hr.tags',
      'leave.approve', 'leave.view', 'leave.manage', 'leave.policy',
      'cpd.verify', 'hr.expiry.alerts', 'hr.settings',
    ],
    deniedPermissions: [],
  },
  {
    name: 'HR officer',
    description: 'Day-to-day HR: staff files and documents, attendance, recording leave, '
      + 'required approvers, the leave register, profile requests and CPD. '
      + 'No sick-leave details, onboarding, employment status, leave policy or HR settings.',
    baseRole: 'staff', staffType: 'non_clinical', position: 'HR officer', department: null,
    permissions: [
      'staff.view', 'staff.edit', 'staff.documents', 'hr.profile.approve',
      'hr.view', 'hr.attendance.amend', 'hr.workhours', 'hr.tags',
      'leave.view', 'leave.manage',
      'cpd.verify', 'hr.expiry.alerts',
    ],
    // leave.manage carries sick-leave details; the officer is held back from them.
    deniedPermissions: ['leave.sick'],
  },
  {
    name: 'Nurse in charge',
    description: 'Leads the nurses: opens their staff files, sees and corrects their attendance, '
      + 'can be chosen to approve their leave and sees who is away, and gets their expiry alerts. '
      + 'Limited to their own department once departments are set up.',
    baseRole: 'nurse', staffType: 'clinical', position: 'Nurse in charge', department: null,
    permissions: [
      'staff.view', 'hr.view', 'hr.attendance.amend', 'leave.approve', 'leave.view', 'hr.expiry.alerts',
    ],
    deniedPermissions: [],
  },
  {
    name: 'Line manager',
    description: 'Supervises a team: opens their staff files, sees their attendance, can be chosen '
      + 'to approve their leave and sees who is away. Changes nothing.',
    baseRole: 'staff', staffType: 'non_clinical', position: null, department: null,
    permissions: ['staff.view', 'hr.view', 'leave.approve', 'leave.view'],
    deniedPermissions: [],
  },
];

const resolveTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};

const names = PRESETS.map((p) => p.name);

module.exports = {
  PRESETS,

  async up(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) throw new Error('PermissionPresets table missing — run the earlier migrations first');

    const [existing] = await queryInterface.sequelize.query(
      `SELECT name FROM \`${table}\` WHERE status = 'active' AND name IN (:names)`,
      { replacements: { names } },
    );
    const taken = new Set(existing.map((r) => String(r.name).toLowerCase()));
    const now = new Date();
    const rows = PRESETS
      .filter((p) => !taken.has(p.name.toLowerCase()))
      .map((p) => ({
        ...p,
        permissions: JSON.stringify(p.permissions),
        deniedPermissions: JSON.stringify(p.deniedPermissions),
        status: 'active',
        appliedCount: 0,
        createdById: null,
        updatedById: null,
        createdAt: now,
        updatedAt: now,
      }));
    if (rows.length) await queryInterface.bulkInsert(table, rows);
    console.log(`[migrate] HR starter presets: ${rows.length} added, ${PRESETS.length - rows.length} already present`);
  },

  async down(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;
    const [mine] = await queryInterface.sequelize.query(
      `SELECT id, name, appliedCount, updatedById FROM \`${table}\` WHERE createdById IS NULL AND name IN (:names)`,
      { replacements: { names } },
    );
    const touched = mine.filter((r) => Number(r.appliedCount) > 0 || r.updatedById !== null);
    if (touched.length) {
      throw new Error(`Refusing to remove starter presets the clinic has edited or used: ${touched.map((r) => r.name).join(', ')}. Archive them in Settings instead.`);
    }
    if (mine.length) {
      await queryInterface.bulkDelete(table, { id: mine.map((r) => r.id) });
    }
  },
};
