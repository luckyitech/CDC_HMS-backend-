const { success, error } = require('../utils/response');
const { broadcast } = require('../utils/sseManager');
const db = require('../models');

const { Ward, Room, Bed, Admission, Patient, User } = db;

// ====================================
// WARDS
// ====================================
exports.listWards = async (req, res) => {
  try {
    const wards = await Ward.findAll({
      include: [{ model: Room, include: [Bed] }],
      order: [['name', 'ASC']],
    });
    return success(res, wards);
  } catch (err) {
    console.error('Ward.listWards error:', err);
    return error(res, 'Failed to load wards', 500);
  }
};

exports.createWard = async (req, res) => {
  try {
    const { name, code, type, ratePerDay } = req.body;
    if (!name) return error(res, 'Ward name is required', 400);
    const ward = await Ward.create({ name, code, type, ratePerDay: ratePerDay || 0 });
    return success(res, ward, 201);
  } catch (err) {
    console.error('Ward.createWard error:', err);
    return error(res, 'Failed to create ward', 500);
  }
};

exports.updateWard = async (req, res) => {
  try {
    const ward = await Ward.findByPk(req.params.id);
    if (!ward) return error(res, 'Ward not found', 404);
    const { name, code, type, isActive, ratePerDay } = req.body;
    await ward.update({
      name: name ?? ward.name,
      code: code ?? ward.code,
      type: type ?? ward.type,
      ratePerDay: ratePerDay ?? ward.ratePerDay,
      isActive: isActive ?? ward.isActive,
    });
    return success(res, ward);
  } catch (err) {
    console.error('Ward.updateWard error:', err);
    return error(res, 'Failed to update ward', 500);
  }
};

// ====================================
// ROOMS
// ====================================
exports.createRoom = async (req, res) => {
  try {
    const { wardId, name, type, bedCapacity } = req.body;
    if (!wardId || !name) return error(res, 'wardId and room name are required', 400);
    const room = await Room.create({ WardId: wardId, name, type, bedCapacity });
    return success(res, room, 201);
  } catch (err) {
    console.error('Room.createRoom error:', err);
    return error(res, 'Failed to create room', 500);
  }
};

exports.updateRoom = async (req, res) => {
  try {
    const room = await Room.findByPk(req.params.id);
    if (!room) return error(res, 'Room not found', 404);
    const { name, type, bedCapacity, isActive } = req.body;
    await room.update({
      name: name ?? room.name,
      type: type ?? room.type,
      bedCapacity: bedCapacity ?? room.bedCapacity,
      isActive: isActive ?? room.isActive,
    });
    return success(res, room);
  } catch (err) {
    console.error('Room.updateRoom error:', err);
    return error(res, 'Failed to update room', 500);
  }
};

// ====================================
// BEDS
// ====================================
exports.createBed = async (req, res) => {
  try {
    const { roomId, label } = req.body;
    if (!roomId || !label) return error(res, 'roomId and label are required', 400);
    const room = await Room.findByPk(roomId);
    if (!room) return error(res, 'Room not found', 404);
    const bed = await Bed.create({ RoomId: roomId, WardId: room.WardId, label, status: 'Available' });
    broadcast('board_updated');
    return success(res, bed, 201);
  } catch (err) {
    console.error('Bed.createBed error:', err);
    return error(res, 'Failed to create bed', 500);
  }
};

// Admin bed edit — may set Available / Blocked / Cleaning only. NEVER Occupied
// (that is owned by the admission/transfer/discharge controllers).
exports.updateBed = async (req, res) => {
  try {
    const bed = await Bed.findByPk(req.params.id);
    if (!bed) return error(res, 'Bed not found', 404);
    const { label, status, isActive } = req.body;
    if (status && !['Available', 'Blocked', 'Cleaning'].includes(status)) {
      return error(res, 'Bed status can only be set to Available, Blocked or Cleaning here', 400);
    }
    await bed.update({
      label: label ?? bed.label,
      status: status ?? bed.status,
      isActive: isActive ?? bed.isActive,
    });
    broadcast('board_updated');
    return success(res, bed);
  } catch (err) {
    console.error('Bed.updateBed error:', err);
    return error(res, 'Failed to update bed', 500);
  }
};

// Porter/turnaround: Cleaning -> Available
exports.releaseBed = async (req, res) => {
  try {
    const bed = await Bed.findByPk(req.params.id);
    if (!bed) return error(res, 'Bed not found', 404);
    if (bed.status !== 'Cleaning') return error(res, 'Only beds in Cleaning can be released', 400);
    await bed.update({ status: 'Available' });
    broadcast('board_updated');
    return success(res, bed);
  } catch (err) {
    console.error('Bed.releaseBed error:', err);
    return error(res, 'Failed to release bed', 500);
  }
};

// ====================================
// BOARD — live wards -> beds with occupant summary
// ====================================
exports.board = async (req, res) => {
  try {
    const wards = await Ward.findAll({
      where: { isActive: true },
      include: [{ model: Room, include: [Bed] }],
      order: [['name', 'ASC']],
    });

    // Current admissions keyed by bed
    const admissions = await Admission.findAll({
      where: { status: 'Admitted' },
      include: [
        { model: Patient, attributes: ['uhid', 'firstName', 'lastName'] },
        { model: User, as: 'attendingDoctor', attributes: ['firstName', 'lastName'] },
      ],
    });
    const byBed = {};
    admissions.forEach((a) => { if (a.BedId) byBed[a.BedId] = a; });

    const shaped = wards.map((w) => ({
      id: w.id, name: w.name, code: w.code, type: w.type,
      beds: (w.Rooms || []).flatMap((room) =>
        (room.Beds || []).map((bed) => {
          const adm = byBed[bed.id];
          return {
            bedId: bed.id, label: bed.label, roomName: room.name, status: bed.status,
            admissionId: adm ? adm.id : null,
            patient: adm && adm.Patient ? {
              uhid: adm.Patient.uhid,
              name: `${adm.Patient.firstName} ${adm.Patient.lastName}`,
            } : null,
            attendingDoctor: adm && adm.attendingDoctor
              ? `Dr. ${adm.attendingDoctor.firstName} ${adm.attendingDoctor.lastName}` : null,
          };
        })
      ),
    }));

    return success(res, shaped);
  } catch (err) {
    console.error('Ward.board error:', err);
    return error(res, 'Failed to load ward board', 500);
  }
};
