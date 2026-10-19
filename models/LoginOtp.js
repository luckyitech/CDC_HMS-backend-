const { defineModel, DataTypes } = require('../utils/defineModel');

// A live two-factor sign-in challenge: one emailed code, waiting to be typed.
//
// Created when a correct password is given and two-factor is on; destroyed or
// consumed shortly afterwards. This table is a queue, not a record — the
// durable account of who signed in is UserLoginLogs, whose `method` column says
// 'otp' for a session opened this way.
//
// Only the SHA-256 of `${challengeId}:${code}` is stored, so a copy of this
// table is not a list of live codes. See utils/loginOtp.js on why the id is
// part of the hash rather than the code being hashed alone.
//
// WHY rememberDevice AND context ARE STORED HERE, rather than re-sent at verify:
// the login request is what asked to be remembered, and that intent has to
// survive until the code is accepted. If the verify call carried them instead,
// anyone holding a challenge id could ask for a long-lived device token that
// the person signing in never requested — the second step would be able to
// widen what the first step applied for.
//
// Association-injected: UserId (User.hasMany).
const LoginOtp = defineModel('LoginOtp', {
  // The handle the client holds between the two steps. 32 random bytes, so it
  // identifies one challenge platform-wide and is useless to guess. Unique
  // because the whole flow turns on it naming exactly one row.
  challengeId: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  codeHash: {
    type: DataTypes.STRING(64),   // hex SHA-256 of `${challengeId}:${code}`
    allowNull: false,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  // Wrong codes so far. The cap is the real defence against guessing a 6-digit
  // code, so this is counted on the row rather than per IP: an attacker who
  // rotates addresses still only gets maxAttempts at a given challenge.
  attempts: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  // Set the moment the code is accepted. A challenge is single-use: a code read
  // over someone's shoulder, or left in a mailbox, cannot open a second session.
  consumedAt: {
    type: DataTypes.DATE,
    allowNull: true,
    defaultValue: null,
  },
  // The address the code actually went to, as it was at that moment. Kept
  // because "a code was sent" is not a useful audit trail without "to where",
  // and the account's email may be changed afterwards.
  sentTo: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  lastIp: {
    type: DataTypes.STRING(45),
    allowNull: true,
    defaultValue: null,
  },
  // How many times a fresh code has been posted for this sign-in. Capped in
  // services/loginOtp.js: resend sends mail, so an uncapped one is a way to
  // use the clinic's SMTP relay to flood somebody's inbox.
  resendCount: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 0,
  },
  // Carried from the login request; see the note above on why.
  rememberDevice: {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  },
  context: {
    type: DataTypes.STRING(16),   // 'hr-tap' from the entrance tag page, else null
    allowNull: true,
    defaultValue: null,
  },
});

module.exports = LoginOtp;
