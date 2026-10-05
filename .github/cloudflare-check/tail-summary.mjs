// Turns `wrangler tail --format json` output into one line per event, without
// login tokens or game ids. Usage: node tail-summary.mjs <file>

import { readFileSync } from 'node:fs';

const file = process.argv[2];
const text = readFileSync(file, 'utf8');
const events = [];
let block = null;
for (const line of text.split('\n')) {
  if (block === null && line.startsWith('{')) {
    try {
      events.push(JSON.parse(line));
      continue;
    } catch {
      block = [line];
      continue;
    }
  }
  if (block !== null) {
    block.push(line);
    if (line === '}') {
      try {
        events.push(JSON.parse(block.join('\n')));
      } catch {
        // not an event
      }
      block = null;
    }
  }
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '?';
  }
}

function kind(event) {
  const e = event.event;
  if (e == null) return 'none';
  if (e.request) {
    const path = pathOf(e.request.url).replace(/^\/api\/games\/[^/]+/, '/api/games/<game>');
    const asset = !path.startsWith('/api/');
    return `fetch ${e.request.method} ${asset ? '<page or picture>' : path} -> ${e.response?.status ?? '?'}`;
  }
  if (e.cron) return `cron ${e.cron}`;
  if (e.scheduledTime !== undefined) return 'alarm';
  if (e.getWebSocketEvent) return `websocket ${e.getWebSocketEvent.webSocketEventType}`;
  if (e.rpcMethod) return `rpc ${e.rpcMethod}`;
  return `other ${Object.keys(e).join(',')}`;
}

console.log(`${file.split('/').at(-1)}: ${events.length} events`);
for (const event of events) {
  const at = new Date(event.eventTimestamp ?? 0).toISOString();
  const exceptions = (event.exceptions ?? []).map((x) => x.name).join(',');
  console.log(
    ['  ', at, event.scriptName, event.entrypoint ?? '-', event.executionModel ?? '-', event.outcome, kind(event), `logs ${(event.logs ?? []).length}`, exceptions && `exceptions ${exceptions}`]
      .filter(Boolean)
      .join('  '),
  );
}
