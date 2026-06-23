// measure.mjs — runs from ANYWHERE (incl. this datacenter sandbox).
//
// Takes the SESSION_B64 blob produced by bootstrap.mjs and probes the FIFA data API
// to answer the only question that matters before we build: how long does a session
// stay valid, and does it silently renew?
//
// Usage:
//   SESSION_B64='<the blob>' node measure.mjs
// or
//   node measure.mjs "<the blob>"
//
// Run it repeatedly over hours/days (e.g. via cron). Each run appends one line to
// measure.log with a timestamp + HTTP status so we can see exactly when it dies.

import { appendFileSync } from 'node:fs';

let blob = process.env.SESSION_B64 || process.argv[2] || '';
blob = blob.replace(/^SESSION_B64:/, '').trim();
if (!blob) { console.error('Provide SESSION_B64 (env var or arg).'); process.exit(1); }

const data = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
const teamId = data.teamId || '436249';

// Build a Cookie header from the play.fifa.com cookies.
const cookieHeader = data.cookies
  .filter(c => /(^|\.)fifa\.com$/.test(c.domain) || c.domain.includes('play.fifa.com'))
  .map(c => `${c.name}=${c.value}`)
  .join('; ');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

async function call(path) {
  const headers = { accept: 'application/json', cookie: cookieHeader, 'user-agent': UA, ...(data.extraHeaders || {}) };
  if (data.authorization) headers.authorization = data.authorization;
  const r = await fetch(`https://play.fifa.com${path}`, { headers });
  const body = await r.text();
  return { status: r.status, ok: r.status === 200, sample: body.slice(0, 120).replace(/\s+/g, ' ') };
}

const endpoints = [
  `/api/en/fantasy/team/${teamId}`,
  `/api/en/fantasy/team/${teamId}/1`,
  `/api/en/fantasy/profile`,
  `/api/en/user/token`, // does hitting this renew the session?
];

const results = {};
for (const ep of endpoints) {
  try { results[ep] = await call(ep); } catch (e) { results[ep] = { error: String(e) }; }
}

const ageH = ((Date.now() - new Date(data.capturedAt).getTime()) / 3.6e6).toFixed(1);
const teamOk = results[`/api/en/fantasy/team/${teamId}`]?.ok;
const line = `${new Date().toISOString()} age=${ageH}h team=${teamOk ? 'OK' : 'DEAD'} ` +
  endpoints.map(e => `${e.split('/').pop()}:${results[e]?.status ?? results[e]?.error}`).join(' ');

console.log(line);
console.log(JSON.stringify(results, null, 2));
appendFileSync('measure.log', line + '\n');
