// A read-only look at the Durable Objects behind the live and preview sites.
// It only sends GET requests and GraphQL queries; it changes nothing.
//
// The repository is public, so this prints counts and times only: no account
// id, no full object ids (the first 8 characters, to tell objects apart), and
// nothing about Workers that are not this game's.

const token = process.env.CF_TOKEN;
const account = process.env.CF_ACCOUNT;
const API = 'https://api.cloudflare.com/client/v4';
const SCRIPTS = ['adventure', 'adventure-preview'];

const say = (...parts) => console.log(parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '));
const short = (id) => (typeof id === 'string' ? id.slice(0, 8) : id);

async function get(path) {
  const response = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function graphql(query) {
  const response = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

const errors = (body) => (body?.errors ?? []).map((e) => e.message ?? e);

// ---- 1. The game's Durable Object namespaces ---------------------------------

say(`checked at ${new Date().toISOString()}`);
const namespaces = await get(`/accounts/${account}/workers/durable_objects/namespaces?per_page=100`);
say('## namespaces: HTTP', namespaces.status, errors(namespaces.body));
const ours = (namespaces.body?.result ?? []).filter((ns) => SCRIPTS.includes(ns.script));
for (const ns of ours) say('namespace', ns.name, 'id', short(ns.id), 'sqlite', ns.use_sqlite);

// ---- 2. The objects in each ---------------------------------------------------

const objects = new Map(); // namespace id -> [{id, hasStoredData}]
for (const ns of ours) {
  const all = [];
  let cursor = null;
  let pages = 0;
  do {
    const query = `limit=10000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const page = await get(`/accounts/${account}/workers/durable_objects/namespaces/${ns.id}/objects?${query}`);
    pages += 1;
    if (!page.body?.success) {
      say('## objects in', ns.name, 'failed: HTTP', page.status, errors(page.body));
      break;
    }
    all.push(...page.body.result);
    cursor = page.body.result_info?.cursor || null;
  } while (cursor && pages < 50);
  objects.set(ns.id, all);
  say(`## objects in ${ns.name}: ${all.length} listed, ${all.filter((o) => o.hasStoredData).length} with stored data`);
  for (const o of all) say('  object', short(o.id), 'stored data', o.hasStoredData);
}

// ---- 3. Analytics -------------------------------------------------------------

function unwrap(type) {
  let t = type;
  while (t && !t.name) t = t.ofType;
  return t ? { typeName: t.name, kind: t.kind } : { typeName: null, kind: null };
}
const TYPE_REF = 'type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }';

async function fieldsOf(typeName) {
  const result = await graphql(`{ __type(name: "${typeName}") { fields { name ${TYPE_REF} args { name ${TYPE_REF} } } inputFields { name ${TYPE_REF} } } }`);
  const type = result.body?.data?.__type;
  if (!type) return { fields: [], inputFields: [], errors: errors(result.body), status: result.status };
  return {
    fields: (type.fields ?? []).map((f) => ({ name: f.name, ...unwrap(f.type), args: (f.args ?? []).map((a) => ({ name: a.name, ...unwrap(a.type) })) })),
    inputFields: (type.inputFields ?? []).map((f) => ({ name: f.name, ...unwrap(f.type) })),
  };
}

const accountType = await fieldsOf('account');
say('## analytics schema:', accountType.fields.length > 0 ? 'read' : `not readable ${JSON.stringify(accountType.errors)} HTTP ${accountType.status}`);
const datasets = accountType.fields.filter((f) => /^(durableObjects|workersInvocations)/.test(f.name));
say('## datasets', datasets.map((d) => d.name));

const WANTED_DIMENSIONS = ['scriptName', 'namespaceId', 'objectId', 'datetimeHour', 'date', 'status'];
const ANALYTICS = ['durableObjectsInvocationsAdaptiveGroups', 'durableObjectsPeriodicGroups', 'durableObjectsStorageGroups', 'workersInvocationsAdaptive'];
const analytics = {};

for (const name of ANALYTICS) {
  const dataset = datasets.find((d) => d.name === name);
  if (!dataset) {
    say(`## ${name}: not in the schema`);
    continue;
  }
  const own = await fieldsOf(dataset.typeName);
  const parts = [];
  for (const group of own.fields) {
    if (group.kind === 'OBJECT') {
      const sub = await fieldsOf(group.typeName);
      let wanted = sub.fields.filter((f) => f.kind === 'SCALAR' || f.kind === 'ENUM').map((f) => f.name);
      say(`   ${name}.${group.name}:`, wanted);
      if (group.name === 'dimensions') {
        wanted = wanted.filter((f) => WANTED_DIMENSIONS.includes(f));
        if (wanted.includes('datetimeHour')) wanted = wanted.filter((f) => f !== 'date');
      }
      if (['dimensions', 'sum', 'max'].includes(group.name) && wanted.length > 0) parts.push(`${group.name} { ${wanted.join(' ')} }`);
    } else if (group.name === 'count') {
      parts.push('count');
    }
  }
  const filterArg = dataset.args.find((a) => a.name === 'filter');
  const filter = filterArg ? await fieldsOf(filterArg.typeName) : { inputFields: [] };
  const filterKeys = filter.inputFields.map((f) => f.name);
  const key = ['datetime_geq', 'datetimeHour_geq', 'date_geq'].find((k) => filterKeys.includes(k));
  if (!key || parts.length === 0) {
    say(`## ${name}: no usable filter or fields`, filterKeys.filter((k) => /date|time/i.test(k)));
    continue;
  }
  for (const days of [31, 14, 7, 3, 1]) {
    const since = new Date(Date.now() - days * 86400_000);
    const value = key === 'date_geq' ? since.toISOString().slice(0, 10) : since.toISOString().replace(/\.\d+Z$/, 'Z');
    const query = `{ viewer { accounts(filter: {accountTag: "${account}"}) { ${name}(limit: 10000, filter: {${key}: "${value}"}) { ${parts.join(' ')} } } } }`;
    const result = await graphql(query);
    const rows = result.body?.data?.viewer?.accounts?.[0]?.[name];
    if (rows) {
      analytics[name] = { days, rows };
      say(`## ${name}: read the last ${days} days, ${rows.length} rows${rows.length >= 10000 ? ' (the most one query returns, so some are missing)' : ''}`);
      break;
    }
    say(`## ${name}: the last ${days} days failed: HTTP ${result.status}`, errors(result.body));
  }
}

// ---- 4. Putting it together ---------------------------------------------------

const nsById = new Map(ours.map((ns) => [ns.id, ns]));
const ourRow = (row) => {
  const d = row.dimensions ?? {};
  if (d.namespaceId !== undefined) return nsById.has(d.namespaceId);
  if (d.scriptName !== undefined) return SCRIPTS.includes(d.scriptName);
  return true;
};
const when = (row) => row.dimensions?.datetimeHour ?? row.dimensions?.date ?? '?';
const where = (row) => nsById.get(row.dimensions?.namespaceId)?.name ?? row.dimensions?.scriptName ?? '';

const invocations = (analytics.durableObjectsInvocationsAdaptiveGroups?.rows ?? []).filter(ourRow);
say('## Durable Object requests by hour and namespace, newest first');
const byHour = new Map();
for (const row of invocations) {
  const k = `${when(row)} ${where(row)}`;
  const entry = byHour.get(k) ?? { requests: 0, objects: new Set() };
  entry.requests += row.sum?.requests ?? 0;
  if (row.dimensions?.objectId) entry.objects.add(row.dimensions.objectId);
  byHour.set(k, entry);
}
for (const [k, v] of [...byHour.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) say('  ', k, 'requests', v.requests, 'objects', v.objects.size);

say('## each listed object: stored data, requests seen, first and last hour seen');
for (const ns of ours) {
  for (const o of objects.get(ns.id) ?? []) {
    const rows = invocations.filter((r) => r.dimensions?.objectId === o.id);
    const hours = rows.map(when).sort();
    say('  ', ns.name, short(o.id), 'stored', o.hasStoredData, 'requests', rows.reduce((s, r) => s + (r.sum?.requests ?? 0), 0), 'first', hours[0] ?? '-', 'last', hours.at(-1) ?? '-');
  }
}
const unlisted = new Set(invocations.map((r) => r.dimensions?.objectId).filter((id) => id && ![...objects.values()].flat().some((o) => o.id === id)));
say('## objects with requests but not listed:', [...unlisted].map(short));

for (const name of ['durableObjectsPeriodicGroups', 'durableObjectsStorageGroups', 'workersInvocationsAdaptive']) {
  const value = analytics[name];
  if (!value) continue;
  say(`## ${name} (last ${value.days} days), newest first`);
  const rows = value.rows.filter(ourRow).sort((a, b) => (when(a) < when(b) ? 1 : -1));
  for (const row of rows) {
    const d = { ...row.dimensions };
    if (d.namespaceId) d.namespaceId = where(row);
    if (d.objectId) d.objectId = short(d.objectId);
    say('  ', d, row.count === undefined ? '' : `count ${row.count}`, row.sum ? { sum: row.sum } : '', row.max ? { max: row.max } : '');
  }
}
