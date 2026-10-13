// =====================================================================
// Reading a supplier invoice with Claude (13 Oct 2026, Emu).
//
// A photo or PDF of the invoice goes to the Claude API, which returns the
// supplier, document number and every line (description, batch, expiry,
// packs, pack size, quantity) as structured data through a forced tool call —
// no free text to parse. The HMS then matches the lines to the catalogue
// (utils/stockItemMatch) and staff confirm each one before anything is saved.
//
// What leaves the server: the invoice image only. Invoices carry no patient
// data. Nothing is sent unless ANTHROPIC_API_KEY is set; without it the
// "From an invoice" mode shows "Not set up" and manual receiving works as before.
//
// .env:  ANTHROPIC_API_KEY=sk-ant-…      (required for this feature)
//        INVOICE_READER_MODEL=…          (optional; default below)
//
// No new npm package: Node 18+'s built-in fetch.
// =====================================================================

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5-5';
const TIMEOUT_MS = 90000;
const MAX_BYTES = 15 * 1024 * 1024;      // matches the uploader's limit

// What the Claude API accepts as an image. HEIC (iPhone default) is not among
// them — the uploader allows it for attaching scans, so say so clearly.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

class InvoiceReadError extends Error {
  constructor(message, statusCode = 400) { super(message); this.statusCode = statusCode; }
}

const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

// The shape the model must fill in. Every line is returned, stock or not —
// the server decides what is a stock line, and staff can add a dropped one back.
const INVOICE_TOOL = {
  name: 'record_invoice',
  description: 'Record every line item on a supplier invoice, receipt or delivery note for a medical clinic.',
  input_schema: {
    type: 'object',
    properties: {
      supplierName: { type: ['string', 'null'], description: 'The supplier / seller as printed, or null' },
      documentKind: { type: 'string', enum: ['invoice', 'receipt', 'delivery_note'] },
      documentNumber: { type: ['string', 'null'], description: 'Invoice / receipt / delivery note number as printed, or null' },
      documentDate: { type: ['string', 'null'], description: 'YYYY-MM-DD, or null' },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string', description: 'The product wording exactly as printed on the line' },
            isStockItem: { type: 'boolean', description: 'false for charges, discounts, VAT, delivery fees, deposits and other non-product lines' },
            batchNo: { type: ['string', 'null'], description: 'Batch / lot number if printed, else null' },
            expiryDate: { type: ['string', 'null'], description: 'Expiry as YYYY-MM-DD if printed (a month-only expiry is the last day of that month), else null' },
            packs: { type: ['integer', 'null'], description: 'Number of packs / boxes delivered, if the line is in packs' },
            packSize: { type: ['integer', 'null'], description: 'Units per pack if printed or implied (e.g. "50S", "10x10" = 100), else null' },
            quantity: { type: ['integer', 'null'], description: 'Total units delivered (packs × packSize when both are known), else the quantity printed' },
            unit: { type: ['string', 'null'], description: 'The counting unit if clear: tablet, strip, vial, pen, needle, piece…' },
            uncertain: {
              type: 'array', items: { type: 'string', enum: ['description', 'batchNo', 'expiryDate', 'quantity'] },
              description: 'Fields you could not read confidently (blurred, cut off, handwritten)',
            },
          },
          required: ['description', 'isStockItem', 'batchNo', 'expiryDate', 'packs', 'packSize', 'quantity', 'unit', 'uncertain'],
        },
      },
      notes: { type: ['string', 'null'], description: 'Anything staff should know: pages unreadable, totals that do not add up, etc.' },
    },
    required: ['supplierName', 'documentKind', 'documentNumber', 'documentDate', 'lines', 'notes'],
  },
};

const PROMPT = (supplierNames) => [
  'This is a supplier invoice, receipt or delivery note for a diabetes clinic in Nairobi.',
  'Record every line item with the record_invoice tool. Copy product wording exactly as printed.',
  'Quantities: give the total units delivered — packs × pack size when both are printed or implied',
  '(e.g. "10 x 50S" is 10 packs of 50 = 500). Expiry dates printed as MM/YY or MM/YYYY are the last day of that month.',
  'Mark any field you cannot read with confidence in "uncertain" rather than guessing.',
  'Non-product lines (delivery charge, VAT, discount, deposit) are isStockItem: false.',
  supplierNames.length ? `Suppliers the clinic already knows: ${supplierNames.join('; ')}. If the seller is one of them, use that spelling in supplierName.` : null,
].filter(Boolean).join(' ');

const fileBlock = (buffer, mimeType) => {
  if (mimeType === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } };
  }
  if (IMAGE_TYPES.includes(mimeType)) {
    return { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
  }
  throw new InvoiceReadError(
    mimeType === 'image/heic' || mimeType === 'image/heif'
      ? 'HEIC photos cannot be read. On the phone, set the camera to "Most compatible" (JPEG), or save the photo as a JPEG and try again.'
      : 'Only a JPEG, PNG or WebP photo or a PDF can be read',
  );
};

const callApi = async (body, attempt = 1) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (attempt < 2) return callApi(body, attempt + 1);
    throw new InvoiceReadError(err.name === 'AbortError' ? 'Reading the invoice took too long — try a clearer or smaller photo' : 'Could not reach the invoice reader — check the server\'s internet connection', 502);
  }
  clearTimeout(timer);
  if (res.status === 429 || res.status >= 500) {
    if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500)); return callApi(body, attempt + 1); }
    throw new InvoiceReadError('The invoice reader is busy — try again in a minute', 503);
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `Invoice reader error (${res.status})`;
    console.error('invoiceReader API error:', res.status, msg);
    if (res.status === 401) throw new InvoiceReadError('The invoice reader\'s API key is not valid — ask the administrator to check ANTHROPIC_API_KEY', 500);
    throw new InvoiceReadError(/too large|exceed/i.test(msg) ? 'The file is too large to read — try a smaller photo or fewer pages' : 'The invoice could not be read', 502);
  }
  return json;
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const cleanStr = (v, max = 160) => (v == null ? null : String(v).trim().slice(0, max) || null);
const cleanInt = (v) => (Number.isInteger(v) && v >= 0 ? v : (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : null));
const cleanDate = (v) => (typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);

/** Normalise what the model returned — never trust its types blindly. */
const normalise = (input) => {
  const lines = Array.isArray(input?.lines) ? input.lines : [];
  return {
    supplierName: cleanStr(input?.supplierName, 120),
    documentKind: ['invoice', 'receipt', 'delivery_note'].includes(input?.documentKind) ? input.documentKind : 'invoice',
    documentNumber: cleanStr(input?.documentNumber, 80),
    documentDate: cleanDate(input?.documentDate),
    notes: cleanStr(input?.notes, 500),
    lines: lines.map((l) => {
      const packs = cleanInt(l?.packs);
      const packSize = cleanInt(l?.packSize);
      let quantity = cleanInt(l?.quantity);
      if (!quantity && packs && packSize) quantity = packs * packSize;
      if (!quantity && packs && !packSize) quantity = packs;
      const uncertain = Array.isArray(l?.uncertain) ? l.uncertain.filter((f) => ['description', 'batchNo', 'expiryDate', 'quantity'].includes(f)) : [];
      const expiryDate = cleanDate(l?.expiryDate);
      if (l?.expiryDate && !expiryDate && !uncertain.includes('expiryDate')) uncertain.push('expiryDate');
      return {
        description: cleanStr(l?.description) || '(unreadable line)',
        isStockItem: l?.isStockItem !== false,
        batchNo: cleanStr(l?.batchNo, 80),
        expiryDate,
        packs: packs || null,
        packSize: packSize && packSize > 1 ? packSize : null,
        quantity: quantity || null,
        unit: cleanStr(l?.unit, 30),
        uncertain,
      };
    }).filter((l) => l.description),
  };
};

/**
 * Read one invoice. { buffer, mimeType, supplierNames: string[] }
 * → { supplierName, documentKind, documentNumber, documentDate, lines, notes, model }
 * Throws InvoiceReadError (clean status) for anything the user can act on.
 */
const readInvoice = async ({ buffer, mimeType, supplierNames = [] }) => {
  if (!isConfigured()) throw new InvoiceReadError('Reading invoices is not set up on this server (ANTHROPIC_API_KEY)', 503);
  if (!buffer || !buffer.length) throw new InvoiceReadError('Choose a photo or PDF of the invoice');
  if (buffer.length > MAX_BYTES) throw new InvoiceReadError('File is too large. Maximum size is 15MB.');

  const model = process.env.INVOICE_READER_MODEL || DEFAULT_MODEL;
  const json = await callApi({
    model,
    max_tokens: 4096,
    tools: [INVOICE_TOOL],
    tool_choice: { type: 'tool', name: INVOICE_TOOL.name },
    messages: [{ role: 'user', content: [fileBlock(buffer, mimeType), { type: 'text', text: PROMPT(supplierNames) }] }],
  });
  const tool = (json.content || []).find((c) => c.type === 'tool_use' && c.name === INVOICE_TOOL.name);
  if (!tool) throw new InvoiceReadError('The invoice could not be read — try a clearer photo', 502);
  return { ...normalise(tool.input), model };
};

module.exports = { readInvoice, isConfigured, normalise, InvoiceReadError, INVOICE_TOOL, DEFAULT_MODEL };
