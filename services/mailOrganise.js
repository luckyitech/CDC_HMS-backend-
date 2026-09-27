const session = require('./mailSession');
const accounts = require('./mailAccounts');
const { shapeFolders } = require('../utils/mailRender');

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
};
