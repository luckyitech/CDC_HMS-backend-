// CSV for downloads (HR Tier 2 — shared by the attendance register and the
// leave register). Excel-friendly: a UTF-8 byte-order mark so names with
// accents open correctly, CRLF line ends, and every cell that holds a comma,
// quote or line break is quoted. A cell that starts with = + - @ is prefixed
// with an apostrophe so a spreadsheet never runs it as a formula.

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const csvText = (headers, rows) => `﻿${[headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}`;

/** Send rows as a CSV download (the one place a controller bypasses utils/response). */
const sendCsv = (res, filename, headers, rows) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${String(filename).replace(/[^\w.-]/g, '_')}"`);
  return res.status(200).send(csvText(headers, rows));
};

module.exports = { csvCell, csvText, sendCsv };
