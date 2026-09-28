'use strict';

// B27 phase 0 (6 of 6) — staff documents leave the public folder.
//
// Staff HR documents (contracts, IDs, licences, certificates — and from B27
// phase 2, SICK NOTES, which are health data) were written to
// uploads/staff-documents/, and app.js serves the whole uploads/ folder
// statically WITHOUT a login. The file names are random, but anyone holding a
// URL could read the file. (Master handoff A5 weak point.)
//
// This moves every file in uploads/staff-documents/ to private/staff-documents/
// (git-ignored, never served statically; read only through the authenticated
// GET /api/staff/:employeeId/documents/:id/file route), rewrites each row's
// filePath to the new location and clears fileUrl — there is no public URL any
// more. app.js also refuses /uploads/staff-documents/* from this release on, so
// a file the move missed is still not served.
//
// Files only move; nothing is deleted. A file already in private/ is left
// alone (a re-run is a no-op). A row whose file is in neither folder is left
// as it is and counted in the log line. `down` moves the files back and
// restores the old fileUrl.
//
// Paths: filePath is stored absolute and was written on Windows on the VDS
// (C:\…\uploads\staff-documents\<name>). Only the file NAME is trusted — split
// on both separators — and joined onto this machine's folder.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LEGACY_DIR = path.join(ROOT, 'uploads', 'staff-documents');
const PRIVATE_DIR = path.join(ROOT, 'private', 'staff-documents');

const findTable = async (qi, name) => {
  const tables = await qi.showAllTables();
  return tables.map((t) => (typeof t === 'string' ? t : t.tableName))
    .find((t) => t.toLowerCase() === name.toLowerCase()) || null;
};

const storedName = (filePath) => String(filePath || '').split(/[\\/]/).pop();

// rename() fails across devices/volumes; fall back to copy + unlink.
const moveFile = (from, to) => {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
};

const moveAll = (fromDir, toDir) => {
  if (!fs.existsSync(fromDir)) return 0;
  fs.mkdirSync(toDir, { recursive: true });
  let moved = 0;
  for (const name of fs.readdirSync(fromDir)) {
    const from = path.join(fromDir, name);
    if (!fs.statSync(from).isFile()) continue;
    const to = path.join(toDir, name);
    if (fs.existsSync(to)) continue;           // already moved — never overwrite
    moveFile(from, to);
    moved += 1;
  }
  return moved;
};

module.exports = {
  async up(queryInterface) {
    const moved = moveAll(LEGACY_DIR, PRIVATE_DIR);

    const table = await findTable(queryInterface, 'StaffDocuments');
    if (!table) return;
    const [rows] = await queryInterface.sequelize.query(`SELECT id, filePath FROM ${table}`);
    let rewritten = 0;
    let missing = 0;
    for (const row of rows) {
      const name = storedName(row.filePath);
      const target = path.join(PRIVATE_DIR, name);
      if (!name || !fs.existsSync(target)) { missing += 1; continue; }
      await queryInterface.sequelize.query(
        `UPDATE ${table} SET filePath = :filePath, fileUrl = NULL WHERE id = :id`,
        { replacements: { filePath: target, id: row.id } }
      );
      rewritten += 1;
    }
    console.log(`[20260928000006] staff documents: ${moved} file(s) moved to private/, ${rewritten} row(s) repointed, ${missing} row(s) with no file on this machine`);
  },

  async down(queryInterface) {
    moveAll(PRIVATE_DIR, LEGACY_DIR);

    const table = await findTable(queryInterface, 'StaffDocuments');
    if (!table) return;
    const [rows] = await queryInterface.sequelize.query(`SELECT id, filePath FROM ${table}`);
    for (const row of rows) {
      const name = storedName(row.filePath);
      const target = path.join(LEGACY_DIR, name);
      if (!name || !fs.existsSync(target)) continue;
      await queryInterface.sequelize.query(
        `UPDATE ${table} SET filePath = :filePath, fileUrl = :fileUrl WHERE id = :id`,
        { replacements: { filePath: target, fileUrl: `/uploads/staff-documents/${name}`, id: row.id } }
      );
    }
  },
};
