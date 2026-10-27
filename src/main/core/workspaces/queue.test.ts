import { describe, expect, it } from 'vitest';

import { ProvisioningQueue, QueueFull } from './queue';

/*
 * The provisioning queue (B9a Design §2, Git execution boundary): one lane per repository (its
 * common Git directory, shared by every canvas), a bounded number of repositories at work at once,
 * and a bounded number of jobs waiting or running, past which it refuses rather than grows.
 */

function gate() {
  const opened = Promise.withResolvers<undefined>();
  return {
    wait: opened.promise,
    open: () => {
      opened.resolve(undefined);
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ProvisioningQueue', () => {
  it('says each time its jobs waiting or running change, for the core’s presence', async () => {
    const sizes: number[] = [];
    const queue: ProvisioningQueue = new ProvisioningQueue({
      changed: () => sizes.push(queue.size),
    });
    const first = gate();
    const one = queue.run('/repo/.git', () => first.wait);
    const two = queue.run('/other/.git', () => Promise.reject(new Error('no')));
    expect(sizes).toEqual([1, 2]);
    await two.catch(() => undefined);
    expect(sizes).toEqual([1, 2, 1]);
    first.open();
    await one;
    expect(sizes).toEqual([1, 2, 1, 0]);
  });

  it('runs one repository’s work in turn, a failure not stopping what follows', async () => {
    const queue = new ProvisioningQueue();
    const order: string[] = [];
    const first = gate();
    const one = queue.run('/repo/.git', async () => {
      order.push('one starts');
      await first.wait;
      order.push('one ends');
      throw new Error('one failed');
    });
    const two = queue.run('/repo/.git', () => {
      order.push('two');
      return Promise.resolve(2);
    });
    await tick();
    expect(order).toEqual(['one starts']);
    first.open();
    await expect(one).rejects.toThrow('one failed');
    expect(await two).toBe(2);
    expect(order).toEqual(['one starts', 'one ends', 'two']);
    expect(queue.size).toBe(0);
  });

  it('works on at most its concurrency of repositories at once', async () => {
    const queue = new ProvisioningQueue({ concurrency: 2 });
    const running = new Set<string>();
    let most = 0;
    const gates = new Map(['a', 'b', 'c'].map((key) => [key, gate()]));
    const runs = [...gates].map(([key, { wait }]) =>
      queue.run(key, async () => {
        running.add(key);
        most = Math.max(most, running.size);
        await wait;
        running.delete(key);
      }),
    );
    await tick();
    expect([...running].sort()).toEqual(['a', 'b']);
    gates.get('a')?.open();
    await tick();
    await tick();
    expect([...running].sort()).toEqual(['b', 'c']);
    gates.get('b')?.open();
    gates.get('c')?.open();
    await Promise.all(runs);
    expect(most).toBe(2);
  });

  it('refuses work past its capacity, taking more once some is done', async () => {
    const queue = new ProvisioningQueue({ capacity: 2 });
    const held = gate();
    const one = queue.run('a', () => held.wait);
    const two = queue.run('b', () => held.wait);
    expect(queue.full).toBe(true);
    await expect(queue.run('c', () => Promise.resolve())).rejects.toBeInstanceOf(QueueFull);
    held.open();
    await Promise.all([one, two]);
    expect(queue.full).toBe(false);
    await queue.run('c', () => Promise.resolve());
  });
});
