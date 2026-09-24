// =====================================================================
// HR Suite (B21) — missed check-out sweep.
//
// A session still 'open' after the clinic day it belongs to has ended is a
// forgotten tap-out. Every five minutes (and once at boot) such rows become
// 'missed_checkout': hours stop accruing, the calendar shows an outlined
// out-star, and the HR dashboard lists it under "Needs attention" until HR
// amends it with a reason. Nothing is guessed — no default shift length.
//
// Armed from server.js beside the Lab Inbox poller, inside its own try/catch,
// so a failure here can never affect the API.
// =====================================================================

const { Op } = require('sequelize');
const db = require('../models');
const { clinicToday } = require('../utils/clinicTime');
const { parseJsonColumn } = require('../utils/jsonColumn');

const { StaffAttendance } = db;

const INTERVAL_MS = 5 * 60 * 1000;
let timer = null;

const runSweep = async (now = new Date()) => {
  const today = clinicToday(now);
  const stale = await StaffAttendance.findAll({ where: { status: 'open', clinicDate: { [Op.lt]: today } } });
  for (const row of stale) {
    const diag = parseJsonColumn(row.diagnostics) || {};
    await row.update({ status: 'missed_checkout', diagnostics: { ...diag, sweptAt: now.toISOString() } });
  }
  if (stale.length) console.log(`[HR] missed-checkout sweep closed ${stale.length}`);
  return stale.length;
};

const startScheduler = () => {
  if (timer) return;
  runSweep().catch((err) => console.error('[HR] missed-checkout sweep failed:', err.message));
  timer = setInterval(() => {
    runSweep().catch((err) => console.error('[HR] missed-checkout sweep failed:', err.message));
  }, INTERVAL_MS);
  if (timer.unref) timer.unref();
  console.log('[HR] missed-checkout sweep armed (every 5 minutes).');
};

const stopScheduler = () => { if (timer) { clearInterval(timer); timer = null; } };

module.exports = { runSweep, startScheduler, stopScheduler };
