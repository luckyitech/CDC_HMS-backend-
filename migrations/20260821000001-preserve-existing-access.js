'use strict';

// NOBODY LOSES ANYTHING ON DEPLOY DAY.
//
// The clinical/non-clinical split narrows what a role carries. Applied to a
// live clinic as-is, that means people arrive on Monday unable to do what they
// did on Friday — a receptionist who triages, a nurse covering the front desk.
// The classification is a starting point for decisions an administrator makes
// deliberately, over time, through the Permissions tab. It is not a purge, and
// it must not run like one.
//
// So this writes out, as explicit grants, exactly what each EXISTING account
// could do under the gates as they stood before this branch. Their access on
// the first request after deploy is identical to their last request before it.
//
// New accounts are unaffected: this runs once, over the rows that exist when it
// runs. Anyone added afterwards follows the new model — clinical staff get the
// clinical bundle, non-clinical staff start with nothing extra, and the admin
// ticks the exceptions.
//
// WHAT EACH ROLE COULD DO BEFORE, read off main:
//
//   consultation notes, treatment plans, vitals reads, GLP-1 reads, equipment
//   reads       CLINICAL_READ_ROLES = doctor, staff, nurse, lab, admin
//   nursing notes (read and write)  ['doctor','staff','nurse','admin']
//   vitals write                    ['staff','nurse']
//   GLP-1 write, equipment write    ['doctor','nurse','staff']
//   stock use / checkout / return   ['doctor','nurse','staff','admin']
//   thyroid authoring and signing   ['doctor','staff','admin']
//   ultrasound edited still         ['doctor','nurse','staff','admin']
//   drug round                      ['nurse']
//
// A REAL ADMIN ACCOUNT is skipped: it holds everything implicitly and stores
// nothing, and writing a list onto it would be the first row that ever
// disagreed with that.
//
// PATIENTS are skipped: none of these were ever open to them.

const PRE_BRANCH_ACCESS = {
  doctor: [
    'clinical.view', 'clinical.record', 'glp1.write',
    'equipment.write', 'stock.dispense', 'radiology.write',
  ],
  // The bin this whole branch is about. It held receptionists, administration
  // and nurses alike, so every one of them carried the full clinical set —
  // including signing an ultrasound report. That is precisely the defect being
  // fixed, and it is still what they had yesterday, so it is preserved and
  // then untickable per person. See the note at the end of this file.
  staff: [
    'clinical.view', 'clinical.record', 'glp1.write',
    'equipment.write', 'stock.dispense', 'radiology.write',
  ],
  nurse: [
    'clinical.view', 'clinical.record', 'glp1.write',
    'equipment.write', 'stock.dispense', 'radiology.write', 'mar.administer',
  ],
  // Read the clinical record for context, and nothing else. Deliberately not
  // given the write half: the old gates on vitals and nursing notes named
  // doctor, staff and nurse, never lab.
  lab: ['clinical.view'],
};

const TABLE = 'Users';

const resolveTable = async (queryInterface, name) => {
  const tables = await queryInterface.showAllTables();
  return tables.find((t) => String(t).toLowerCase() === name.toLowerCase());
};

module.exports = {
  async up(queryInterface) {
    const table = await resolveTable(queryInterface, TABLE);
    if (!table) return;

    const [users] = await queryInterface.sequelize.query(
      `SELECT id, role, permissions FROM \`${table}\`
       WHERE role IN ('doctor', 'staff', 'nurse', 'lab')`
    );

    for (const user of users) {
      const carried = PRE_BRANCH_ACCESS[user.role];
      if (!carried) continue;

      // Whatever is already granted stays. This adds; it never replaces, so a
      // grant an administrator made by hand survives untouched.
      let existing = [];
      try {
        const raw = user.permissions;
        existing = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
        if (!Array.isArray(existing)) existing = [];
      } catch {
        existing = [];        // unparseable column — treat as empty, never throw
      }

      const merged = [...new Set([...existing, ...carried])];
      if (merged.length === existing.length) continue;   // nothing to add

      await queryInterface.sequelize.query(
        `UPDATE \`${table}\` SET permissions = :perms WHERE id = :id`,
        { replacements: { perms: JSON.stringify(merged), id: user.id } }
      );
    }
  },

  async down(queryInterface) {
    // Deliberately does nothing.
    //
    // Rolling this back would mean stripping capabilities from live accounts to
    // restore a state where the same access came from a role instead of a
    // grant — the same access, reached differently, at the risk of taking away
    // something an administrator has since granted deliberately. There is no
    // safe automatic reversal, and an unsafe one is worse than none.
    //
    // To undo it for one person, untick the boxes on their Permissions tab.
  },
};

// AFTER DEPLOY — the list worth reviewing.
//
// Preserving everything means preserving things nobody uses. Every account with
// role 'staff' now explicitly holds radiology.write, because the old thyroid
// gate listed 'staff' — so a receptionist can, on paper, sign an ultrasound
// report. No one ever has: the thyroid tables are empty. The same is true of
// GLP-1, which is granted to everyone who had it and used by nobody.
//
// None of that is urgent, and none of it is new — it is the state the clinic has
// been running in. But it is now VISIBLE and untickable per person, which it has
// never been before. Working through it is the point of the exercise; doing it
// on deploy morning is not.
