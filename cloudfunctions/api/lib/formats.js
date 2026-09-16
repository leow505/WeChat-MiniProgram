/**
 * Play format templates. DESIGN.md §3.9
 *
 * A constant table, not a collection — these are presets that seed the create
 * form, not configuration anyone edits. Every derived number stays editable
 * afterwards, so a template is a starting point rather than a constraint.
 *
 * KEEP IN SYNC with miniprogram/utils/formats.js.
 */

const FORMATS = {
  SOCIAL_MIXER: { per_court: 6, mode: 'OPEN' },
  DOUBLES: { per_court: 4, mode: 'OPEN' },
  MIXED_DOUBLES: { per_court: 4, mode: 'GENDER_BALANCED', ratio: { male: 2, female: 2 } },
  MIXED_MIXER: { per_court: 6, mode: 'GENDER_BALANCED', ratio: { male: 3, female: 3 } },
  MENS_DOUBLES: { per_court: 4, mode: 'GENDER_BALANCED', ratio: { male: 4, female: 0 } },
  WOMENS_DOUBLES: { per_court: 4, mode: 'GENDER_BALANCED', ratio: { male: 0, female: 4 } },
  SINGLES: { per_court: 2, mode: 'OPEN' },
}

/** Display order in the picker: most common first. */
const ORDER = [
  'DOUBLES',
  'MIXED_DOUBLES',
  'SOCIAL_MIXER',
  'MIXED_MIXER',
  'MENS_DOUBLES',
  'WOMENS_DOUBLES',
  'SINGLES',
]

function spec(key) {
  return FORMATS[key] || FORMATS.DOUBLES
}

/**
 * Capacity implied by a format across N courts, plus the gender split when the
 * format needs one.
 */
function capacityFor(key, courtCount) {
  const s = spec(key)
  const courts = Math.max(1, courtCount || 1)

  if (s.mode !== 'GENDER_BALANCED') {
    return { capacity: s.per_court * courts, by_gender: null }
  }
  const by_gender = {
    male: s.ratio.male * courts,
    female: s.ratio.female * courts,
  }
  return { capacity: by_gender.male + by_gender.female, by_gender }
}

function isBalanced(key) {
  return spec(key).mode === 'GENDER_BALANCED'
}

module.exports = { FORMATS, ORDER, spec, capacityFor, isBalanced }
