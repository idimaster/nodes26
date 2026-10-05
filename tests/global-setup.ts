import { buildUiIfStale } from '../scripts/build-ui.js';

/** The gate console serves viz/dist; build it once before any test starts a console. */
export default async function setup() {
  await buildUiIfStale();
}
