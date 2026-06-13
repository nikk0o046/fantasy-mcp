// bootstrap.mjs — RUN THIS ON YOUR OWN COMPUTER (residential IP), not in a datacenter.
//
// It logs into FIFA once with a real browser (so Akamai allows it), captures the
// session, verifies it can read the target team, and prints a single blob you paste
// back into the chat. That blob is what powers the "how long does a session last?"
// measurement before we commit to the Cloud Run build.
//
// Usage:
//   npm install
//   npx playwright install chromium
//   FIFA_EMAIL='you@example.com' FIFA_PASSWORD='...' TEAM_ID=436249 node bootstrap.mjs
//
// (or put FIFA_EMAIL / FIFA_PASSWORD / TEAM_ID in a .env file — it's gitignored)

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// minimal .env loader (no dependency)
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '');
  }
}

const EMAIL = process.env.FIFA_EMAIL;
const PASSWORD = process.env.FIFA_PASSWORD;
const TEAM_ID = process.env.TEAM_ID || '436249';
const GW = process.env.GW || '1';
const HEADLESS = process.env.HEADLESS !== 'false';

if (!EMAIL || !PASSWORD) {
  console.error('ERROR: set FIFA_EMAIL and FIFA_PASSWORD (env vars or .env file).');
  process.exit(1);
}

const CLIENT_ID = '0f435204-a1c9-4150-87e1-5d5a1e710982';
const REDIRECT = 'https://play.fifa.com/fantasy/';
const AUTH_URL =
  `https://auth.fifa.com/as/authorize?response_type=code&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}&scope=${encodeURIComponent('openid profile email')}` +
  `&prompt=login&campaign=PlayZone_FantasyClassic-Web-FCWC25FantasyClassic`;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({
  headless: HEADLESS,
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 900 },
  locale: 'en-US',
  // Only for sandboxed/proxied test environments; leave unset on a normal machine.
  ignoreHTTPSErrors: process.env.INSECURE_TLS === 'true',
});
const page = await ctx.newPage();

log('Opening FIFA login…');
await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
try { await page.click('#onetrust-accept-btn-handler', { timeout: 8000 }); log('Accepted cookies.'); } catch {}

await page.waitForSelector('#email', { timeout: 20000 });
await page.waitForTimeout(3500); // let the device-verification script initialise
await page.fill('#email', EMAIL);
await page.fill('#password', PASSWORD);
log('Submitting credentials…');
await Promise.all([
  page.waitForURL((u) => u.href.startsWith('https://play.fifa.com'), { timeout: 60000 }).catch(() => {}),
  page.click('button[type="submit"]').catch(() => page.keyboard.press('Enter')),
]);
await page.waitForTimeout(8000);

const landed = page.url();
log('Landed on:', landed);
if (!landed.startsWith('https://play.fifa.com')) {
  const err = await page.evaluate(() =>
    [...document.querySelectorAll('[role="alert"],[class*="error" i]')].map(e => e.innerText.trim()).filter(Boolean)
  );
  console.error('\n❌ Login did not complete. Page said:', JSON.stringify([...new Set(err)].slice(0, 4)));
  console.error('If this says "Access Restricted | <IP>", you are on a datacenter/VPN IP — run on a normal connection.');
  await browser.close();
  process.exit(2);
}

// Verify we can actually read the team, from the play.fifa.com origin (cookies auto-sent).
log('Verifying team access…');
const verify = await page.evaluate(async ({ teamId, gw }) => {
  const get = async (u) => {
    try { const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
      return { url: u, status: r.status, body: (await r.text()).slice(0, 400) }; }
    catch (e) { return { url: u, error: String(e) }; }
  };
  return {
    team: await get(`/api/en/fantasy/team/${teamId}`),
    teamGw: await get(`/api/en/fantasy/team/${teamId}/${gw}`),
    profile: await get(`/api/en/fantasy/profile`),
  };
}, { teamId: TEAM_ID, gw: GW });

console.log('\n===== VERIFY =====');
console.log(JSON.stringify(verify, null, 2));

// Capture full session (all cookies across play.fifa.com + auth.fifa.com).
const state = await ctx.storageState();
writeFileSync('session.json', JSON.stringify(state, null, 2));

// Compact blob: only the cookies, base64'd, for easy paste into chat.
const blob = Buffer.from(JSON.stringify({
  capturedAt: new Date().toISOString(),
  teamId: TEAM_ID,
  cookies: state.cookies.map(({ name, value, domain, path, expires, httpOnly, secure }) =>
    ({ name, value, domain, path, expires, httpOnly, secure })),
})).toString('base64');
writeFileSync('session.b64', blob);

const ok = verify.team.status === 200;
console.log('\n===== RESULT =====');
console.log(ok ? '✅ Session works and CAN read the team.' : '⚠️  Logged in but team read returned ' + verify.team.status + ' (check TEAM_ID).');
console.log('\nSaved: session.json (full) + session.b64 (paste-friendly).');
console.log('\n👉 Paste the ENTIRE line below back into the chat:\n');
console.log('SESSION_B64:' + blob);

await browser.close();
