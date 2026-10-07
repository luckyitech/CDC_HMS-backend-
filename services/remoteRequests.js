// Remote requests — the ONE link check used by every order that can answer a
// remote request (prescriptions, lab requests). Rules in utils/remoteRequests.
const { RemoteRequest } = require('../models');
const { clinicToday } = require('../utils/clinicTime');
const R = require('../utils/remoteRequests');

/**
 * Checks req.body.remoteRequestId (if any) for this user and patient family.
 * Returns { id } (null when the order is not a remote one) or { refusal }.
 */
const checkLink = async (remoteRequestId, { userId, patientIds }) => {
  if (remoteRequestId == null || remoteRequestId === '') return { id: null };
  const id = Number(remoteRequestId);
  if (!Number.isInteger(id) || id < 1) return { refusal: { status: 400, code: 'NO_REMOTE_REQUEST', message: 'Bad remote request.' } };
  const rr = await RemoteRequest.findByPk(id);
  const refusal = R.linkRefusal(rr, {
    userId, patientIds, today: clinicToday(), rrDay: rr ? clinicToday(new Date(rr.createdAt)) : null,
  });
  return refusal ? { refusal } : { id };
};

module.exports = { checkLink };
