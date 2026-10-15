// Receiving from an invoice (13 Oct 2026) — the pure parts: matching invoice
// wording to the catalogue, normalising what the reader returns, and the
// audit wording. No database.
//   node --test tests/invoiceReceive.unit.test.js
const test = require('node:test');
const assert = require('node:assert/strict');

const { tokens, aliasKeyOf, similarity, matchLine } = require('../utils/stockItemMatch');
const { normalise, parseResult } = require('../utils/invoiceReader');
const { receiveMethodText } = require('../utils/stockAudit');
const { buildSessions, buildPeople } = require('../utils/stockAuditReport');

const ITEMS = [
  { id: 1, name: 'Blood glucose test strip', status: 'active' },
  { id: 2, name: 'Metformin 500 mg tab', status: 'active' },
  { id: 3, name: 'Metformin 850 mg tab', status: 'active' },
  { id: 4, name: 'Metformin 500 mg XR tab', status: 'active' },
  { id: 5, name: 'Insulin glargine pen', status: 'active' },
  { id: 6, name: 'Empagliflozin 10 mg tab', status: 'active' },
  { id: 7, name: 'Ketone test strip', status: 'active' },
  { id: 8, name: 'Old item', status: 'retired' },
];

test('tokens: strengths split, shorthand expanded, pack counts dropped', () => {
  assert.deepEqual(tokens('METFORMIN 500MG TABS 10X10'), ['METFORMIN', '500', 'MG', 'TAB']);
  assert.deepEqual(tokens("Glucofix Strp 50'S"), ['GLUCOFIX', 'STRIP']);
  assert.equal(aliasKeyOf('  Ins  Glargine 100IU/ml Pen 5S '), 'INSULIN GLARGINE 100 IU ML PEN');
});

test('similarity: the right strength wins', () => {
  assert.ok(similarity('METFORMIN 500MG TABS', 'Metformin 500 mg tab') > similarity('METFORMIN 500MG TABS', 'Metformin 850 mg tab'));
  assert.ok(similarity('EMPAGLIFOZIN 10MG 30S', 'Empagliflozin 10 mg tab') > 0.42, 'spelling variant still close');
  assert.equal(similarity('', 'x'), 0);
});

test('matchLine: suggested with the two next-closest, remembered beats suggestion, unmatched below the bar', () => {
  const m = matchLine('METFORMIN 500MG TABS 10X10', ITEMS);
  assert.equal(m.status, 'suggested');
  assert.equal(m.stockItemId, 2);
  assert.equal(m.candidates.length, 3);
  assert.equal(m.candidates[0].stockItemId, 2);

  const remembered = matchLine('GLUCOFIX STRP 50S', ITEMS, new Map([[aliasKeyOf('GLUCOFIX STRP 50S'), 1]]));
  assert.equal(remembered.status, 'remembered');
  assert.equal(remembered.stockItemId, 1);
  assert.ok(remembered.candidates.every((c) => c.stockItemId !== 1));

  const none = matchLine('BD MICROFINE+ 4MM 100S', ITEMS);
  assert.equal(none.status, 'unmatched');
  assert.equal(none.stockItemId, null);

  // A remembered alias pointing at a retired item is ignored.
  const stale = matchLine('OLD ITEM', ITEMS, new Map([[aliasKeyOf('OLD ITEM'), 8]]));
  assert.notEqual(stale.stockItemId, 8);
});

test('normalise: types cleaned, quantity from packs × size, bad expiry flagged uncertain', () => {
  const out = normalise({
    supplierName: ' Surgipharm Limited ', supplierPhone: '+254 700 000000', supplierEmail: 'sales@surgipharm.co.ke', supplierAddress: null, supplierTaxPin: 'P051234567X', supplierNotes: 7, documentKind: 'bogus', documentNumber: 'INV-20431', documentDate: '2026-10-13',
    lines: [
      { description: 'GLUCOFIX STRP 50S', isStockItem: true, batchNo: 'GF24117', expiryDate: '2027-08-31', packs: 10, packSize: 50, quantity: null, unit: 'strip', uncertain: [] },
      { description: 'EMPAGLIFLOZIN 10MG 30S', isStockItem: true, batchNo: null, expiryDate: '08/2027', packs: '6', packSize: 30, quantity: 180, unit: null, uncertain: ['batchNo'] },
      { description: 'DELIVERY CHARGE', isStockItem: false, batchNo: null, expiryDate: null, packs: null, packSize: null, quantity: null, unit: null, uncertain: [] },
      { description: '', isStockItem: true },
    ],
    notes: null,
  });
  assert.equal(out.supplierName, 'Surgipharm Limited');
  assert.equal(out.supplierPhone, '+254 700 000000');
  assert.equal(out.supplierTaxPin, 'P051234567X');
  assert.equal(out.supplierAddress, null);
  assert.equal(out.supplierNotes, '7');
  assert.equal(out.documentKind, 'invoice');
  assert.equal(out.lines.length, 4);
  assert.equal(out.lines[0].quantity, 500);
  assert.equal(out.lines[1].packs, 6);
  assert.equal(out.lines[1].expiryDate, null);
  assert.deepEqual(out.lines[1].uncertain, ['batchNo', 'expiryDate']);
  assert.equal(out.lines[2].isStockItem, false);
  assert.equal(out.lines[3].description, '(unreadable line)');
});

test('parseResult: the tool call, else JSON in the text, else null', () => {
  assert.deepEqual(parseResult({ content: [{ type: 'tool_use', name: 'record_invoice', input: { lines: [] } }] }), { lines: [] });
  assert.deepEqual(parseResult({ content: [{ type: 'text', text: 'Here it is:\n{"documentNumber":"INV-1","lines":[]}\nDone.' }] }), { documentNumber: 'INV-1', lines: [] });
  assert.equal(parseResult({ content: [{ type: 'text', text: 'I cannot read this.' }] }), null);
  assert.equal(parseResult({}), null);
});

test('receiveMethodText and the audit sessions carry the method', () => {
  assert.equal(receiveMethodText({ receiveMethod: 'manual' }), 'entered manually');
  assert.equal(receiveMethodText({ receiveMethod: 'invoice', sourceCorrections: null }), 'from invoice');
  assert.equal(receiveMethodText({ receiveMethod: 'invoice', sourceCorrections: 'item,quantity' }), 'from invoice · item, quantity corrected');

  const at = '2026-10-13T08:00:00.000Z';
  const base = { type: 'stock_received', label: 'Received Stock', fn: 'receiving', at, userId: 7, staff: 'Grace', role: 'staff', location: 'Main store', item: 'X', quantity: 5, receiptId: 1, receipt: 'INV-1' };
  const sessions = buildSessions([{ ...base, method: 'invoice' }, { ...base, method: 'invoice', item: 'Y' }]);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].method, 'invoice');
  const mixed = buildSessions([{ ...base, method: 'invoice' }, { ...base, method: 'manual' }]);
  assert.equal(mixed[0].method, 'mixed');
  const people = buildPeople([{ ...base, method: 'invoice' }], sessions);
  assert.equal(people[0].receiving, 1);
  assert.equal(people[0].receivingFromInvoice, 1);
});
