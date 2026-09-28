// Where staff HR documents live on disk (B27 phase 0).
//
// private/staff-documents/ — git-ignored and NEVER served statically. Files
// are read only through the authenticated GET /api/staff/:employeeId/documents/
// :id/file route, which applies the confidential-drawer rules. Until B27 they
// were written to uploads/staff-documents/, which app.js served to anyone with
// the URL; migration 20260928000006 moved them, and app.js now refuses that
// path outright.
//
// One module so the uploader, the file route and the migration's successor
// code agree on the folder. (The migration keeps its own copy of the paths on
// purpose — a migration must not change behaviour when this file changes.)

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const STAFF_DOCUMENT_DIR = path.join(ROOT, 'private', 'staff-documents');
const LEGACY_STAFF_DOCUMENT_DIR = path.join(ROOT, 'uploads', 'staff-documents');

const ensureStaffDocumentDir = () => {
  if (!fs.existsSync(STAFF_DOCUMENT_DIR)) fs.mkdirSync(STAFF_DOCUMENT_DIR, { recursive: true });
  return STAFF_DOCUMENT_DIR;
};

/**
 * The stored file NAME from a row's filePath. Split on both separators: a path
 * written on the Windows VDS (C:\…\x.pdf) read on a Mac would otherwise come
 * back whole from path.basename.
 */
const storedName = (filePath) => String(filePath || '').split(/[\\/]/).pop();

/**
 * The file on disk for a stored document, or null.
 *
 * Only the NAME is trusted, and it is joined onto a known folder — a tampered
 * filePath can't point anywhere else. The private folder is checked first; the
 * legacy folder is a fallback for a file the move missed (still only served
 * through this authenticated route — the static path is blocked).
 */
const resolveStoredFile = (filePath) => {
  const name = storedName(filePath);
  if (!name || name === '.' || name === '..') return null;
  for (const dir of [STAFF_DOCUMENT_DIR, LEGACY_STAFF_DOCUMENT_DIR]) {
    const candidate = path.join(dir, name);
    if (path.dirname(candidate) !== dir) continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

module.exports = {
  STAFF_DOCUMENT_DIR,
  LEGACY_STAFF_DOCUMENT_DIR,
  ensureStaffDocumentDir,
  storedName,
  resolveStoredFile,
};
