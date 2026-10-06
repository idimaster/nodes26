import { fileURLToPath } from 'node:url';
import { openDriver } from '../../../graph/connection.js';
import { createPlanner, modelFromEnv } from './agent.js';

/**
 * npm run example:ai-sdk -- "Plan the Nimbus integration."
 * Needs ANTHROPIC_API_KEY (or PLANNER_MODEL=openai-compatible:<id> with OPENAI_COMPATIBLE_BASE_URL).
 * Approve the gates in the demo UI (npm run demo:ui).
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const prompt = process.argv.slice(2).join(' ') || 'Plan the Nimbus integration.';
const driver = openDriver();
const planner = await createPlanner({ root: ROOT, driver, model: modelFromEnv() });
try {
  const result = await planner.agent.generate({
    prompt,
    onStepFinish: (step) => {
      for (const c of step.toolCalls) console.log(`→ ${c.toolName}`);
    },
  });
  console.log(`\n${result.text}\n\n(${result.steps.length} steps)`);
} finally {
  await planner.close();
  await driver.close();
}
