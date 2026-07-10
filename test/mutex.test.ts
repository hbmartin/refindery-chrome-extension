import { describe, it, expect } from 'vitest';
import { createMutex } from '@/common/mutex';

describe('createMutex', () => {
  it('runs sections one at a time, in call order, without interleaving', async () => {
    const run = createMutex();
    const log: string[] = [];
    const section = (name: string) =>
      run(async () => {
        log.push(`${name}:start`);
        await Promise.resolve();
        await Promise.resolve();
        log.push(`${name}:end`);
      });

    await Promise.all([section('a'), section('b'), section('c')]);

    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
  });

  it('serializes a read-modify-write so no update is lost', async () => {
    const run = createMutex();
    let shared = 0;
    const increment = () =>
      run(async () => {
        const current = shared;
        await Promise.resolve();
        shared = current + 1;
      });

    await Promise.all(Array.from({ length: 20 }, increment));

    expect(shared).toBe(20);
  });

  it('returns the callback rejection to its caller without wedging later callers', async () => {
    const run = createMutex();
    const failed = run(async () => {
      throw new Error('boom');
    });
    const after = run(async () => 'ok');

    await expect(failed).rejects.toThrow('boom');
    await expect(after).resolves.toBe('ok');
  });
});
