// Phase 4: the only way code reaches Vectorize. D1 holds every embedding; Vectorize is an index rebuilt from D1 when
// needed. Tests (TEST_FAKE_VECTORS) get an in-memory store with the same semantics minus the indexing delay.

export type VectorKind = 'clip' | 'face';

export interface VectorItem {
  id: string;
  values: number[];
  namespace?: string;
  metadata?: Record<string, string>;
}

export interface VectorMatch {
  id: string;
  /** Cosine similarity, 1 = identical. Cosine distance = 1 - score. */
  score: number;
  metadata?: Record<string, string>;
}

export interface VectorQuery {
  topK: number;
  namespace?: string;
  /** Equality or `$in` filters on metadata, as Vectorize supports. */
  filter?: Record<string, string | { $in: string[] }>;
}

export interface VectorStore {
  upsert(items: VectorItem[]): Promise<void>;
  query(vector: number[], q: VectorQuery): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

function vectorizeStore(index: VectorizeIndex): VectorStore {
  return {
    async upsert(items) {
      for (let i = 0; i < items.length; i += 500) {
        await index.upsert(items.slice(i, i + 500).map((v) => ({ id: v.id, values: v.values, namespace: v.namespace, metadata: v.metadata })));
      }
    },
    async query(vector, q) {
      const res = await index.query(vector, {
        topK: q.topK,
        namespace: q.namespace,
        filter: q.filter as VectorizeVectorMetadataFilter | undefined,
        returnMetadata: q.topK <= 50 ? 'indexed' : 'none',
      });
      return res.matches.map((m) => ({ id: m.id, score: m.score, metadata: m.metadata as Record<string, string> | undefined }));
    },
    async deleteByIds(ids) {
      for (let i = 0; i < ids.length; i += 1000) await index.deleteByIds(ids.slice(i, i + 1000));
    },
  };
}

const fakes = new Map<VectorKind, Map<string, VectorItem>>();

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function matchesFilter(item: VectorItem, filter: VectorQuery['filter']): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => {
    const actual = item.metadata?.[k];
    return typeof v === 'string' ? actual === v : actual !== undefined && v.$in.includes(actual);
  });
}

/** In-memory store for tests; shared per isolate and cleared by resetFakeVectors(). */
export function fakeVectorStore(kind: VectorKind): VectorStore {
  if (!fakes.has(kind)) fakes.set(kind, new Map());
  const items = fakes.get(kind)!;
  return {
    async upsert(list) {
      for (const v of list) items.set(v.id, { ...v, values: [...v.values] });
    },
    async query(vector, q) {
      return [...items.values()]
        .filter((v) => (q.namespace === undefined || v.namespace === q.namespace) && matchesFilter(v, q.filter))
        .map((v) => ({ id: v.id, score: cosine(vector, v.values), metadata: v.metadata }))
        .sort((a, b) => b.score - a.score)
        .slice(0, q.topK);
    },
    async deleteByIds(ids) {
      for (const id of ids) items.delete(id);
    },
  };
}

export function resetFakeVectors(): void {
  fakes.clear();
}

/** The store for `kind`, or undefined when the index is not bound (assets then wait for the ML job). */
export function vectorStore(env: Env, kind: VectorKind): VectorStore | undefined {
  if (env.TEST_FAKE_VECTORS === 'true') return fakeVectorStore(kind);
  const index = kind === 'clip' ? env.CLIP_INDEX : env.FACE_INDEX;
  return index ? vectorizeStore(index) : undefined;
}
