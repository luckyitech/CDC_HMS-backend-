// =====================================================================
// Dermatology body map — the region vocabulary (Phase 1, 7 Oct 2026).
//
// ONE list of body regions a skin finding can sit on. The frontend draws the
// same ids in cdc-hms/src/constants/dermRegions.js; tests/dermatology.test.js
// fails if the two lists of ids ever differ. A region id is stored on
// DermFindingRegions.region, so an id must NEVER be renamed once it has shipped
// — add a new one and stop offering the old one instead.
//
// Laterality is the PATIENT'S side ("Left cheek" = the patient's left cheek).
// `sensitive` regions blur their photos by default (Phase 2); the clinic can
// widen that list later, never narrow it below these.
// =====================================================================

const DERM_REGIONS = [
  // Front
  { id: 'f-forehead',    view: 'front', label: 'Forehead' },
  { id: 'f-cheek-r',     view: 'front', label: 'Right cheek' },
  { id: 'f-cheek-l',     view: 'front', label: 'Left cheek' },
  { id: 'f-midface',     view: 'front', label: 'Nose, lips & chin' },
  { id: 'f-neck',        view: 'front', label: 'Neck (front)' },
  { id: 'f-chest-r',     view: 'front', label: 'Right chest' },
  { id: 'f-chest-l',     view: 'front', label: 'Left chest' },
  { id: 'f-abdo',        view: 'front', label: 'Abdomen' },
  { id: 'f-groin',       view: 'front', label: 'Groin & genitalia', sensitive: true },
  { id: 'f-uarm-r',      view: 'front', label: 'Right upper arm' },
  { id: 'f-forearm-r',   view: 'front', label: 'Right forearm' },
  { id: 'f-hand-r',      view: 'front', label: 'Right palm' },
  { id: 'f-uarm-l',      view: 'front', label: 'Left upper arm' },
  { id: 'f-forearm-l',   view: 'front', label: 'Left forearm' },
  { id: 'f-hand-l',      view: 'front', label: 'Left palm' },
  { id: 'f-thigh-r',     view: 'front', label: 'Right thigh' },
  { id: 'f-thigh-l',     view: 'front', label: 'Left thigh' },
  { id: 'f-knee-r',      view: 'front', label: 'Right knee' },
  { id: 'f-knee-l',      view: 'front', label: 'Left knee' },
  { id: 'f-leg-r',       view: 'front', label: 'Right shin' },
  { id: 'f-leg-l',       view: 'front', label: 'Left shin' },
  { id: 'f-foot-r',      view: 'front', label: 'Right foot (top)' },
  { id: 'f-foot-l',      view: 'front', label: 'Left foot (top)' },
  // Back
  { id: 'b-scalp',       view: 'back',  label: 'Scalp' },
  { id: 'b-neck',        view: 'back',  label: 'Neck (back)' },
  { id: 'b-uback-l',     view: 'back',  label: 'Left upper back' },
  { id: 'b-uback-r',     view: 'back',  label: 'Right upper back' },
  { id: 'b-lback',       view: 'back',  label: 'Lower back' },
  { id: 'b-butt-l',      view: 'back',  label: 'Left buttock', sensitive: true },
  { id: 'b-butt-r',      view: 'back',  label: 'Right buttock', sensitive: true },
  { id: 'b-uarm-l',      view: 'back',  label: 'Left upper arm (back)' },
  { id: 'b-elbow-l',     view: 'back',  label: 'Left elbow' },
  { id: 'b-farm-l',      view: 'back',  label: 'Left forearm (back)' },
  { id: 'b-hand-l',      view: 'back',  label: 'Left hand (back)' },
  { id: 'b-uarm-r',      view: 'back',  label: 'Right upper arm (back)' },
  { id: 'b-elbow-r',     view: 'back',  label: 'Right elbow' },
  { id: 'b-farm-r',      view: 'back',  label: 'Right forearm (back)' },
  { id: 'b-hand-r',      view: 'back',  label: 'Right hand (back)' },
  { id: 'b-thigh-l',     view: 'back',  label: 'Left back of thigh' },
  { id: 'b-thigh-r',     view: 'back',  label: 'Right back of thigh' },
  { id: 'b-calf-l',      view: 'back',  label: 'Left calf' },
  { id: 'b-calf-r',      view: 'back',  label: 'Right calf' },
  { id: 'b-sole-l',      view: 'back',  label: 'Left sole' },
  { id: 'b-sole-r',      view: 'back',  label: 'Right sole' },
];

const REGION_IDS = DERM_REGIONS.map((r) => r.id);
const REGION_BY_ID = Object.fromEntries(DERM_REGIONS.map((r) => [r.id, r]));

const isRegion = (id) => Object.prototype.hasOwnProperty.call(REGION_BY_ID, id);
const regionLabel = (id) => REGION_BY_ID[id]?.label || id;
const isSensitiveRegion = (id) => !!REGION_BY_ID[id]?.sensitive;

module.exports = { DERM_REGIONS, REGION_IDS, isRegion, regionLabel, isSensitiveRegion };
