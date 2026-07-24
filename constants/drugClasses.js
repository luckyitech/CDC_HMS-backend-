/**
 * Drug classes that power the clinical tools.
 *
 * A catalogue medication's `drugClass` says what the drug IS (its clinical
 * class). Each tool declares which class it consumes — see TOOL_DRUG_CLASS —
 * so the same class can feed a tool, a report or a safety check without
 * re-tagging the drug. Admins pick a class from a dropdown on the Clinical
 * Catalog page; they never type a magic word into the name.
 *
 * `value` is a stable slug stored in the database. `label` is display text and
 * may be reworded freely. To add a class: add an entry here, and (if a tool
 * uses it) point the tool at its slug below.
 */

const DRUG_CLASSES = [
  { value: 'glp1', label: 'GLP-1 / GIP agonist' },
];

const DRUG_CLASS_VALUES = DRUG_CLASSES.map((c) => c.value);

// Which drug class each clinical tool draws its agents from.
const TOOL_DRUG_CLASS = {
  glp1: 'glp1',
};

module.exports = { DRUG_CLASSES, DRUG_CLASS_VALUES, TOOL_DRUG_CLASS };
