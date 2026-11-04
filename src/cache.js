/** Tiny TTL cache (per process). Entries are also evicted explicitly by the model hooks when the data changes. */
export class TtlCache {
  constructor(ttlMs, max = 10000) {
    this.ttl = ttlMs;
    this.max = max;
    this.map = new Map();
  }
  get(k) {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k, v) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value); // oldest first
    this.map.set(k, { v, exp: Date.now() + this.ttl });
    return v;
  }
  delete(k) {
    this.map.delete(String(k));
  }
  clear() {
    this.map.clear();
  }
}
/** auth lookups: short TTL is only a safety net across processes; local writes evict immediately */
export const userCache = new TtlCache(10_000, 20_000);
/** chat metadata used by the send path (members/roles/dm status) */
export const chatCache = new TtlCache(30_000, 20_000);

/** evict from a mongoose query/doc hook: by _id when the filter has a plain id, otherwise everything (rare admin ops) */
export function evictFor(cache, filterOrDoc) {
  const id = filterOrDoc?._id;
  if (id && typeof id !== 'object') cache.delete(id);
  else if (id && typeof id.toHexString === 'function') cache.delete(id.toHexString());
  else cache.clear();
}
export function addEvictionHooks(schema, cache) {
  schema.post('save', function (doc) {
    cache.delete(String(doc._id));
  });
  for (const op of [
    'updateOne',
    'updateMany',
    'findOneAndUpdate',
    'findOneAndReplace',
    'replaceOne',
  ]) {
    schema.post(op, { document: false, query: true }, function () {
      evictFor(cache, this.getFilter());
    });
  }
  for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete']) {
    schema.post(op, { document: false, query: true }, function () {
      evictFor(cache, this.getFilter());
    });
    schema.post(op, { document: true, query: false }, function (doc) {
      cache.delete(String(doc?._id));
    });
  }
}
