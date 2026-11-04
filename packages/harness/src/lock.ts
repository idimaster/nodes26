import { access, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const lockPath = (root: string) => join(root, '.logs/managed-run.lock');
export async function assertNoManagedRun(root: string): Promise<void> {
  const directory = lockPath(root);
  let pid: number;
  try { pid = Number(await readFile(join(directory, 'pid'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { await access(directory); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
      throw new Error('managed run lock is initializing or incomplete; inspect .logs/managed-run.lock', { cause: error });
    }
    throw error;
  }
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('managed run lock is invalid; inspect .logs/managed-run.lock');
  try { process.kill(pid, 0); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    await unlink(join(directory, 'pid')); await rmdir(directory); return;
  }
  throw new Error('an active managed run/console owns this demo; stop it before launch or reset');
}

export async function acquireRunLock(root: string): Promise<() => Promise<void>> {
  await mkdir(join(root, '.logs'), { recursive: true });
  await assertNoManagedRun(root);
  const directory = lockPath(root);
  await mkdir(directory); // exclusive; concurrent launch loses here
  try { await writeFile(join(directory, 'pid'), String(process.pid)); }
  catch (error) { await rmdir(directory); throw error; }
  let released = false;
  return async () => { if (!released) { released = true; await unlink(join(directory, 'pid')); await rmdir(directory); } };
}
