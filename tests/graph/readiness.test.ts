import { afterAll, beforeAll, expect, it } from 'vitest';
import { openDriver } from '../../graph/connection.js';
import { loadAll } from '../../graph/load/index.js';
import { verifyLoadedDataset } from '../../graph/load/verify.js';

const driver = openDriver();
beforeAll(async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
});
afterAll(async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.close();
});

it('positively verifies keys, values, types, relationships and constraints', async () => {
  expect(await verifyLoadedDataset(driver, { deal: 'nimbus' })).toMatchObject({ retainedTerms: [] });
  await expect(verifyLoadedDataset(driver, { deal: '' })).rejects.toThrow(/selected deal.*exactly once/);
  await driver.executeQuery('MATCH (f:Finding {deal_code: $deal}) WITH f LIMIT 1 SET f.id = $id RETURN f.id', { deal: 'nimbus', id: 'wrong-key' });
  await expect(verifyLoadedDataset(driver, { deal: 'nimbus' })).rejects.toThrow(/DATASET_NOT_READY/);
});

it('rejects incomplete datasets even with no planning state', async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await expect(verifyLoadedDataset(driver, { deal: 'nimbus' })).rejects.toThrow(/DATASET_NOT_READY/);
  await loadAll(driver);
  await driver.executeQuery('MATCH (:Finding {deal_code: $deal})-[r:SUPPORTED_BY]->() WITH r LIMIT 1 DELETE r', { deal: 'nimbus' });
  await expect(verifyLoadedDataset(driver, { deal: 'nimbus' })).rejects.toThrow(/DATASET_NOT_READY/);
});

it('detects nanosecond changes in fixture history timestamps', async () => {
  await driver.executeQuery('MATCH (n) DETACH DELETE n');
  await loadAll(driver);
  await driver.executeQuery('MATCH (i:Iteration {deal_code: $deal}) SET i.started_at = i.started_at + duration({nanoseconds: 1}) RETURN i.n', { deal: 'tidewater' });
  await expect(verifyLoadedDataset(driver, { deal: 'nimbus' })).rejects.toThrow(/started_at.*differs/);
});
