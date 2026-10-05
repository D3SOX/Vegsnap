import { expect, test } from 'bun:test';
import { synchronizedRefresh } from '../src/synchronization';

test('two open clients receive mutations and ignore superseded snapshots', async () => {
  let history = ['first'];
  let release: (() => void) | undefined;
  let delayNext = false;
  const read = async () => {
    const snapshot = [...history];
    if (delayNext) { delayNext = false; await new Promise<void>(resolve => { release = resolve; }); }
    return snapshot;
  };
  const views: string[][] = [[], []];
  const clients = views.map((_, i) => synchronizedRefresh(read, value => { views[i] = value; }, error => { throw error; }));
  await Promise.all(clients.map(client => client.refresh()));
  expect(views).toEqual([['first'], ['first']]);
  delayNext = true;
  const stale = clients[0]!.refresh();
  history = ['second', 'first'];
  void clients[0]!.refresh();
  await clients[1]!.refresh();
  release!(); await stale;
  expect(views).toEqual([history, history]);
  history = [];
  await Promise.all(clients.map(client => client.refresh()));
  expect(views).toEqual([[], []]);
});

test('unmounted clients ignore late responses', async () => {
  let release!: () => void;
  const values: number[] = [];
  const client = synchronizedRefresh(async () => { await new Promise<void>(resolve => { release = resolve; }); return 1; }, value => values.push(value), () => {});
  const pending = client.refresh(); client.dispose(); release(); await pending;
  expect(values).toEqual([]);
});
