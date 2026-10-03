import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Driver } from 'neo4j-driver';
import { openDriver } from './connection.js';

export const SCHEMA_FILE = fileURLToPath(new URL('./schema.cypher', import.meta.url));

/**
 * Splits a DDL file into statements. Only full-line `//` comments are supported, and a
 * statement ends at a line whose last character is `;`. That is all schema.cypher needs.
 */
export function splitStatements(text: string): string[] {
  const statements: string[] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    if (trimmed.endsWith(';')) {
      current.push(line.replace(/;\s*$/, ''));
      statements.push(current.join('\n').trim());
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) throw new Error(`unterminated statement at end of schema: ${current.join(' ').trim()}`);
  return statements;
}

/** Applies each statement in its own auto-commit transaction (schema and data can't share one). */
export async function applySchema(driver: Driver, text: string): Promise<{ applied: number }> {
  const statements = splitStatements(text);
  for (const statement of statements) {
    await driver.executeQuery(statement);
  }
  return { applied: statements.length };
}

async function main(): Promise<void> {
  const driver = openDriver();
  try {
    const { applied } = await applySchema(driver, readFileSync(SCHEMA_FILE, 'utf8'));
    console.log(`schema: applied ${applied} statements from graph/schema.cypher`);
  } finally {
    await driver.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
