#!/usr/bin/env node
// Keep the executable immutable while concurrent tests fork/exec. Each test's
// mutable native evidence and call log live in its isolated CODEX_HOME.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const dir = process.env.CODEX_HOME;
if (!dir) throw new Error('The native fixture needs its isolated CODEX_HOME');

const send = (id, result) => {
  process.stdout.write(JSON.stringify({ id, result }) + '\n');
};
const fail = (id, code, message) => {
  process.stdout.write(JSON.stringify({ id, error: { code, message } }) + '\n');
};

readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  const params = request.params || {};
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'native.json')));
  fs.appendFileSync(path.join(dir, 'calls'), JSON.stringify({
    method: request.method,
    pid: process.pid,
    includeTurns: params.includeTurns,
  }) + '\n');

  if (request.method === 'initialized') return;
  process.stdout.write(JSON.stringify({ method: 'history/fixture', params: {} }) + '\n');

  switch (request.method) {
    case 'initialize':
      return send(request.id, { codexHome: dir });
    case 'thread/list': {
      if (params.sourceKinds.length !== 10 ||
          !params.sourceKinds.includes('subAgentThreadSpawn') ||
          params.sortKey !== 'created_at' ||
          !Array.isArray(params.modelProviders) || params.modelProviders.length !== 0) {
        return fail(request.id, -32602, 'incomplete enumeration');
      }
      const start = data.paginateThreads ? Number(params.cursor || 0) : 0;
      const end = data.paginateThreads
        ? Math.min(start + params.limit, data.threads.length)
        : data.threads.length;
      const done = () => send(request.id, {
        data: data.threads.slice(start, end),
        nextCursor: end < data.threads.length ? String(end) : null,
      });
      if (fs.existsSync(path.join(dir, 'block'))) setTimeout(done, 2000);
      else done();
      return;
    }
    case 'thread/read': {
      const thread = data.threads.find(thread => thread.id === params.threadId);
      if (!thread) return fail(request.id, -32600, 'no rollout found');
      return send(request.id, {
        thread: { ...thread, turns: params.includeTurns ? data.turns : [] },
      });
    }
    case 'thread/turns/list':
      if (data.unsupportedTurns) return fail(request.id, -32601, 'unsupported');
      if (params.itemsView !== 'full' || params.sortDirection !== 'asc') {
        return fail(request.id, -32602, 'summary would lose evidence');
      }
      return send(request.id, { data: data.turns, nextCursor: null });
    case 'thread/items/list': {
      if (data.failItems) return fail(request.id, -32600, 'no rollout found');
      if (params.sortDirection !== 'asc') {
        return fail(request.id, -32602, 'unexpected item order');
      }
      const items = data.turns.flatMap(turn =>
        turn.items.map(item => ({ turnId: turn.id, item })));
      const start = Number(params.cursor || 0);
      const end = Math.min(start + params.limit, items.length);
      return send(request.id, {
        data: items.slice(start, end),
        nextCursor: end < items.length ? String(end) : null,
      });
    }
    default:
      return fail(request.id, -32601, 'unknown method');
  }
});
