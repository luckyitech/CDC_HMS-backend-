const { Op } = require('sequelize');
const db = require('../models');
const { getRateCard, rateFor } = require('../utils/commsCosts');
const { getCommsConfig } = require('../utils/commsConfig');

const { ConversationMessage, Conversation, ConversationEscalation, User } = db;

// ---------------------------------------------------------------------------
// Communications Inbox analytics. Two views:
//   operations() — staff/doctor workload + responsiveness (counts + reply times)
//   costs()      — KES the clinic is billed, category × rate card
//
// A clinic's message volume is modest (thousands/month), so the aggregation is
// done in JS over the rows in range rather than in fragile SQL over the JSON
// and status columns — clearer, and the numbers can never disagree with the
// same classifiers used elsewhere.
// ---------------------------------------------------------------------------

const rangeWhere = (from, to, extra = {}) => {
  const where = { ...extra };
  const at = {};
  if (from) at[Op.gte] = new Date(from);
  if (to) { const t = new Date(to); t.setHours(23, 59, 59, 999); at[Op.lte] = t; }
  if (Object.keys(at).length) where.createdAt = at;
  return where;
};

const percentile = (sorted, p) => {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
};

/**
 * Reply-time waiting periods per conversation: each inbound that opens a new
 * wait (no earlier unanswered inbound already open) ends at the first outbound
 * after it. Returns first-reply durations (seconds) and the count still open.
 */
const replyStats = (messages) => {
  const byConv = new Map();
  for (const m of messages) {
    if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
    byConv.get(m.conversationId).push(m);
  }
  const firstReplies = [];
  let unanswered = 0;
  for (const list of byConv.values()) {
    list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let waitingSince = null;
    for (const m of list) {
      if (m.direction === 'in') { if (waitingSince == null) waitingSince = new Date(m.createdAt); }
      else if (m.direction === 'out' && waitingSince != null) {
        firstReplies.push((new Date(m.createdAt) - waitingSince) / 1000);
        waitingSince = null;
      }
    }
    if (waitingSince != null) unanswered += 1;
  }
  firstReplies.sort((a, b) => a - b);
  return {
    firstReplyMedianSec: percentile(firstReplies, 50),
    firstReplyP90Sec: percentile(firstReplies, 90),
    answeredCount: firstReplies.length,
    unanswered,
  };
};

const operations = async ({ from, to, channelId, staffId } = {}) => {
  const where = rangeWhere(from, to);
  if (channelId) where.channel = 'whatsapp';   // channel filter resolved via conversation below if needed
  const messages = await ConversationMessage.findAll({
    where,
    attributes: ['id', 'conversationId', 'direction', 'type', 'sentById', 'queryStatus', 'resolvedById', 'medicalDocumentId', 'createdAt'],
    include: [{ model: Conversation, attributes: ['id', 'topic', 'patientId', 'channelId'], required: false }],
    order: [['createdAt', 'ASC']],
  });
  const rows = channelId ? messages.filter((m) => m.Conversation && m.Conversation.channelId === Number(channelId)) : messages;
  const scoped = staffId ? rows.filter((m) => m.sentById === Number(staffId) || m.resolvedById === Number(staffId)) : rows;

  const inbound = rows.filter((m) => m.direction === 'in');
  const outbound = rows.filter((m) => m.direction === 'out');
  const templatesSent = outbound.filter((m) => m.type === 'template').length;
  const documentsFiled = rows.filter((m) => m.medicalDocumentId).length;

  // Topics
  const topicMap = {};
  for (const m of inbound) {
    const t = (m.Conversation && m.Conversation.topic) || '(untagged)';
    topicMap[t] = (topicMap[t] || 0) + 1;
  }
  const byTopic = Object.entries(topicMap).map(([topic, count]) => ({ topic, count })).sort((a, b) => b.count - a.count);

  // Per-staff (sent + completed queries)
  const staffMap = {};
  for (const m of rows) {
    if (m.direction === 'out' && m.sentById) { staffMap[m.sentById] = staffMap[m.sentById] || { staffId: m.sentById, sent: 0, completed: 0 }; staffMap[m.sentById].sent += 1; }
    if (m.queryStatus === 'completed' && m.resolvedById) { staffMap[m.resolvedById] = staffMap[m.resolvedById] || { staffId: m.resolvedById, sent: 0, completed: 0 }; staffMap[m.resolvedById].completed += 1; }
  }
  const staffIds = Object.keys(staffMap).map(Number);
  const users = staffIds.length ? await User.findAll({ where: { id: staffIds }, attributes: ['id', 'firstName', 'lastName', 'role'] }) : [];
  const nameById = Object.fromEntries(users.map((u) => [u.id, { name: `${u.firstName} ${u.lastName}`, role: u.role }]));
  const byStaff = Object.values(staffMap).map((s) => ({ ...s, ...(nameById[s.staffId] || { name: 'Unknown', role: null }) })).sort((a, b) => (b.sent + b.completed) - (a.sent + a.completed));

  // Heat-map (inbound by weekday 0-6 × hour 0-23), local clinic time is display-only
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const m of inbound) { const d = new Date(m.createdAt); heatmap[d.getDay()][d.getHours()] += 1; }

  const escalations = await ConversationEscalation.count({ where: rangeWhere(from, to) });

  return {
    totals: {
      inbound: inbound.length,
      outbound: outbound.length,
      conversations: new Set(rows.map((m) => m.conversationId)).size,
      patients: new Set(rows.map((m) => m.Conversation && m.Conversation.patientId).filter(Boolean)).size,
      templatesSent, documentsFiled, escalations,
      openQueries: inbound.filter((m) => m.queryStatus === 'open').length,
      completedQueries: inbound.filter((m) => m.queryStatus === 'completed').length,
    },
    responsiveness: replyStats(scoped.length ? scoped : rows),
    byTopic,
    byStaff,
    heatmap,
  };
};

const costs = async ({ from, to, channelId } = {}) => {
  const where = rangeWhere(from, to, { direction: 'out', billable: true });
  const messages = await ConversationMessage.findAll({
    where,
    attributes: ['id', 'pricingCategory', 'billable', 'createdAt', 'statusAt', 'conversationId'],
    include: channelId ? [{ model: Conversation, attributes: ['channelId'], required: true, where: { channelId } }] : [],
  });
  const rateCard = await getRateCard();
  const cfg = await getCommsConfig();

  const catMap = {};
  const dayMap = {};
  let total = 0;
  for (const m of messages) {
    const cat = (m.pricingCategory || 'service').toLowerCase();
    const when = m.statusAt || m.createdAt;
    const rate = rateFor(rateCard, 'whatsapp', cat, when);
    catMap[cat] = catMap[cat] || { category: cat, count: 0, unitRate: rate, cost: 0 };
    catMap[cat].count += 1;
    catMap[cat].cost = Math.round((catMap[cat].cost + rate) * 100) / 100;
    catMap[cat].unitRate = rate;
    total = Math.round((total + rate) * 100) / 100;
    const day = new Date(when).toISOString().slice(0, 10);
    dayMap[day] = Math.round(((dayMap[day] || 0) + rate) * 100) / 100;
  }

  return {
    currency: 'KES',
    total,
    billableMessages: messages.length,
    byCategory: Object.values(catMap).sort((a, b) => b.cost - a.cost),
    byDay: Object.entries(dayMap).map(([date, cost]) => ({ date, cost })).sort((a, b) => a.date.localeCompare(b.date)),
    monthlyBudgetKes: cfg.monthlyBudgetKes || 0,
    rateCard,
  };
};

module.exports = { operations, costs, replyStats };
