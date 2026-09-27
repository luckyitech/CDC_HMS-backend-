const session = require('./mailSession');
const accounts = require('./mailAccounts');
const { shapeFolders, SPECIAL_BY_NAME } = require('../utils/mailRender');

const { MailError, withFolder, getClient, specialFolder, ensureSpecialFolder, cleanUidList } = session;

// ---------------------------------------------------------------------------
// Staff Email (B26) phase 3b — organising the caller's OWN mailbox: move,
// archive, delete (= move to Trash), restore from Trash, flag, and Empty
// Trash. Like every mail service, each function takes the caller's userId and
// nothing that could select another person's mailbox (D1).
//
// Nothing here is permanent except emptyTrash — one.com keeps no backups, so
// "Delete" always means "move to Trash" (created if the mailbox has none),
// and the only way out of Trash for good is emptyTrash, which the server
// refuses unless the literal word EMPTY is sent AND the count the person was
// shown still matches what is in Trash now.
//
// Audit (Emu, 26 Sep): moves / archives / flags are NOT recorded; emptying
// Trash is, as a count only.
// ---------------------------------------------------------------------------

const EMPTY_WORD = 'EMPTY';

const sameFolder = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

/** The caller's selectable folders, as the rail shows them. */
const folderPaths = async (userId) => {
  const client = await getClient(userId);
  return shapeFolders(await client.list()).map((f) => f.path);
};

/** Move these messages from `folder` to `to` (which must be one of the caller's folders). */
const moveMessages = async (userId, { folder = 'INBOX', uids, to }) => {
  const list = cleanUidList(uids);
  const target = String(to || '');
  const paths = await folderPaths(userId);
  const dest = paths.find((p) => sameFolder(p, target));
  if (!dest) throw new MailError('BAD_FOLDER', 'Pick one of your folders to move to.', 400);
  if (sameFolder(dest, folder)) throw new MailError('SAME_FOLDER', 'Those messages are already in that folder.', 400);
  const result = await withFolder(userId, folder, async (client) => {
    await client.messageMove(list.join(','), dest, { uid: true });
    return { folder: client.mailbox.path, to: dest, moved: list.length, uids: list };
  });
  nudgeWatcher(userId);
  return result;
};

/** Archive — to the mailbox's Archive folder, created on first use. */
const archiveMessages = async (userId, { folder = 'INBOX', uids }) => {
  const archive = await ensureSpecialFolder(userId, 'archive');
  if (sameFolder(archive, folder)) throw new MailError('SAME_FOLDER', 'Those messages are already archived.', 400);
  return moveMessages(userId, { folder, uids, to: archive });
};

/** Delete = move to Trash (created on first use). Never permanent. */
const trashMessages = async (userId, { folder = 'INBOX', uids }) => {
  const trash = await ensureSpecialFolder(userId, 'trash');
  if (sameFolder(trash, folder)) {
    throw new MailError('IN_TRASH', 'These are already in Trash. Restore them, or use Empty Trash.', 400);
  }
  return moveMessages(userId, { folder, uids, to: trash });
};

/** Restore from Trash back to the Inbox. Only from Trash. */
const restoreMessages = async (userId, { folder, uids }) => {
  const trash = await specialFolder(userId, 'trash');
  if (!trash || !sameFolder(trash, folder)) throw new MailError('NOT_TRASH', 'Only messages in Trash can be restored.', 400);
  return moveMessages(userId, { folder, uids, to: 'INBOX' });
};

/** Flag / unflag. */
const setFlagged = async (userId, { folder = 'INBOX', uids, flagged = true }) => {
  const list = cleanUidList(uids);
  return withFolder(userId, folder, async (client) => {
    if (flagged) await client.messageFlagsAdd(list.join(','), ['\\Flagged'], { uid: true });
    else await client.messageFlagsRemove(list.join(','), ['\\Flagged'], { uid: true });
    return { folder: client.mailbox.path, uids: list, flagged: !!flagged };
  });
};

/** How many messages are in Trash now — the number the Empty Trash dialog shows. */
const trashCount = async (userId) => {
  const trash = await specialFolder(userId, 'trash');
  if (!trash) return { folder: null, count: 0 };
  const client = await getClient(userId);
  const s = await client.status(trash, { messages: true });
  return { folder: trash, count: s.messages || 0 };
};

/**
 * Permanently delete everything in the caller's Trash. Refused unless
 * `confirm` is exactly EMPTY and `count` equals what is in Trash right now
 * (so something that landed in Trash after the dialog opened is never
 * destroyed without being counted). Audited as a count.
 */
const emptyTrash = async (userId, { confirm, count }) => {
  if (confirm !== EMPTY_WORD) throw new MailError('CONFIRM', `Type ${EMPTY_WORD} to confirm.`, 400);
  const expected = parseInt(count, 10);
  if (!(expected >= 0)) throw new MailError('CONFIRM', 'Open Empty Trash again to see how many messages it holds.', 400);
  const trash = await specialFolder(userId, 'trash');
  if (!trash) return { emptied: 0 };

  const emptied = await withFolder(userId, trash, async (client) => {
    // Count on the SERVER now (a cached "exists" can be stale on a pooled
    // connection), then delete exactly those UIDs — a message that lands in
    // Trash between this count and the delete is left alone, never destroyed.
    // NOOP first: the server only adds messages that arrived from elsewhere
    // (phone, webmail) to this session's view when the session syncs.
    await client.noop();
    const uids = (await client.search({ all: true }, { uid: true })) || [];
    if (uids.length !== expected) {
      throw Object.assign(
        new MailError('TRASH_CHANGED', `Trash now holds ${uids.length} message${uids.length === 1 ? '' : 's'}, not ${expected}. Check it and confirm again.`, 409),
        { extra: { count: uids.length } },
      );
    }
    if (!uids.length) return 0;
    await client.messageDelete(uids.join(','), { uid: true });
    return uids.length;
  });

  if (emptied) {
    const row = await accounts.findForUser(userId);
    await accounts.logEvent({
      userId, actorId: userId, event: 'trash_emptied',
      emailAddress: row ? row.emailAddress : null,
      detail: `${emptied} message${emptied === 1 ? '' : 's'}`,
    });
  }
  return { emptied };
};

// ---------------------------------------------------------------------------
// Folders (debt pass, 27 Sep — Emu: create + rename; delete only if empty).
// Only the caller's OWN folders — never Inbox or a special-use folder (Sent,
// Drafts, Trash, Junk, Archive). New folders go at the top level of the
// mailbox (under the server's personal namespace prefix, if it has one). None
// of this is audited, the same as move/archive.
// ---------------------------------------------------------------------------

const RESERVED = new Set(['inbox', ...Object.keys(SPECIAL_BY_NAME)]);

/** A clean, allowed folder name, or a NAME error. */
const cleanFolderName = (name, delimiter) => {
  const n = String(name || '').replace(/\s+/g, ' ').trim();
  if (!n) throw new MailError('BAD_NAME', 'Give the folder a name.', 400);
  if (n.length > 60) throw new MailError('BAD_NAME', 'Keep folder names to 60 characters.', 400);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(n) || /[/\\*%]/.test(n) || (delimiter && n.includes(delimiter))) {
    throw new MailError('BAD_NAME', `A folder name can't contain / \\ * % ${delimiter && delimiter !== '/' ? delimiter : ''}`.trim(), 400);
  }
  if (RESERVED.has(n.toLowerCase())) throw new MailError('BAD_NAME', `"${n}" is kept for the mailbox's own folders. Pick another name.`, 400);
  return n;
};

/** The caller's folder list + which of them are their own (renamable/deletable). */
const folderState = async (userId) => {
  const client = await getClient(userId);
  const rows = await client.list();
  const shaped = shapeFolders(rows);
  const own = new Map(shaped.filter((f) => !f.special).map((f) => [f.path.toLowerCase(), f]));
  const delimiter = (rows.find((r) => r.delimiter) || {}).delimiter || '/';
  const prefix = (client.namespace && client.namespace.prefix) || '';
  // every path, selectable or not, so a name clash with a hidden folder is caught too
  const all = new Set(rows.map((r) => String(r.path).toLowerCase()));
  return { client, own, delimiter, prefix, all };
};

const ownFolder = (state, path) => {
  const f = state.own.get(String(path || '').toLowerCase());
  if (!f) throw new MailError('NOT_OWN_FOLDER', 'Only folders you made can be renamed or deleted.', 400);
  return f;
};

const createFolder = async (userId, { name }) => {
  const st = await folderState(userId);
  const clean = cleanFolderName(name, st.delimiter);
  const path = `${st.prefix}${clean}`;
  if (st.all.has(path.toLowerCase())) throw new MailError('FOLDER_EXISTS', `You already have a folder called "${clean}".`, 409);
  const made = await imapFolderOp(() => st.client.mailboxCreate(path), 'create');
  return { path: (made && made.path) || path, name: clean };
};

const renameFolder = async (userId, { path, name }) => {
  const st = await folderState(userId);
  const f = ownFolder(st, path);
  const clean = cleanFolderName(name, st.delimiter);
  const cut = f.path.lastIndexOf(f.delimiter || st.delimiter);
  const parent = cut >= 0 ? f.path.slice(0, cut + 1) : '';
  const to = `${parent}${clean}`;
  if (to.toLowerCase() === f.path.toLowerCase()) {
    if (to === f.path) return { path: f.path, name: clean };
  } else if (st.all.has(to.toLowerCase())) {
    throw new MailError('FOLDER_EXISTS', `You already have a folder called "${clean}".`, 409);
  }
  await releaseIfSelected(st.client, f.path);
  const r = await imapFolderOp(() => st.client.mailboxRename(f.path, to), 'rename');
  return { from: f.path, path: (r && r.newPath) || to, name: clean };
};

/**
 * Delete one of the caller's own folders — only when it is EMPTY and has no
 * sub-folders. On IMAP, deleting a folder destroys whatever is in it and
 * one.com keeps no backup, so emptiness is checked on the server (NOOP, then
 * SEARCH ALL) immediately before the DELETE, not taken from the dialog.
 */
const deleteFolder = async (userId, { path }) => {
  const st = await folderState(userId);
  const f = ownFolder(st, path);
  const delim = f.delimiter || st.delimiter;
  const childPrefix = `${f.path}${delim}`.toLowerCase();
  if ([...st.all].some((p) => p.startsWith(childPrefix))) {
    throw new MailError('FOLDER_NOT_EMPTY', 'This folder has folders inside it. Move or delete those first.', 409);
  }
  const count = await withFolder(userId, f.path, async (client) => {
    await client.noop();
    return ((await client.search({ all: true }, { uid: true })) || []).length;
  });
  if (count > 0) {
    throw Object.assign(
      new MailError('FOLDER_NOT_EMPTY', `"${f.name}" still has ${count} message${count === 1 ? '' : 's'}. Move ${count === 1 ? 'it' : 'them'} out first.`, 409),
      { extra: { count } },
    );
  }
  await releaseIfSelected(st.client, f.path);
  await imapFolderOp(() => st.client.mailboxDelete(f.path), 'delete');
  return { deleted: f.path };
};

/** The mail server said no (a NO/BAD reply) → a readable error, never a 500. */
async function imapFolderOp(fn, what) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof MailError) throw err;
    if (err && (err.serverResponseCode || err.responseStatus === 'NO' || err.responseStatus === 'BAD')) {
      console.error(`[Mail] folder ${what} refused:`, err.serverResponseCode || err.responseStatus);
      throw new MailError('FOLDER_REFUSED', `Your mail server wouldn't ${what} that folder. Try another name, or do it in webmail.`, 502);
    }
    throw err;
  }
}

/** A pooled connection with this folder selected must let go of it first. */
async function releaseIfSelected(client, path) {
  if (client.mailbox && String(client.mailbox.path).toLowerCase() === String(path).toLowerCase()) {
    const lock = await client.getMailboxLock('INBOX');
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// Select all across pages (debt pass). The client sends what it was showing —
// the folder, the search text, and `uidMax` (the highest UID when the list
// was loaded) with `uidValidity`. The server re-finds those messages itself
// (UIDs 1..uidMax, matching the search), so mail that arrived afterwards is
// never swept into the action — it is counted and reported instead. Applied
// in batches of 500 through the same functions a page selection uses.
// ---------------------------------------------------------------------------

const BATCH = 500;
const ALL_MAX = 20000;

const resolveAll = async (userId, folder, all) => {
  const uidMax = parseInt(all && all.uidMax, 10);
  if (!(uidMax > 0)) throw new MailError('BAD_UID', 'Reload the list and select again.', 400);
  const q = String((all && all.q) || '').trim().slice(0, 200);
  return withFolder(userId, folder, async (client) => {
    await client.noop();
    if (all.uidValidity && String(client.mailbox.uidValidity) !== String(all.uidValidity)) {
      throw new MailError('FOLDER_CHANGED', 'This folder changed on the mail server. Reload and select again.', 409);
    }
    const base = q ? { text: q } : {};
    const uids = ((await client.search({ ...base, uid: `1:${uidMax}` }, { uid: true })) || []).filter((u) => u <= uidMax);
    const newer = ((await client.search({ ...base, uid: `${uidMax + 1}:*` }, { uid: true })) || []).filter((u) => u > uidMax);
    if (uids.length > ALL_MAX) throw new MailError('TOO_MANY', `That's ${uids.length} messages — select fewer than ${ALL_MAX} at a time.`, 400);
    return { uids: uids.sort((a, b) => a - b), newer: newer.length };
  });
};

/** run(userId, { ...opts, uids }) for each batch; totals the result. */
const inBatches = async (userId, folder, all, run) => {
  const { uids, newer } = await resolveAll(userId, folder, all);
  if (!uids.length) throw new MailError('BAD_UID', 'None of those messages are in this folder any more.', 400);
  let last = {};
  for (let i = 0; i < uids.length; i += BATCH) {
    last = await run(uids.slice(i, i + BATCH));
  }
  return { ...last, uids: undefined, count: uids.length, newerLeft: newer };
};

/** The organise actions with `all` in place of `uids`. */
const organiseAll = (action, userId, body) => {
  const folder = body.folder || 'INBOX';
  const fns = { move: moveMessages, archive: archiveMessages, trash: trashMessages, restore: restoreMessages, flag: setFlagged };
  const fn = fns[action];
  if (!fn) throw new MailError('BAD_ACTION', 'Unknown action.', 400);
  return inBatches(userId, folder, body.all, (uids) => fn(userId, { ...body, folder, uids }));
};

/** The watcher will hear about INBOX changes over IDLE anyway; this just makes the badge prompt. */
function nudgeWatcher(userId) {
  try { require('./mailWatch').nudge(userId); } catch { /* not loaded */ }
}

module.exports = {
  EMPTY_WORD,
  moveMessages,
  archiveMessages,
  trashMessages,
  restoreMessages,
  setFlagged,
  trashCount,
  emptyTrash,
  createFolder,
  renameFolder,
  deleteFolder,
  cleanFolderName,
  resolveAll,
  inBatches,
  organiseAll,
};
