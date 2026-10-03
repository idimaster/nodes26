import type { Driver } from 'neo4j-driver';
import { DATA_DIR, readDealDataset } from '@planner/data';
import { writeDataset } from './write.js';

/** Loads the Nimbus deal (hand-authored and generated findings): nodes first, then relationships. */
export const loadDeal = (driver: Driver, dir = DATA_DIR) => writeDataset(driver, readDealDataset(dir));
