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

// Diagnostic capture: record EVERY Fantasy/Genius API call the app makes — its
// status and exactly what auth it carries — so we can see how a working request is
// authenticated (bearer? cookie? custom header?) instead of guessing.
const captured = { authorization: null, extraHeaders: {}, sampleUrl: null };
const apiLog = [];
const isApi = (u) => /\/api\/|geniussports\.com|f2p\.media/.test(u);
const xOf = (h) => Object.fromEntries(Object.entries(h).filter(([k]) => /^x-|entity|tenant|api-key|client/i.test(k)));
page.on('response', async (res) => {
  try {
    const req = res.request();
    const u = req.url();
    if (!isApi(u)) return;
    const h = req.headers();
    const status = res.status();
    apiLog.push({
      method: req.method(),
      path: u.replace(/^https?:\/\/[^/]+/, '').slice(0, 90),
      status,
      auth: h['authorization'] ? h['authorization'].slice(0, 16) + '…' : null,
      cookieSent: !!h['cookie'],
      x: xOf(h),
    });
    // Prefer the auth from a SUCCESSFUL call.
    if (h['authorization'] && (!captured.authorization || status === 200)) {
      captured.authorization = h['authorization'];
      captured.extraHeaders = xOf(h);
      captured.sampleUrl = u;
    }
  } catch {}
});

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

// Let the SPA finish the OAuth code-exchange and load the dashboard ON ITS OWN.
// (Hard-navigating away can abort the exchange, so we just wait and observe.)
log('Letting the app load and fire its API calls…');
await page.waitForTimeout(10000);
// One gentle in-app nudge: click a nav link to the team/squad if present.
for (const sel of ['a[href*="team" i]', 'a[href*="squad" i]', 'a[href*="fantasy" i]']) {
  try { const el = await page.$(sel); if (el) { await el.click({ timeout: 3000 }); break; } } catch {}
}
await page.waitForTimeout(8000);

// Dump the page's full localStorage + sessionStorage (the token may live in either).
const webStorage = await page.evaluate(() => {
  const grab = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = String(s.getItem(k)).slice(0, 1200); } return o; };
  return { origin: location.origin, localStorage: grab(localStorage), sessionStorage: grab(sessionStorage) };
});

// Try the token endpoint directly from the logged-in page (cookies auto-attached).
const tokenProbe = await page.evaluate(async () => {
  const get = async (u) => { try { const r = await fetch(u, { credentials: 'include', headers: { accept: 'application/json' } });
    return { status: r.status, body: (await r.text()).slice(0, 300) }; } catch (e) { return { error: String(e) }; } };
  return { userToken: await get('/api/en/user/token'), profile: await get('/api/en/fantasy/profile') };
});

const state = await ctx.storageState();
writeFileSync('session.json', JSON.stringify(state, null, 2));

const blob = Buffer.from(JSON.stringify({
  capturedAt: new Date().toISOString(),
  teamId: TEAM_ID,
  landed,
  authorization: captured.authorization,
  extraHeaders: captured.extraHeaders,
  sampleUrl: captured.sampleUrl,
  apiLog,
  tokenProbe,
  webStorage,
  cookies: state.cookies.map(({ name, value, domain, path, expires, httpOnly, secure }) =>
    ({ name, value, domain, path, expires, httpOnly, secure })),
})).toString('base64');
writeFileSync('session.b64', blob);

console.log('\n===== DIAGNOSTIC CAPTURE =====');
console.log('Final URL:', page.url());
console.log('Authorization seen on any API call:', captured.authorization ? captured.authorization.slice(0, 25) + '…' : 'NONE');
console.log('\nAPI calls the app made:');
console.table(apiLog.map(({ method, path, status, auth, cookieSent }) => ({ method, path, status, auth, cookieSent })));
console.log('\n/api/en/user/token probe:', JSON.stringify(tokenProbe.userToken));
console.log('localStorage keys:', Object.keys(webStorage.localStorage));
console.log('sessionStorage keys:', Object.keys(webStorage.sessionStorage));
console.log('\n👉 Paste the ENTIRE line below back into the chat:\n');
console.log('SESSION_B64:' + blob);

await browser.close();
