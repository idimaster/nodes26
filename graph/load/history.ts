import type { Driver } from 'neo4j-driver';
import { DATA_DIR, readHistoryDataset } from '@planner/data';
import { writeDataset } from './write.js';

/** Loads the completed history deals (committed plans and Actuals): nodes first, then relationships. */
export const loadHistory = (driver: Driver, dir = DATA_DIR) => writeDataset(driver, readHistoryDataset(dir));
