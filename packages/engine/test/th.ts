import raw from '../../../config/thresholds.json' with { type: 'json' };
import { thresholdsSchema } from '../src/index.js';

/** The real thresholds; unit-test expectations are hand-computed from these values. */
export const TH = thresholdsSchema.parse(raw);
