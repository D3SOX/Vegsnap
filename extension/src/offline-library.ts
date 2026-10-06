import { OfflineProductIndex, parseOfflineSnapshot, validateOfflineSnapshot, type OfflinePackInfo, type OfflineSnapshot } from '@vegsnap/core';
export interface OfflinePackStorage {
  read(): Promise<unknown[]>;
  put(snapshot: OfflineSnapshot): Promise<void>;
  remove(region: string): Promise<void>;
}
/** Serialize changes and publish a new index only after the storage transaction commits. */
export function createOfflineLibrary(storage: OfflinePackStorage, bundled: OfflineSnapshot) {
  const base = validateOfflineSnapshot(bundled);
  let packs: OfflineSnapshot[] = [];
  let index = new OfflineProductIndex([base]);
  let queue = storage.read().then(values => {
    packs = values.map(validateOfflineSnapshot);
    index = new OfflineProductIndex([base, ...packs]);
  });
  function change(work: () => Promise<void>) {
    const next = queue.catch(() => {}).then(work);
    queue = next;
    return next;
  }
  return {
    async index() { await queue.catch(() => {}); return index; },
    async info(): Promise<OfflinePackInfo[]> {
      await queue.catch(() => {});
      return [base, ...packs].map((pack, position) => ({ region: pack.region, generatedAt: pack.generatedAt, count: pack.products.length, bundled: position === 0 }));
    },
    async import(text: string) {
      const snapshot = parseOfflineSnapshot(text);
      return change(async () => {
        const next = [...packs.filter(pack => pack.region !== snapshot.region), snapshot];
        if (next.length > 5) throw new Error('Remove an optional offline pack before importing another (maximum five).');
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
