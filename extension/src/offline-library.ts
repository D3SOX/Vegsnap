import { OfflineProductIndex, parseOfflineSnapshot, validateOfflineSnapshot, type OfflinePackInfo, type OfflineSnapshot } from '@vegsnap/core';
export interface OfflinePackStorage {
  read(): Promise<unknown[]>;
  put(snapshot: OfflineSnapshot): Promise<void>;
  remove(region: string): Promise<void>;
}
/** Every imported pack stays parsed in memory, so their total size is bounded to three maximum packs like in the apps. */
const MAX_INSTALLED_BYTES = 60_000_000;
const packBytes = (pack: OfflineSnapshot) => new TextEncoder().encode(JSON.stringify(pack)).length;
/** Serialize changes and publish a new index only after the storage transaction commits.
 * The index constructor validates every snapshot, so the bundled pack is validated and indexed once per start. */
export function createOfflineLibrary(storage: OfflinePackStorage, base: OfflineSnapshot) {
  let packs: OfflineSnapshot[] = [];
  let index: OfflineProductIndex | undefined;
  let queue = storage.read().then(values => { packs = values.map(validateOfflineSnapshot); });
  async function current() {
    await queue.catch(() => {});
    index ??= new OfflineProductIndex([base, ...packs]);
    return index;
  }
  function change(work: () => Promise<void>) {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  }
  return {
    index: current,
    async info(): Promise<OfflinePackInfo[]> {
      await current();
      return [base, ...packs].map((pack, position) => ({ region: pack.region, generatedAt: pack.generatedAt, count: pack.products.length, bundled: position === 0 }));
    },
    async import(text: string) {
      const snapshot = parseOfflineSnapshot(text);
      return change(async () => {
        const next = [...packs.filter(pack => pack.region !== snapshot.region), snapshot];
        if (next.length > 5) throw new Error('Remove an optional offline pack before importing another (maximum five).');
        if (next.reduce((total, pack) => total + packBytes(pack), 0) > MAX_INSTALLED_BYTES) throw new Error('Remove an optional offline pack before importing another (60 MB in total).');
        const nextIndex = new OfflineProductIndex([base, ...next]);
        await storage.put(snapshot);
        packs = next; index = nextIndex;
      });
    },
    async remove(region: string) {
      return change(async () => {
        const next = packs.filter(pack => pack.region !== region);
        const nextIndex = new OfflineProductIndex([base, ...next]);
        await storage.remove(region);
        packs = next; index = nextIndex;
      });
    },
  };
}
