// team.mjs — logs in on YOUR machine and PRINTS the squad. Nothing to share back.
//
// It doesn't extract or replay any token. It just watches the API responses your
// own logged-in browser receives, captures the team data, prints the players, and
// saves a screenshot. Whatever the site can show you, this dumps to your terminal.
//
//   npm install && npx playwright install chromium
//   FIFA_EMAIL=... FIFA_PASSWORD=... TEAM_ID=436249 npm run team
//   # add LEAGUE_ID=187311 to also capture league standings

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

if (existsSync('.env')) for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] ??= m[2].replace(/^['"]|['"]$/g, '');
}
const EMAIL = process.env.FIFA_EMAIL, PASSWORD = process.env.FIFA_PASSWORD;
const TEAM_ID = process.env.TEAM_ID || '436249';
const LEAGUE_ID = process.env.LEAGUE_ID || '';
if (!EMAIL || !PASSWORD) { console.error('Set FIFA_EMAIL and FIFA_PASSWORD.'); process.exit(1); }

const CLIENT_ID = '0f435204-a1c9-4150-87e1-5d5a1e710982';
const AUTH_URL = `https://auth.fifa.com/as/authorize?response_type=code&client_id=${CLIENT_ID}` +
  `&redirect_uri=${encodeURIComponent('https://play.fifa.com/fantasy/')}&scope=${encodeURIComponent('openid profile email')}` +
  `&prompt=login&campaign=PlayZone_FantasyClassic-Web-FCWC25FantasyClassic`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch({ headless: process.env.HEADLESS === 'true',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
  viewport: { width: 1366, height: 940 }, locale: 'en-US',
  ignoreHTTPSErrors: process.env.INSECURE_TLS === 'true',
});
const page = await ctx.newPage();

// Capture the JSON the app actually receives. Whatever loads your team, we keep it.
const apiData = [];
page.on('response', async (res) => {
  try {
    const u = res.request().url();
    if (!/\/api\/.*fantasy|geniussports\.com|f2p\.media/.test(u)) return;
    if (!(res.headers()['content-type'] || '').includes('json')) return;
    const body = await res.text();
    if (res.status() === 200 && body.length > 2) apiData.push({ url: u.replace(/^https?:\/\/[^/]+/, ''), body });
  } catch {}
});

log('Logging in…');
await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
try { await page.click('#onetrust-accept-btn-handler', { timeout: 8000 }); } catch {}
await page.waitForSelector('#email', { timeout: 20000 });
await page.waitForTimeout(3500);
await page.fill('#email', EMAIL); await page.fill('#password', PASSWORD);
await Promise.all([
  page.waitForURL((u) => u.href.startsWith('https://play.fifa.com'), { timeout: 60000 }).catch(() => {}),
  page.click('button[type="submit"]').catch(() => page.keyboard.press('Enter')),
]);
await page.waitForTimeout(8000);
if (!page.url().startsWith('https://play.fifa.com')) {
  const err = await page.evaluate(() => [...document.querySelectorAll('[role="alert"],[class*="error" i]')].map(e => e.innerText.trim()).filter(Boolean));
  console.error('❌ Login failed:', JSON.stringify([...new Set(err)].slice(0, 3)));
  console.error('If it says "Access Restricted | <IP>" you are on a VPN/work network — use home wifi.');
  await browser.close(); process.exit(2);
}
log('Logged in. Loading your team…');

// Visit the pages that render the squad so the app fetches it. We don't rely on
// guessing the API path — we just let the app load it and grab whatever comes back.
const urls = [`https://play.fifa.com/fantasy/team/${TEAM_ID}`, 'https://play.fifa.com/fantasy/my-team',
  'https://play.fifa.com/fantasy', `https://play.fifa.com/fantasy/leagues/${LEAGUE_ID}`].filter(u => !u.endsWith('/'));
for (const u of urls) {
  try { await page.goto(u, { waitUntil: 'networkidle', timeout: 35000 }); await page.waitForTimeout(3500); } catch {}
}
await page.screenshot({ path: 'team.png', fullPage: true }).catch(() => {});

writeFileSync('team-api.json', JSON.stringify(apiData, null, 2));

// Best-effort: pull player-looking names out of whatever JSON we captured.
function findPlayers(obj, out = []) {
  if (Array.isArray(obj)) { for (const x of obj) findPlayers(x, out); return out; }
  if (obj && typeof obj === 'object') {
    const name = obj.webName || obj.shortName || obj.playerName || obj.fullName ||
      (obj.firstName && obj.lastName ? `${obj.firstName} ${obj.lastName}` : null) || obj.knownName || obj.displayName;
    const looksPlayer = name && (obj.position || obj.positionId || obj.teamId || obj.clubId || obj.skill || obj.value !== undefined || obj.price !== undefined);
    if (looksPlayer) out.push({ name, pos: obj.position || obj.positionName || obj.positionId, club: obj.teamName || obj.clubName || obj.squadName, pts: obj.points ?? obj.totalPoints, value: obj.value ?? obj.price });
    for (const v of Object.values(obj)) findPlayers(v, out);
  }
  return out;
}
const players = [];
for (const d of apiData) { try { findPlayers(JSON.parse(d.body), players); } catch {} }
const seen = new Set(), unique = players.filter(p => !seen.has(p.name) && seen.add(p.name));

console.log('\n================ RESULT ================');
console.log('Captured', apiData.length, 'API responses → saved to team-api.json');
console.log('Screenshot of the team page → team.png');
if (unique.length) {
  console.log(`\nPlayers found (${unique.length}):`);
  for (const p of unique) console.log(' •', [p.name, p.pos, p.club, p.pts != null ? p.pts + 'pts' : '', p.value != null ? p.value : ''].filter(Boolean).join('  '));
} else {
  console.log('\nNo players auto-parsed, but the raw data is in team-api.json and the squad is visible in team.png.');
  console.log('Endpoints captured:'); for (const d of apiData) console.log('   ', d.url, `(${d.body.length} bytes)`);
}
console.log('\nIf the players are NOT listed above, open team.png — you’ll see the squad there,');
console.log('and you can paste me the contents of team-api.json so I can format it.');
console.log('========================================');

await browser.close();
