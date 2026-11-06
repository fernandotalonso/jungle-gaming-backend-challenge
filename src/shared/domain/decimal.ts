import Decimal from 'decimal.js';

// Centralized decimal configuration for the whole application.
// Money values are exact decimal strings with fixed scale 2; precision only
// affects division results (not used in this domain) and does not alter
// add/subtract exactness.
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
