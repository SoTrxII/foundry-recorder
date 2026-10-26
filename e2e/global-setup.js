const { chromium } = require('@playwright/test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { FOUNDRY, API, ENDPOINT, RID, join } = require('./foundry');

const E2E = __dirname;
const WORLD = 'e2e';
const SYSTEM = 'worldbuilding';
const SYSTEM_MANIFEST = 'https://raw.githubusercontent.com/foundryvtt/worldbuilding/master/system.json';
// The foundryvtt.com account that downloads Foundry and fetches its licence,
// and the setup screen's admin password
const SECRETS = process.env.FOUNDRY_SECRETS ?? path.join(os.homedir(), '.foundry', 'config.json');
// Every `docker compose` call needs it, `exec` and `down` included (teardown)
process.env.FOUNDRY_SECRETS = SECRETS;

const run = (cmd, args, opt = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: E2E, ...opt });
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const inFoundry = (...args) => {
  try {
    execFileSync('docker', ['compose', 'exec', '-T', 'foundry', ...args], { cwd: E2E, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

async function waitFor(what, seconds, check) {
  for (let i = 0; i < seconds; i += 1) {
    try {
      if (await check()) return;
    } catch { /* not up yet */ }
    await sleep(1000);
  }
  throw new Error(`${what} did not come up within ${seconds}s (docker compose logs)`);
}

// Foundry's own setup calls, as its setup screen makes them, with its admin cookie
async function setup(page, route, body) {
  const res = await page.evaluate(async ([r, b]) => (await fetch(r, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  })).json(), [route, body]);
  if (res.error) throw new Error(`${body.action}: ${res.error}`);
  return res;
}

// A licensed Foundry with a world to play in: the licence agreement, a game
// system and the world, each done once and kept in the volume
async function prepareServer(browser) {
  const { foundry_admin_key: adminKey } = JSON.parse(fs.readFileSync(SECRETS, 'utf8'));
  const page = await browser.newPage();
  await page.goto(FOUNDRY);
  if (page.url().endsWith('/license')) {
    await page.check('#eula-agree');
    await page.click('#sign');
    await page.waitForURL('**/auth');
  }
  if (page.url().endsWith('/auth')) {
    await page.fill('input[name=adminPassword]', adminKey);
    await page.click('button[type=submit]');
    await page.waitForURL('**/setup');
  }
  if (page.url().endsWith('/setup')) {
    if (!inFoundry('test', '-d', `/data/Data/systems/${SYSTEM}`)) {
      await setup(page, '/setup', { action: 'installPackage', type: 'system', id: SYSTEM, manifest: SYSTEM_MANIFEST });
      // Answered at once, installed in the background
      await waitFor('the game system', 120, () => inFoundry('test', '-f', `/data/Data/systems/${SYSTEM}/system.json`));
    }
    if (!inFoundry('test', '-d', `/data/Data/worlds/${WORLD}`)) {
      await setup(page, '/create', { action: 'createWorld', id: WORLD, title: 'Marduk e2e', system: SYSTEM });
    }
    await setup(page, '/setup', { action: 'launchWorld', world: WORLD });
    await waitFor('the world', 60, async () => (await fetch(`${FOUNDRY}/join`)).ok);
  }
  await page.close();
}

// The module enabled, pointed at the stack, and what the tests play with:
// a playlist holding the tone, an active scene, a co-GM
async function prepareWorld(browser) {
  let gm = await join(browser, 'Gamemaster');
  if (!(await gm.evaluate(() => game.modules.get('marduk-recorder')?.active))) {
    await gm.evaluate(() => game.settings.set('core', 'moduleConfiguration', {
      ...game.settings.get('core', 'moduleConfiguration'), 'marduk-recorder': true,
    }));
    await gm.context().close();
    gm = await join(browser, 'Gamemaster');
  }
  await gm.evaluate(async ([endpoint, key]) => {
    await game.settings.set('marduk-recorder', 'endpoint', endpoint);
    await game.settings.set('marduk-recorder', 'key', key);
    if (!game.users.getName('Co-GM')) await User.create({ name: 'Co-GM', role: CONST.USER_ROLES.GAMEMASTER });
    // A soundboard: a sound plays once and stops. In the default mode the
    // playlist starts over at its end, and the tone would never stop
    const playlist = game.playlists.getName('e2e') ?? await Playlist.create({ name: 'e2e', sounds: [{ name: 'tone', path: 'e2e/tone.ogg' }] });
    await playlist.update({ mode: CONST.PLAYLIST_MODES.DISABLED });
    // A sound still marked playing by an interrupted run is resumed by every
    // client that joins, before the test plays anything
    await playlist.stopAll();
    if (!game.scenes.getName('e2e')) await Scene.create({ name: 'e2e', active: true });
  }, [ENDPOINT, RID]);
  await gm.context().close();
}

module.exports = async () => {
  if (!fs.existsSync(SECRETS)) {
    throw new Error(`Foundry account credentials expected in ${SECRETS}: {"foundry_username", "foundry_password", "foundry_admin_key"} (or set FOUNDRY_SECRETS)`);
  }
  fs.rmSync(path.join(E2E, '.out'), { recursive: true, force: true });
  fs.mkdirSync(path.join(E2E, '.out'));
  fs.mkdirSync(path.join(E2E, '.build'), { recursive: true });

  // The "jukebox track": a 4s 440 Hz tone, easy to find again in the recording
  run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-ar', '48000', '-ac', '2', '-c:a', 'libvorbis', path.join(E2E, '.build', 'tone.ogg')]);

  run('docker', ['compose', 'up', '-d']);
  // Answering /v1/time means the app is up, and it only starts once its sidecar is
  await waitFor('roll20-audio-sync', 60, async () => (await fetch(`${API}/v1/time`)).ok);
  // The first run downloads Foundry (~200 MB)
  await waitFor('Foundry', 600, async () => (await fetch(FOUNDRY)).status < 500);
  // The module and the tone, mounted outside /data (see docker-compose.yml).
  // The links stay in the volume, so a later start finds the module at once
  if (!inFoundry('sh', '-c', 'ln -sfn /mnt/marduk-recorder /data/Data/modules/marduk-recorder && ln -sfn /mnt/e2e /data/Data/e2e')) {
    throw new Error('could not link the module into Foundry\'s data');
  }

  const browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome' });
  try {
    await prepareServer(browser);
    await prepareWorld(browser);
  } finally {
    await browser.close();
  }
};
