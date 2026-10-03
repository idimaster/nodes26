import type { Driver } from 'neo4j-driver';
import { DATA_DIR, readCatalogDataset } from '@planner/data';
import { writeDataset } from './write.js';

/** Loads the global knowledge subgraph (catalog): nodes first, then relationships. */
export const loadCatalog = (driver: Driver, dir = DATA_DIR) => writeDataset(driver, readCatalogDataset(dir));
