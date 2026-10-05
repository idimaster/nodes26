import { runCheck, DEFAULT_PATHS } from '../../scripts/check-tool-surface.js';
import { ROOT } from '../_shared/fixture.js';

/**
 * After: `npm run check:tools` (scripts/check-tool-surface.ts, a CI step) launches every .mcp.json server and
 * asserts skill tools = agent tools ⊆ served tools, with every write tool behind the guard hook.
 */
export const toolSurfaceProblems = (agent = DEFAULT_PATHS.agent) => runCheck(ROOT, { ...DEFAULT_PATHS, agent });
