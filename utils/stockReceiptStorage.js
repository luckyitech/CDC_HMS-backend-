// Where scanned supplier invoices / receipts live on disk (12 Oct 2026).
//
// private/stock-receipts/ — git-ignored and NEVER served statically. Read only
// through GET /api/stock/receipts/:id/documents/:docId (stock.access). Only the
// stored NAME is trusted and joined onto this folder, so a tampered filePath
// cannot point anywhere else (same rule as utils/staffDocumentStorage.js).

const fs = require('fs');
const path = require('path');

const STOCK_RECEIPT_DIR = path.join(__dirname, '..', 'private', 'stock-receipts');

const ensureStockReceiptDir = () => {
  if (!fs.existsSync(STOCK_RECEIPT_DIR)) fs.mkdirSync(STOCK_RECEIPT_DIR, { recursive: true });
  return STOCK_RECEIPT_DIR;
};

const resolveStockReceiptFile = (filePath) => {
  const name = String(filePath || '').split(/[\\/]/).pop();
  if (!name || name === '.' || name === '..') return null;
  const candidate = path.join(STOCK_RECEIPT_DIR, name);
  if (path.dirname(candidate) !== STOCK_RECEIPT_DIR) return null;
  return fs.existsSync(candidate) ? candidate : null;
};

module.exports = { STOCK_RECEIPT_DIR, ensureStockReceiptDir, resolveStockReceiptFile };
