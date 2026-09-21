const fs = require('fs');

// ---------------------------------------------------------------------------
// Removing the password from a lab-report PDF so it can be filed into the
// patient record unlocked (Communications Inbox: labs often WhatsApp a report
// locked with the patient's ID or date of birth).
//
// qpdf compiled to WebAssembly (@jspawn/qpdf-wasm) — the ONLY new dependency of
// this feature (A4 exception, stated, pinned 0.0.2). Pure WASM, no native
// build, Apache-2.0. It exposes the qpdf CLI, so we drive it through callMain
// against an in-memory MEMFS.
//
// Behaviour of this build, established empirically (see tests/pdfUnlock.test.js
// and the fixtures): decrypting with the CORRECT password exits 0 and writes a
// valid %PDF; with a wrong/absent password no output is written. qpdf prints
// its own CLI errors straight to the process stderr (bypassing Module.printErr
// in this build), so we decide purely on whether a valid PDF came out — never
// on qpdf's log text — and silence that stderr around the call to keep it out
// of the server log. A wrong password is inferred: the PDF references an
// encryption dictionary yet did not open.
//
// One module instance is created and reused (qpdf builds a fresh QPDF per CLI
// run, so state does not carry between calls); the MEMFS is cleaned each call.
// A single instance also avoids leaking a process listener per invocation.
// ---------------------------------------------------------------------------

let wasmBinary = null;      // read once, reused for every instantiation
let createModule = null;
let modPromise = null;

const getModule = () => {
  if (!modPromise) {
    // Lazy: a deployment that never touches an encrypted PDF never loads the
    // module, and a missing package fails at use, loudly, not at boot.
    createModule = require('@jspawn/qpdf-wasm');
    wasmBinary = fs.readFileSync(require.resolve('@jspawn/qpdf-wasm/qpdf.wasm'));
    modPromise = createModule({
      noInitialRun: true,
      // The default loader fetch()es the .wasm relative to the script, which
      // breaks once the file is bundled/relocated — so we hand qpdf the bytes.
      instantiateWasm(imports, success) {
        WebAssembly.instantiate(wasmBinary, imports).then((r) => success(r.instance));
        return {};
      },
      print: () => {},
      printErr: () => {},
    });
  }
  return modPromise;
};

/** Cheap, no-wasm pre-check: is there any encryption dictionary at all? */
const referencesEncrypt = (buffer) => {
  try { return Buffer.from(buffer).includes(Buffer.from('/Encrypt')); } catch { return false; }
};

// Run one qpdf CLI invocation against a fresh MEMFS input. `args` uses the
// tokens '__IN__' / '__OUT__' for the input and output paths. Returns
// { code, outFile }. qpdf's own stderr is silenced for the duration.
const runQpdf = async (inputBuffer, args, outName) => {
  const mod = await getModule();
  const { FS } = mod;
  const clean = () => ['in.pdf', outName].filter(Boolean).forEach((f) => {
    try { FS.unlink(`/${f}`); } catch { /* not there */ }
  });
  clean();
  FS.writeFile('/in.pdf', new Uint8Array(inputBuffer));
  const argv = args.map((a) => (a === '__IN__' ? '/in.pdf' : a === '__OUT__' ? `/${outName}` : a));

  const origErr = process.stderr.write;
  // qpdf's Emscripten runtime sets process.exitCode as a side effect of a
  // non-zero CLI exit (e.g. a wrong password → 2) even though we catch the
  // thrown ExitStatus. Left set, it makes the whole Node process exit non-zero
  // — a spurious crash-exit for PM2, a failing test file. Restore it after.
  const priorExit = process.exitCode;
  process.stderr.write = () => true;      // qpdf writes CLI errors straight here
  let code = 0;
  try {
    const r = mod.callMain(argv);
    code = typeof r === 'number' ? r : 0;
  } catch (e) {
    code = e && typeof e.status === 'number' ? e.status : -1;
  } finally {
    process.stderr.write = origErr;
    process.exitCode = priorExit;
  }

  let outFile = null;
  if (outName) {
    try {
      if (FS.readdir('/').includes(outName)) outFile = Buffer.from(FS.readFile(`/${outName}`));
    } catch { /* no output produced */ }
  }
  clean();
  return { code, outFile };
};

const isPdf = (buf) => !!buf && buf.slice(0, 5).toString('latin1') === '%PDF-';

/**
 * Decrypt with the given password (default empty). Returns the unlocked PDF
 * buffer. Throws Error('invalid password') [code INVALID_PASSWORD] when the PDF
 * is encrypted but did not open, or a generic Error for a PDF qpdf cannot
 * process.
 */
const decrypt = async (buffer, password = '') => {
  const args = [];
  if (password) args.push(`--password=${password}`);
  args.push('--decrypt', '__IN__', '__OUT__');
  const { code, outFile } = await runQpdf(buffer, args, 'out.pdf');
  if (isPdf(outFile)) return outFile;
  if (referencesEncrypt(buffer)) {
    const e = new Error('invalid password');
    e.code = 'INVALID_PASSWORD';
    throw e;
  }
  throw new Error(`could not process PDF (qpdf exit ${code})`);
};

/**
 * Does this PDF need a password to open (a user password)? A PDF with only an
 * owner password opens and its text extracts fine, so it is NOT flagged — the
 * UI only prompts when the content is actually locked. False for non-PDFs.
 */
const isEncrypted = async (buffer) => {
  if (!buffer || !referencesEncrypt(buffer)) return false;   // fast path
  try {
    await decrypt(buffer, '');   // opened with no user password → not locked
    return false;
  } catch (e) {
    return e.code === 'INVALID_PASSWORD';
  }
};

// Candidate passwords derived from the patient — the shapes labs commonly use.
const passwordCandidates = (patient) => {
  const out = [''];                                  // owner-only / empty user password
  if (!patient) return out;
  if (patient.idNumber) out.push(String(patient.idNumber).trim());
  const dob = patient.dateOfBirth ? new Date(patient.dateOfBirth) : null;
  if (dob && !Number.isNaN(dob.getTime())) {
    const yyyy = String(dob.getFullYear());
    const yy = yyyy.slice(-2);
    const mm = String(dob.getMonth() + 1).padStart(2, '0');
    const dd = String(dob.getDate()).padStart(2, '0');
    out.push(`${dd}${mm}${yyyy}`, `${yyyy}${mm}${dd}`, `${dd}${mm}${yy}`);
  }
  return [...new Set(out)];
};

/**
 * Try the patient's own identifiers as the password. Returns
 * { buffer, password } for the first that works, or null. Never throws.
 */
const tryPatientPasswords = async (buffer, patient) => {
  for (const password of passwordCandidates(patient)) {
    try {
      const unlocked = await decrypt(buffer, password);
      return { buffer: unlocked, password };
    } catch { /* try the next candidate */ }
  }
  return null;
};

module.exports = { isEncrypted, decrypt, tryPatientPasswords, passwordCandidates, referencesEncrypt };
