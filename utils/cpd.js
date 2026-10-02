// CPD — pure rules, no database. B27 phase 5 (decision D12; 29 Sep 2026).
//
// Continuing professional development is counted per CALENDAR YEAR against a
// per-cadre target (HR-editable; defaults doctor 50 / nurse 30 / lab 20 /
// staff 0). The progress bar counts HR-VERIFIED points only — that is the
// figure that stands for governance; points logged but not yet verified show
// as a separate, lighter segment and never inflate the official number.
//
// The controller loads the rows and asks these functions; nothing here touches
// the database. Points are DECIMAL — always read through Number().

const CPD_CATEGORIES = ['conference', 'course', 'webinar', 'workshop', 'self-study', 'other'];

// The four cadres a CPD target can be set for. Front desk, admin and any other
// internal role fall under 'staff'.
const CPD_CADRES = ['doctor', 'nurse', 'lab', 'staff'];
const cadreForRole = (role) => (CPD_CADRES.includes(role) ? role : 'staff');

const DEFAULT_TARGETS = { doctor: 50, nurse: 30, lab: 20, staff: 0 };

/** A clean targets object (validating a settings write): each cadre 0–1000. */
const cleanTargets = (value) => {
  let obj = value;
  if (typeof value === 'string') { try { obj = JSON.parse(value); } catch { obj = null; } }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  for (const cadre of CPD_CADRES) {
    const n = Number(obj[cadre]);
    out[cadre] = Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 10) / 10 : DEFAULT_TARGETS[cadre];
  }
  return out;
};

const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())
  && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * Validates a CPD entry a person is logging or editing.
 * @returns {{ ok:boolean, error?:string, value?:object }}
 */
const validateCpd = (body = {}) => {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return { ok: false, error: 'TITLE_REQUIRED' };
  if (!isIsoDate(String(body.date || ''))) return { ok: false, error: 'BAD_DATE' };
  const category = CPD_CATEGORIES.includes(body.category) ? body.category : 'other';
  const points = Number(body.points);
  if (!Number.isFinite(points) || points < 0 || points > 9999.9) return { ok: false, error: 'BAD_POINTS' };
  const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim().slice(0, 255) : null;
  return {
    ok: true,
    value: {
      title: title.slice(0, 255),
      date: String(body.date).slice(0, 10),
      category,
      points: Math.round(points * 10) / 10,
      provider,
    },
  };
};

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * The CPD picture for one person and year: verified points (the official
 * figure), pending points (logged, not yet checked), the cadre target, and how
 * far short of it they are. Feeds the progress bar (mockup 5A).
 *
 * @param {{status:string, points:number|string}[]} activities  the year's rows
 * @param {number} target
 */
const summariseCpd = (activities = [], target = 0) => {
  let verified = 0;
  let pending = 0;
  for (const a of activities) {
    const pts = Number(a.points) || 0;
    if (a.status === 'verified') verified += pts;
    else if (a.status === 'pending') pending += pts;
  }
  verified = round1(verified);
  pending = round1(pending);
  const t = Number(target) || 0;
  return {
    verified,
    pending,
    target: t,
    toTarget: t > 0 ? Math.max(0, round1(t - verified)) : 0,
    met: t > 0 ? verified >= t : true,
  };
};

module.exports = {
  CPD_CATEGORIES,
  CPD_CADRES,
  cadreForRole,
  DEFAULT_TARGETS,
  cleanTargets,
  validateCpd,
  summariseCpd,
};
