/**
 * Provider-agnostic embeddings client: OpenAI or Voyage via plain fetch,
 * plus a built-in keyless "hash" provider (the default when no API key is
 * set). Used by KB sync (indexing) and retrieveContext (query time). Vector
 * dimension is validated on every response — a mismatched vector would
 * silently corrupt the pgvector index.
 *
 * The hash provider is feature-hashed lexical embedding: word unigrams +
 * bigrams signed-hashed into an L2-normalised vector. Cosine similarity
 * then behaves like weighted term overlap — solid retrieval for company
 * documents full of domain terms, zero external dependencies. Index and
 * query vectors must come from the SAME provider; the sync cron re-indexes
 * everything when the configured embedder changes.
 */
import { cfg } from "@/lib/config";

/** True when RAG can run: the keyless hash provider, or a configured key. */
export function embeddingsAvailable(): boolean {
  return cfg.embeddingsProvider === "hash" || cfg.embeddingsApiKey !== "";
}

/** Identity string stored with the index — a change forces a full re-sync. */
export function embedderId(): string {
  const p = cfg.embeddingsProvider;
  return p === "hash"
    ? `hash:${cfg.embeddingsDim}`
    : `${p}:${cfg.embeddingsModel}:${cfg.embeddingsDim}`;
}

// ── keyless hash embeddings ───────────────────────────────────────────────
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashEmbed(text: string): number[] {
  const dim = cfg.embeddingsDim;
  const v = new Float64Array(dim);
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1);
  const add = (token: string, weight: number) => {
    const h = fnv1a(token);
    v[h % dim] += ((h >>> 15) & 1 ? 1 : -1) * weight;
  };
  for (let i = 0; i < words.length; i++) {
    add(words[i], 1);
    // Bigrams carry the phrase-level meaning ("power supply", "bis
    // certification") that single words lose.
    if (i + 1 < words.length) add(`${words[i]}_${words[i + 1]}`, 1.5);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  const out = new Array<number>(dim);
  for (let i = 0; i < dim; i++) out[i] = norm ? v[i] / norm : 0;
  return out;
}

/** Max inputs per provider request; both providers accept batches this size. */
const BATCH_SIZE = 96;

interface EmbeddingsResponse {
  data?: { embedding: number[]; index?: number }[];
}

/** Embed texts (batched internally). Throws on HTTP/provider/dimension errors. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (cfg.embeddingsProvider === "hash") return texts.map(hashEmbed);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    out.push(...(await embedBatch(texts.slice(i, i + BATCH_SIZE))));
  }
  return out;
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const provider = cfg.embeddingsProvider;
  let url: string;
  if (provider === "openai") {
    url = "https://api.openai.com/v1/embeddings";
  } else if (provider === "voyage") {
    url = "https://api.voyageai.com/v1/embeddings";
  } else {
    throw new Error(
      `unknown EMBEDDINGS_PROVIDER "${provider}" (expected "openai" or "voyage")`,
    );
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.embeddingsApiKey}`,
    },
    body: JSON.stringify({ model: cfg.embeddingsModel, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${provider} embeddings failed: HTTP ${res.status} ${body.slice(0, 300)}`,
    );
  }

  const json = (await res.json()) as EmbeddingsResponse;
  const rows = [...(json.data ?? [])].sort(
    (a, b) => (a.index ?? 0) - (b.index ?? 0),
  );
  if (rows.length !== texts.length) {
    throw new Error(
      `${provider} embeddings returned ${rows.length} vectors for ${texts.length} inputs`,
    );
  }
  for (const row of rows) {
    if (!Array.isArray(row.embedding) || row.embedding.length !== cfg.embeddingsDim) {
      throw new Error(
        `${provider} embedding dimension ${row.embedding?.length ?? "?"} != ` +
          `EMBEDDINGS_DIM ${cfg.embeddingsDim} (model ${cfg.embeddingsModel})`,
      );
    }
  }
  return rows.map((r) => r.embedding);
}
