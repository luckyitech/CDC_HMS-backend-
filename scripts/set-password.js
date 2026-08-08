/**
 * Set an account's password from the server.
 *
 *   npm run set-password -- admin@cdc.com
 *   npm run set-password -- admin@cdc.com --password "Chosen%Words%Here%42"
 *   npm run set-password -- admin@cdc.com --words 5
 *
 * This exists because the admin has no real mailbox, so the forgot-password
 * flow has nothing to send to. Rather than inventing a fake address, whoever
 * has server access sets the password here and hands it over; the admin then
 * changes it to something only they know from Settings → Change Password
 * (PUT /api/auth/change-password), which needs no email at all.
 *
 * Once the admin has a real address, the normal reset flow takes over and this
 * becomes the break-glass tool it should be.
 *
 * The password is printed ONCE and written nowhere — not to a file, not to the
 * repo, not to the seed script. Copy it, hand it over, close the terminal.
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../models');
const { generatePassphrase, entropyBits, meetsPolicy } = require('../utils/passphrase');

const { User } = db;

const parseArgs = (argv) => {
  const out = { email: null, password: null, words: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--password') { out.password = argv[++i]; continue; }
    if (a === '--words') { out.words = parseInt(argv[++i], 10) || 4; continue; }
    if (!a.startsWith('--') && !out.email) out.email = a;
  }
  return out;
};

(async () => {
  const { email, password: supplied, words } = parseArgs(process.argv.slice(2));

  if (!email) {
    console.error('Usage: npm run set-password -- <email> [--password "..."] [--words 5]');
    process.exit(1);
  }

  try {
    await db.sequelize.authenticate();

    const user = await User.findOne({ where: { email } });
    if (!user) {
      // Deliberately does NOT create the account. Creating users is the seed
      // script's job; a typo here should fail loudly, not quietly mint a new
      // login on a production database.
      console.error(`No account with email "${email}". Nothing changed.`);
      console.error('Run the seed script if the account does not exist yet.');
      process.exit(1);
    }

    const password = supplied || generatePassphrase(words);

    if (!meetsPolicy(password)) {
      console.error('That password does not meet the policy the app enforces on its own');
      console.error('routes: at least 8 characters with an uppercase letter, a lowercase');
      console.error('letter, a number and a symbol. Nothing changed.');
      process.exit(1);
    }

    const hash = await bcrypt.hash(password, 10);   // 10 rounds, as every other path uses
    // Clearing passwordChangedAt marks this as a password the user did not
    // choose — whoever ran this script knows it. With weekly rotation on, a
    // doctor/staff/lab account is then forced to set their own at next login,
    // which turns the "have them change it" note below into something enforced.
    // Admins are exempt from rotation, so the break-glass case is unaffected.
    await user.update({ password: hash, passwordChangedAt: null });

    // Read it back and prove the stored hash accepts the password, rather than
    // trusting that the UPDATE did what we think. This is the same comparison
    // the login endpoint performs.
    const check = await User.findByPk(user.id);
    const verified = await bcrypt.compare(password, check.password);
    if (!verified) {
      console.error('The password was written but does not verify. Do NOT hand it out.');
      process.exit(1);
    }

    console.log('');
    console.log(`  Account   ${user.email}  (${user.role}, ${user.firstName} ${user.lastName})`);
    console.log(`  Password  ${password}`);
    if (!supplied) console.log(`  Strength  ~${entropyBits(words)} bits, bcrypt cost 10`);
    console.log('');
    console.log('  Shown once and stored nowhere else. Hand it over, then have them');
    console.log('  change it from Settings → Change Password.');
    console.log('');

    process.exit(0);
  } catch (err) {
    console.error('Failed to set the password:', err.message);
    process.exit(1);
  }
})();
