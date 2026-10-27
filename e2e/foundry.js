// What the tests and the setup share: the stack's addresses and joining the world
const FOUNDRY = 'http://localhost:30000';
const API = 'http://127.0.0.1:8095';
// What the module calls from Foundry's page: the CORS proxy in front of API
const ENDPOINT = 'http://localhost:8096/api';
// The campaign's session key, and so the capture id and the uploaded file's name
const RID = 'fvtt-e2e';

// A fresh context per user: Foundry keeps who is logged in in a cookie
async function join(browser, user) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => { if (m.text().includes('lullaby-recorder')) console.log(`[${user}] ${m.text()}`); });
  await page.goto(`${FOUNDRY}/join`);
  await page.selectOption('select[name=userId]', { label: user });
  await page.click('button[name=join]');
  await page.waitForFunction(() => window.game?.ready, null, { timeout: 60_000 });
  // Foundry creates its AudioContexts on the first gesture
  await page.mouse.move(400, 400);
  await page.mouse.click(400, 400);
  await page.evaluate(() => game.audio.unlock);
  return page;
}

module.exports = { FOUNDRY, API, ENDPOINT, RID, join };
