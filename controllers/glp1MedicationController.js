const { Op } = require('sequelize');
const { success, error } = require('../utils/response');
const db = require('../models');

const { CatalogItem } = db;

// ====================================
// GLP-1 agents, derived from the clinic catalogue
// ====================================
//
// All medication decisions in the app come from one place — the clinic catalogue
// (CatalogItem, type 'medication'). A GLP-1 agent is simply a catalogue
// medication whose name or detail is tagged 'GLP-1' or 'GIP'. There is no
// separate GLP-1 formulary and no per-agent stored ladder: a course's dose
// schedule is built with the custom-ladder builder at initiation.
//
// Agents are added and edited through the admin Clinical Catalog page, so this
// controller is read-only.

// A catalogue medication counts as a GLP-1 agent when its name or detail mentions
// GLP-1 or GIP. Kept here so the SQL filter and any client-side check agree.
const AGENT_MATCH = [
  { name:   { [Op.like]: '%GLP%' } },
  { name:   { [Op.like]: '%GIP%' } },
  { detail: { [Op.like]: '%GLP%' } },
  { detail: { [Op.like]: '%GIP%' } },
];

const formatAgent = (item) => {
  const m = item.dataValues || item;
  return {
    id:          m.id,
    genericName: m.name,
    brandName:   m.detail || null,
    isActive:    true,          // catalogue entries are the live list by definition
  };
};

/**
 * GET /api/glp1-medications
 * The GLP-1 agents available to the tool — catalogue medications tagged GLP-1 /
 * GIP. Drives the medication tabs.
 *
 * Authorization: doctor, admin (set at the route)
 */
const list = async (req, res) => {
  try {
    const agents = await CatalogItem.findAll({
      where: { type: 'medication', [Op.or]: AGENT_MATCH },
      order: [['name', 'ASC']],
    });

    return success(res, { medications: agents.map(formatAgent) });
  } catch (err) {
    console.error('Glp1Medication.list error:', err);
    return error(res, 'Failed to retrieve GLP-1 agents', 500);
  }
};

module.exports = { list };
