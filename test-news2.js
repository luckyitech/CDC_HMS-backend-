/**
 * HMIS V3 — NEWS2 scoring unit test (no database needed).
 * Run: node test-news2.js
 */
const { score } = require('./utils/news2');

let passed = 0, failed = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
  ok ? passed++ : failed++;
};

// All-normal → 0, None
let r = score({ respRate: 16, spo2: 98, onOxygen: false, systolicBP: 120, heartRate: 70, consciousness: 'A', temperature: 36.5 });
check('all normal → 0 / None', [r.total, r.escalation], [0, 'None']);

// Single mild derangement: RR 22 (2) → 2, Low
r = score({ respRate: 22, spo2: 98, onOxygen: false, systolicBP: 120, heartRate: 70, consciousness: 'A', temperature: 36.5 });
check('RR 22 → 2 / Low', [r.total, r.escalation], [2, 'Low']);

// Single parameter score of 3 (SpO2 91) → Medium even though total is low
r = score({ respRate: 16, spo2: 91, onOxygen: false, systolicBP: 120, heartRate: 70, consciousness: 'A', temperature: 36.5 });
check('SpO2 91 (single 3) → 3 / Medium', [r.total, r.escalation], [3, 'Medium']);

// On oxygen adds 2
r = score({ respRate: 16, spo2: 98, onOxygen: true, systolicBP: 120, heartRate: 70, consciousness: 'A', temperature: 36.5 });
check('on oxygen → 2 / Low', [r.total, r.escalation], [2, 'Low']);

// Severe combo → High (RR8=3, SpO2 91=3, SBP89=3, HR42=1, temp35=3) = 13
r = score({ respRate: 8, spo2: 91, onOxygen: false, systolicBP: 89, heartRate: 42, consciousness: 'A', temperature: 35.0 });
check('severe combo → 13 / High', [r.total, r.escalation], [13, 'High']);

// Confusion (ACVPU != A) scores 3
r = score({ respRate: 16, spo2: 98, onOxygen: false, systolicBP: 120, heartRate: 70, consciousness: 'V', temperature: 36.5 });
check('consciousness V → 3 / Medium', [r.total, r.escalation], [3, 'Medium']);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
