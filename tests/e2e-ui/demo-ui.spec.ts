import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

/** T4.2 addendum Step 6, E2E: layout stability on scene 2, witness highlight and zoom, gate actions from the page. */

const fixture = (...args: string[]) => execFileSync('node_modules/.bin/tsx', ['tests/e2e-ui/fixture.ts', ...args], { encoding: 'utf8' }).trim();
const POLL = 500;

type Pos = Record<string, { x: number; y: number }>;
const demo = <T>(page: Page, f: string) => page.evaluate(`(() => { const d = window.__demo; return ${f}; })()`) as Promise<T>;

// The page exposes window.__demo = {cy, isLayoutDone, state}; expressions run in the browser.
const positions = (page: Page) => demo<Pos>(page, 'Object.fromEntries(d.cy.nodes().map((n) => [n.id(), { ...n.position() }]))');

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  fixture('reset');
  fixture('step', '1');
});

test('existing nodes move < 5 px across 10 polls while nodes are added in 3 steps (scene 2)', async ({ page }) => {
  await page.goto(`/?deal=nimbus&scene=2&poll=${POLL}`);
  await expect.poll(() => demo<boolean>(page, 'd.isLayoutDone() && d.cy.nodes().length > 0')).toBe(true);
  const before: Pos = await positions(page);
  const initial = Object.keys(before).length;

  fixture('step', '2');
  await page.waitForTimeout(POLL * 3);
  fixture('step', '3');
  await page.waitForTimeout(POLL * 10);

  const after: Pos = await positions(page);
  expect(Object.keys(after).length).toBeGreaterThan(initial);
  for (const [id, p] of Object.entries(before)) {
    const q = after[id];
    expect(q, `node ${id} is still there`).toBeDefined();
    expect(Math.hypot((q?.x ?? 0) - p.x, (q?.y ?? 0) - p.y), `node ${id} moved`).toBeLessThan(5);
  }
});

test('a validator witness turns its nodes red, zooms to them, and shows a toast', async ({ page }) => {
  await page.goto(`/?deal=nimbus&scene=2&poll=${POLL}`);
  await expect.poll(() => demo<boolean>(page, 'd.isLayoutDone() && d.cy.nodes().length > 0')).toBe(true);
  const zoom = await demo<number>(page, 'd.cy.zoom()');
  fixture('witness');
  await expect.poll(() => demo<number>(page, "d.cy.$('node.witness').length"), { timeout: 10_000 }).toBe(2);
  expect(await demo<string[]>(page, "d.cy.$('node.witness').map((n) => n.style('background-color'))")).toEqual(['rgb(255,92,92)', 'rgb(255,92,92)']);
  await expect(page.locator('#toast')).toContainText('V2');
  await expect.poll(() => demo<number>(page, 'd.cy.zoom()'), { timeout: 2_000 }).not.toBe(zoom);
});

test('approve, approve except, and reject from the page each resolve a pending gate', async ({ page, request }) => {
  fixture('reset');
  for (const step of ['1', '2', '3']) fixture('step', step);
  const ids = [
    fixture('gate', 'select', 'Selection:user-provisioning'),
    fixture('gate', 'select', 'Selection:ledger-data-sync'),
    fixture('gate', 'select', 'Selection:identity-federation-trust'),
  ];
  await page.goto(`/?deal=nimbus&scene=2&poll=${POLL}`);
  const card = (id: string) => page.locator(`[data-gate-id="${id}"]`);
  await expect(card(ids[0] as string)).toBeVisible();
  await expect(page.locator('#badge')).toHaveText('3');

  await card(ids[0] as string).getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(card(ids[0] as string)).toHaveCount(0);

  await card(ids[1] as string).locator('textarea').fill('except cdc-replication');
  await card(ids[1] as string).getByRole('button', { name: 'Approve except…' }).click();
  await expect(card(ids[1] as string)).toHaveCount(0);

  await card(ids[2] as string).getByRole('button', { name: 'Reject' }).click();
  await expect(card(ids[2] as string).locator('.error')).toContainText('needs a comment');
  await card(ids[2] as string).locator('textarea').fill('Not this iteration.');
  await card(ids[2] as string).getByRole('button', { name: 'Reject' }).click();
  await expect(card(ids[2] as string)).toHaveCount(0);
  await expect(page.locator('#badge')).toHaveText('0');

  const gates = (await (await request.get('/api/gates?deal=nimbus')).json()) as { id: string; status: string }[];
  const status = Object.fromEntries(gates.map((g) => [g.id, g.status]));
  expect(ids.map((id) => status[id])).toEqual(['approved', 'approved', 'rejected']);
});

test.afterAll(() => {
  fixture('reset');
});
