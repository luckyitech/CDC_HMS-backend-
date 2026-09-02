const db = require('../models');
const { success, error } = require('../utils/response');

const { BridgeStatus, User } = db;

// How fresh a heartbeat must be for the bridge to count as "online" (seconds).
const ONLINE_WINDOW_SECONDS = 90;
const DEFAULT_BRIDGE_ID = 'default';

// A restart is pending (the bridge should act) when the request is newer than
// the last ack the bridge has sent.
const isRestartPending = (row) =>
  !!row.restartRequestedAt &&
  (!row.restartAckedAt || new Date(row.restartAckedAt) < new Date(row.restartRequestedAt));

const toBool = (v) => {
  if (v === undefined || v === null || v === '') return null;
  return v === true || v === 'true' || v === 1 || v === '1';
};
const toInt = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

const bridgeController = {
  // POST /api/ultrasound/bridge/heartbeat  (machine auth via ingestAuth, no JWT)
  // The bridge checks in with its status and receives any pending command back
  // in the same response — one round-trip does status + command.
  async heartbeat(req, res) {
    try {
      const b = req.body || {};
      const bridgeId = String(b.bridgeId || DEFAULT_BRIDGE_ID);
      const now = new Date();

      const [row] = await BridgeStatus.findOrCreate({
        where: { bridgeId },
        defaults: { bridgeId },
      });

      const pending = isRestartPending(row);

      const fields = {
        lastHeartbeatAt: now,
        aeTitle: b.aeTitle != null ? String(b.aeTitle) : row.aeTitle,
        host: b.host != null ? String(b.host) : row.host,
        localIp: b.localIp != null ? String(b.localIp) : row.localIp,
        version: b.version != null ? String(b.version) : row.version,
        listenerOk: toBool(b.listenerOk),
        queueDepth: toInt(b.queueDepth),
      };
      if (b.lastImageReceivedAt) fields.lastImageReceivedAt = new Date(b.lastImageReceivedAt);
      // If a restart was pending, THIS heartbeat is the bridge acting on it — ack now.
      if (pending) fields.restartAckedAt = now;

      await row.update(fields);

      return success(res, { restart: pending });
    } catch (err) {
      console.error('BridgeStatus.heartbeat error:', err);
      return error(res, 'Failed to record bridge heartbeat', 500);
    }
  },

  // GET /api/ultrasound/bridge/status  (JWT — radiology users)
  async status(req, res) {
    try {
      const bridgeId = String(req.query.bridgeId || DEFAULT_BRIDGE_ID);
      const row = await BridgeStatus.findOne({
        where: { bridgeId },
        include: [{ model: User, as: 'restartRequestedBy', attributes: ['id', 'firstName', 'lastName'] }],
      });

      if (!row) return success(res, { configured: false });

      const now = Date.now();
      const hb = row.lastHeartbeatAt ? new Date(row.lastHeartbeatAt).getTime() : null;
      const secondsSinceHeartbeat = hb ? Math.round((now - hb) / 1000) : null;
      const online = secondsSinceHeartbeat !== null && secondsSinceHeartbeat <= ONLINE_WINDOW_SECONDS;
      const img = row.lastImageReceivedAt ? new Date(row.lastImageReceivedAt).getTime() : null;
      const secondsSinceImage = img ? Math.round((now - img) / 1000) : null;

      const requester = row.restartRequestedBy;
      const requestedByName = requester
        ? ([requester.firstName, requester.lastName].filter(Boolean).join(' ') || null)
        : null;

      return success(res, {
        configured: true,
        bridgeId: row.bridgeId,
        online,
        listenerOk: row.listenerOk,
        secondsSinceHeartbeat,
        secondsSinceImage,
        lastHeartbeatAt: row.lastHeartbeatAt,
        lastImageReceivedAt: row.lastImageReceivedAt,
        queueDepth: row.queueDepth,
        aeTitle: row.aeTitle,
        localIp: row.localIp,
        version: row.version,
        restartPending: isRestartPending(row),
        restartRequestedAt: row.restartRequestedAt,
        restartRequestedBy: requestedByName,
        onlineWindowSeconds: ONLINE_WINDOW_SECONDS,
      });
    } catch (err) {
      console.error('BridgeStatus.status error:', err);
      return error(res, 'Failed to read bridge status', 500);
    }
  },

  // POST /api/ultrasound/bridge/restart  (JWT — radiology users)
  async requestRestart(req, res) {
    try {
      const bridgeId = String((req.body && req.body.bridgeId) || DEFAULT_BRIDGE_ID);
      const now = new Date();
      const [row] = await BridgeStatus.findOrCreate({
        where: { bridgeId },
        defaults: { bridgeId },
      });
      await row.update({
        restartRequestedAt: now,
        restartRequestedById: req.user.id,
        restartAckedAt: null, // clear ack so the next heartbeat picks it up
      });
      return success(res, { restartRequestedAt: now });
    } catch (err) {
      console.error('BridgeStatus.requestRestart error:', err);
      return error(res, 'Failed to request bridge restart', 500);
    }
  },
};

module.exports = bridgeController;
