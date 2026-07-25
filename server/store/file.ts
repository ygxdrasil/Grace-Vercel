import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import type {Backend} from './types';

/**
 * Grace's memory on your own disk. Writes go to a temp file and are renamed
 * into place, so a crash mid-write cannot truncate the store.
 */
export class FileBackend implements Backend {
  readonly name = 'local disk';

  constructor(private readonly dir: string) {}

  private pathFor(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<string | null> {
    const file = this.pathFor(key);
    if (!existsSync(file)) return null;
    return readFile(file, 'utf8');
  }

  async write(key: string, value: string): Promise<void> {
    await mkdir(this.dir, {recursive: true});
    const file = this.pathFor(key);
    const temp = `${file}.tmp`;
    await writeFile(temp, value, {mode: 0o600});
    await rename(temp, file);
  }

  async quarantine(key: string): Promise<void> {
    const file = this.pathFor(key);
    if (existsSync(file)) {
      await rename(file, `${file}.unreadable-${Date.now()}`);
    }
  }
}
