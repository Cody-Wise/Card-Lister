// Builds eBay `conditionDescriptors` for graded trading cards.
//
// eBay identifies graded-card attributes with fixed descriptor "name" ids and
// enumerated value ids:
//   27501 = Professional Grader   (value id per grading company)
//   27502 = Grade                 (value id per grade)
//   27503 = Certification Number  (free-text string, goes in additionalInfo
//                                  — NOT values, which only ever holds
//                                  predefined numeric IDs)
//
// The value-id tables below were pulled live from eBay production's Sell
// Metadata API (GET /sell/metadata/v1/marketplace/EBAY_US/get_item_condition_
// policies?filter=categoryIds:{261328}) for Sports Trading Card Singles
// (category 261328), so they are confirmed-correct for that category as of
// this writing. They have NOT been validated for the trading-card-game /
// non-sport categories (see isSportsCategory below) — callers must gate on
// category before using this module.
const GRADER_NAME_ID = "27501";
const GRADE_NAME_ID = "27502";
const CERT_NUMBER_NAME_ID = "27503";
const CERT_NUMBER_MAX_LENGTH = 30; // eBay's documented constraint for 27503.

const GRADER_VALUE_IDS = {
  PSA: "275010",
  BCCG: "275011",
  BVG: "275012",
  BGS: "275013",
  BECKETT: "275013",
  CSG: "275014",
  CGC: "275015",
  SGC: "275016",
  KSA: "275017",
  GMA: "275018",
  HGA: "275019",
  ISA: "2750110",
  GSG: "2750112",
  PGS: "2750113",
  MNT: "2750114",
  TAG: "2750115",
  RARE: "2750116",
  RCG: "2750117",
  ACE: "2750119",
  CGA: "2750120",
  TCG: "2750121",
  OTHER: "2750123",
  AGS: "2750124",
  DSG: "2750125",
  MAJESTY: "2750126",
  GRAAD: "2750127",
  ARENA: "2750128",
  AIGRADING: "2750129"
};

const GRADE_VALUE_IDS = {
  "10": "275020",
  "9.5": "275021",
  "9": "275022",
  "8.5": "275023",
  "8": "275024",
  "7.5": "275025",
  "7": "275026",
  "6.5": "275027",
  "6": "275028",
  "5.5": "275029",
  "5": "2750210",
  "4.5": "2750211",
  "4": "2750212",
  "3.5": "2750213",
  "3": "2750214",
  "2.5": "2750215",
  "2": "2750216",
  "1.5": "2750217",
  "1": "2750218"
};

// eBay's schema ties each grade value to a specific set of compatible grader
// ids. The live response shows PSA (275010) is never included in any
// half-point grade's compatible-grader list — PSA's own scale doesn't issue
// half grades — so PSA + a half-point grade is an eBay-invalid combination.
const GRADERS_WITHOUT_HALF_GRADES = new Set(["PSA"]);

// True only for the category this module's value ids were validated against.
// Reuse the app's own resolveCategoryIdForCard()/config.categoryId to decide
// this at the call site — kept as a pure predicate here for testability.
export function isValidatedCategory(categoryId, sportsCategoryId) {
  return Boolean(categoryId) && String(categoryId) === String(sportsCategoryId);
}

// Extracts a numeric grade string ("10", "9.5", ...) from text that may still
// carry a grader prefix (e.g. "PSA 10") or be a bare number already.
function extractNumericGrade(gradeText) {
  const raw = String(gradeText || "").trim();
  const match = /\b(10|[1-9](?:\.5)?)\b/.exec(raw);
  return match ? match[1] : null;
}

function extractGrader(text) {
  const raw = String(text || "").trim();
  const match = /\b(psa|bgs|beckett|bvg|bccg|sgc|csg|cgc|ksa|gma|hga|isa|gsg|pgs|mnt|tag|rare|rcg|ace|cga|tcg|ags|dsg|majesty|graad|arena|aigrading)\b/i.exec(raw);
  return match ? match[1].toUpperCase() : null;
}

// Resolves { grader, grade } from a card's structured grading fields.
// `gradingCompany` (already a clean short code from OCR/review, e.g. "PSA") is
// the primary grader source; `candidateGrade` (often "PSA 10" combined, or
// occasionally a bare number) is the primary grade source and a grader
// fallback when gradingCompany is absent.
export function resolveGraderAndGrade(card = {}) {
  const grader = extractGrader(card.gradingCompany) || extractGrader(card.candidateGrade);
  const grade = extractNumericGrade(card.candidateGrade);
  return { grader, grade };
}

export function isConditionDescriptorsEnabled() {
  const flag = process.env.EBAY_CONDITION_DESCRIPTORS;
  // Enabled by default; set to "0"/"false" to disable.
  return flag !== "0" && flag !== "false";
}

// Returns an array of eBay conditionDescriptors for a graded card, or [] when
// the card isn't graded, the feature is disabled, the category hasn't been
// validated, or the grader/grade can't be confidently mapped (or is a known-
// invalid combination) — fails safe rather than sending values eBay rejects.
export function buildConditionDescriptors(card = {}, { categoryId, sportsCategoryId } = {}) {
  if (!isConditionDescriptorsEnabled()) return [];
  if (!isValidatedCategory(categoryId, sportsCategoryId)) return [];

  const { grader, grade } = resolveGraderAndGrade(card);
  const graderId = grader ? GRADER_VALUE_IDS[grader] : null;
  const gradeId = grade ? GRADE_VALUE_IDS[grade] : null;
  if (!graderId || !gradeId) return [];
  if (grade.includes(".5") && GRADERS_WITHOUT_HALF_GRADES.has(grader)) return [];

  const descriptors = [
    { name: GRADER_NAME_ID, values: [graderId] },
    { name: GRADE_NAME_ID, values: [gradeId] }
  ];

  // Confirmed against eBay's own ConditionDescriptor schema after a real
  // 400 rejection ("Condition descriptor value 44106187 is not valid...",
  // "Descriptor information sent as NULL..."): unlike Grader/Grade, the
  // Certification Number descriptor is free text and belongs in
  // additionalInfo, not values (values holds predefined numeric IDs only —
  // there's no such ID for an arbitrary cert number, so eBay rejected it
  // outright, and additionalInfo was simultaneously seen as unset).
  const certNumber = String(card.certificationNumber || "").trim();
  if (certNumber && certNumber.length <= CERT_NUMBER_MAX_LENGTH) {
    descriptors.push({ name: CERT_NUMBER_NAME_ID, additionalInfo: certNumber });
  }

  return descriptors;
}
