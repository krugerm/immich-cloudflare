// Compares /sync/stream output from the reference Immich (Task 1) and this Worker for the same uploads.
// Usage: REF=http://127.0.0.1:2290/api REF_TOKEN=... OURS=http://localhost:8787/api OURS_TOKEN=... node scripts/golden-sync.mjs [--values]
// Default mode compares key presence and value types per entity type. --values also diffs scalar values.
const types = ['AuthUsersV2', 'UsersV1', 'AssetsV2', 'AssetExifsV1'];
const valuesMode = process.argv.includes('--values');

const missing = ['REF', 'REF_TOKEN', 'OURS', 'OURS_TOKEN'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`missing environment variables: ${missing.join(', ')}`);
  process.exit(2);
}

async function stream(base, token) {
  const r = await fetch(`${base}/sync/stream`, {
    method: 'POST',
    headers: { 'x-immich-user-token': token, 'content-type': 'application/json', accept: 'application/jsonlines+json' },
    body: JSON.stringify({ types, reset: true }),
  });
  const text = await r.text();
  if (!r.ok) {
    console.error(`${base}/sync/stream failed: ${r.status} ${text}`);
    process.exit(2);
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

const shape = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

function describe(lines) {
  const byType = new Map();
  for (const l of lines) {
    const keys = Object.fromEntries(Object.entries(l.data).map(([k, v]) => [k, shape(v)]));
    byType.set(l.type, { count: (byType.get(l.type)?.count ?? 0) + 1, keys: { ...(byType.get(l.type)?.keys ?? {}), ...keys } });
  }
  return byType;
}

// Fields that legitimately differ between two servers holding the same files.
const IGNORED = /(^|\.)(id|assetId|ownerId|checksum|createdAt|updatedAt|fileCreatedAt|fileModifiedAt|deletedAt|profileChangedAt|email|name)$|Id$/;
const sortKey = (l) => (l.data.originalFileName ?? l.data.email ?? l.data.assetId ?? '');

/** Key the exif rows by the file name of their asset so the two servers line up. */
function scalarsByEntity(lines) {
  const names = new Map(lines.filter((l) => l.type === 'AssetV2').map((l) => [l.data.id, l.data.originalFileName]));
  const out = new Map();
  for (const l of lines) {
    const label = l.type === 'AssetExifV1' ? `${l.type}[${names.get(l.data.assetId) ?? '?'}]` : `${l.type}[${sortKey(l)}]`;
    const scalars = {};
    for (const [k, v] of Object.entries(l.data)) if (!IGNORED.test(k)) scalars[k] = v;
    out.set(label, scalars);
  }
  return out;
}

const refLines = await stream(process.env.REF, process.env.REF_TOKEN);
const oursLines = await stream(process.env.OURS, process.env.OURS_TOKEN);
const ref = describe(refLines);
const ours = describe(oursLines);
let failed = false;
for (const [type, r] of ref) {
  const o = ours.get(type);
  if (!o) { console.log(`MISSING type ${type}`); failed = true; continue; }
  for (const [k, s] of Object.entries(r.keys)) {
    if (!(k in o.keys)) { console.log(`${type}.${k}: missing (reference ${s})`); failed = true; }
    else if (o.keys[k] !== s && o.keys[k] !== 'null' && s !== 'null') { console.log(`${type}.${k}: ${o.keys[k]} vs reference ${s}`); failed = true; }
  }
}
for (const type of ours.keys()) if (!ref.has(type)) console.log(`extra type ${type} (reference has none)`);

if (valuesMode) {
  const r = scalarsByEntity(refLines);
  const o = scalarsByEntity(oursLines);
  for (const [label, rs] of r) {
    const os = o.get(label);
    if (!os) { console.log(`${label}: only in reference`); failed = true; continue; }
    for (const k of new Set([...Object.keys(rs), ...Object.keys(os)])) {
      if (JSON.stringify(rs[k]) !== JSON.stringify(os[k])) {
        console.log(`${label}.${k}: ours ${JSON.stringify(os[k])} vs reference ${JSON.stringify(rs[k])}`);
        failed = true;
      }
    }
  }
  for (const label of o.keys()) if (!r.has(label)) { console.log(`${label}: only in ours`); failed = true; }
}
console.log(failed ? 'GOLDEN SYNC: DIFFERENCES' : 'GOLDEN SYNC: MATCH');
process.exit(failed ? 1 : 0);
