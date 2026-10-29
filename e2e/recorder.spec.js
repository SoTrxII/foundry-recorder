// End to end: what Foundry's jukebox plays in the GM's tab must end up in the
// recording that roll20-audio-sync uploads, at the right place on the Discord
// timeline.
//
// Real parts: Foundry (v12 to v14) with the module, a playlist played as the GM plays
// one, Chrome's MediaRecorder, the published roll20-audio-sync image and its
// daprd sidecar, the ffmpeg mix. Stand-ins: a 440 Hz tone instead of music,
// the test instead of record-orchestrator (start/stop), a local folder instead
// of MinIO, a proxy instead of Kong's CORS.
const { test, expect } = require('@playwright/test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { API, RID, join } = require('./foundry');

const TONE_S = 4;
// The status light's classes, whole: 'rec' alone would match lullaby-recorder-dot
const REC = /(^|\s)rec(\s|$)/;
const WARN = /(^|\s)warn(\s|$)/;
const LIT = /(^|\s)(rec|warn)(\s|$)/;

async function post(route, body) {
  return fetch(API + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

// What record-orchestrator does on /session start. Production stamps the
// Discord t=0 with the cluster clock: take the server's clock here too
async function startSession() {
  const alignTo = (await (await fetch(`${API}/v1/time`)).json()).now;
  expect((await post('/v1/jukeboxsyncer/start', { id: RID, alignTo })).status).toBe(202);
  return alignTo;
}

// Where the tone is in the recording: silence detection on the 440 Hz band only,
// so neither noise nor anything else can pass for it
function toneSpan(file) {
  const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af',
    'bandpass=f=440:width_type=h:w=50,silencedetect=noise=-45dB:d=0.3', '-f', 'null', '-'], { encoding: 'utf8' });
  const ends = [...stderr.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const starts = [...stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const start = ends[0];
  const end = starts.find((s) => s > start);
  // A tone is a silence ending with another one starting later (the file's
  // last silence ends with the file, not with a tone)
  const tones = ends.filter((e) => starts.some((s) => s > e)).length;
  return { start, end, tones, log: stderr.split('\n').filter((l) => l.includes('silence')).join('\n') };
}

// Plays the playlist's tone as the GM's click does (an update of the sound,
// which every client then plays) and returns when, on the server clock:
// converted the same way the module converts its segment start times
async function playTone(page) {
  return page.evaluate(async () => {
    const sound = game.playlists.getName('e2e').sounds.getName('tone');
    if (sound.playing) await sound.update({ playing: false });
    await game.audio.preload(sound.path);
    const endpoint = game.settings.get('lullaby-recorder', 'endpoint');
    const t0 = Date.now();
    const { now } = await (await fetch(`${endpoint}/v1/time`)).json();
    const offset = now - (t0 + Date.now()) / 2;
    const at = Date.now() + offset;
    await sound.update({ playing: true });
    return at;
  });
}

async function openPanel(page) {
  await page.locator('#sidebar [data-tab="playlists"]').first().click();
  const panel = page.locator('section.lullaby-recorder');
  await expect(panel).toBeVisible();
  return panel;
}

test('a GM without a session key is told, until it is pasted', async ({ browser }) => {
  let gm = await join(browser, 'Gamemaster');
  await gm.evaluate(() => game.settings.set('lullaby-recorder', 'key', ''));
  await gm.context().close();
  gm = await join(browser, 'Gamemaster');
  const warning = gm.locator('#notifications .notification.warning', { hasText: 'no session key' });
  await expect(warning).toBeVisible();
  await gm.evaluate((key) => game.settings.set('lullaby-recorder', 'key', key), RID);
  await expect(warning).toHaveCount(0);
  await gm.context().close();
});

test('the jukebox is recorded, aligned on the Discord start, without the interface sounds', async ({ browser }, testInfo) => {
  const alignTo = await startSession();

  // The session runs and the jukebox is not recorded: the module says so
  // without being asked
  const gm = await join(browser, 'Gamemaster');
  const reminder = gm.locator('#notifications .notification.warning', { hasText: "not Foundry's jukebox" });
  await expect(reminder).toBeVisible();
  const panel = await openPanel(gm);
  await expect(panel.locator('.lullaby-recorder-dot')).toHaveClass(WARN);
  await gm.screenshot({ path: testInfo.outputPath('reminder.png') });

  // The world keeps the GM's last choice between runs: the registered default is what a new GM gets
  expect(await gm.evaluate(() => game.settings.settings.get('lullaby-recorder.picture').default), 'ticked by default, like Roll20').toBe(true);
  await panel.locator('.lullaby-recorder-picture').uncheck();
  await panel.getByRole('button', { name: 'Record jukebox' }).click();
  await expect(panel.locator('.lullaby-recorder-status')).toHaveText(/^Recording/);
  await expect(reminder).toBeHidden();
  await expect(panel.locator('.lullaby-recorder-dot')).toHaveClass(REC);
  await gm.screenshot({ path: testInfo.outputPath('recording.png') });

  // The jukebox plays a few seconds into the session
  await gm.waitForTimeout(3000);
  const playedAt = await playTone(gm);
  // Then an interface sound (dice, pings): not the jukebox, not recorded
  await gm.waitForTimeout((TONE_S + 1) * 1000);
  await gm.evaluate((p) => game.audio.play(p, { context: game.audio.interface }), 'e2e/tone.ogg');
  // Chunks are 5s: wait until the one holding the end of the tones has been sent
  await gm.waitForTimeout((TONE_S + 6) * 1000);

  // A co-GM: the jukebox is already recorded, and recording it twice would
  // double the music. No reminder there
  const coGm = await join(browser, 'Co-GM');
  const other = await openPanel(coGm);
  await expect(other.locator('.lullaby-recorder-status')).toHaveText('Recorded from another tab');
  await expect(coGm.locator('#notifications .notification.warning', { hasText: "not Foundry's jukebox" })).toHaveCount(0);
  await coGm.screenshot({ path: testInfo.outputPath('co-gm.png') });
  await coGm.context().close();

  // /session end: record-orchestrator stops the record while the GM still captures...
  const stop = await post('/v1/jukeboxsyncer/stop', { id: RID });
  expect(stop.status, await stop.clone().text()).toBe(200);
  expect(await stop.json()).toEqual({ key: `${RID}.ogg` });
  // ...and the module stops by itself on its next chunk (409)
  await expect(panel.locator('.lullaby-recorder-status')).toHaveText(/Session ended/, { timeout: 10_000 });
  await expect(panel.locator('.lullaby-recorder-dot')).not.toHaveClass(LIT);
  await gm.context().close();

  const span = toneSpan(path.join(__dirname, '.out', `${RID}.ogg`));
  const expectedStart = (playedAt - alignTo) / 1000;
  console.log(`tone expected at ${expectedStart.toFixed(3)}s, found at ${span.start}s to ${span.end}s (${span.tones} tone)\n${span.log}`);
  expect(span.start, 'the tone is in the recording').toBeDefined();
  expect(span.tones, 'the jukebox tone, and not the interface one').toBe(1);
  // Measured on 2026-10-22 (Windows, Chrome, both tests): 23-47 ms late, the
  // playlist update's round trip to the server before Foundry plays it. Better
  // than Lullaby's 70-102 ms: nothing goes through the audio output. The
  // bound is Lullaby's, for the same reason: inaudible under music
  expect(Math.abs(span.start - expectedStart), 'the tone is where it was played').toBeLessThan(0.4);
  expect(span.end - span.start, 'the whole tone is there').toBeGreaterThan(TONE_S - 0.5);
});

// The GM ticked "Also record the board": it goes with the jukebox, in sync
// with it on the Discord timeline. The board turns from black to white as
// the tone starts: the first white frame must come with the tone
test('with the board, the picture is recorded too, in sync with its sound', async ({ browser }) => {
  const alignTo = await startSession();
  const gm = await join(browser, 'Gamemaster');
  // A screen over the whole board, drawn by Foundry's own renderer
  await gm.evaluate(() => {
    const screen = new PIXI.Graphics();
    window.paintBoard = (color) => screen.clear().beginFill(color).drawRect(-1e5, -1e5, 2e5, 2e5).endFill();
    window.paintBoard(0x000000);
    canvas.stage.addChild(screen);
  });
  const panel = await openPanel(gm);
  const box = panel.locator('.lullaby-recorder-picture');
  await box.check();
  await panel.getByRole('button', { name: 'Record jukebox' }).click();
  await expect(panel.locator('.lullaby-recorder-status')).toHaveText(/^Recording/);
  await expect(box, 'it applies from the next start').toBeDisabled();

  await gm.waitForTimeout(3000);
  const playedAt = await playTone(gm);
  await gm.evaluate(() => window.paintBoard(0xffffff));
  await gm.waitForTimeout((TONE_S + 6) * 1000);

  const stop = await post('/v1/jukeboxsyncer/stop', { id: RID });
  expect(stop.status, await stop.clone().text()).toBe(200);
  expect(await stop.json()).toEqual({ key: `video/${RID}.mkv` });
  await expect(panel.locator('.lullaby-recorder-status')).toHaveText(/Session ended/, { timeout: 10_000 });
  await box.uncheck();
  await gm.context().close();

  const file = path.join(__dirname, '.out', 'video', `${RID}.mkv`);
  const { streams } = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height',
    '-of', 'json', file], { encoding: 'utf8' }).stdout);
  console.log(`streams: ${JSON.stringify(streams)}`);
  expect(streams.map((s) => s.codec_type).sort(), 'the jukebox mix and one picture').toEqual(['audio', 'video']);

  const span = toneSpan(file);
  const expectedStart = (playedAt - alignTo) / 1000;
  console.log(`tone expected at ${expectedStart.toFixed(3)}s, found at ${span.start}s to ${span.end}s\n${span.log}`);
  expect(Math.abs(span.start - expectedStart), 'the tone is where it was played').toBeLessThan(0.4);
  expect(span.end - span.start, 'the whole tone is there').toBeGreaterThan(TONE_S - 0.5);

  // Mean luma per frame: 16 is black, 235 white
  const { stderr } = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-map', '0:v',
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf8' });
  const frames = [...stderr.matchAll(/pts_time:([\d.]+)[\s\S]*?YAVG=([\d.]+)/g)].map((m) => ({ at: Number(m[1]), y: Number(m[2]) }));
  const white = frames.find((f) => f.y > 128);
  console.log(`${frames.length} frames, from ${frames[0]?.at}s; first white one at ${white?.at}s`);
  expect(frames.some((f) => f.y < 64 && f.at < span.start), 'black before the tone').toBe(true);
  expect(white, 'the board turned white').toBeDefined();
  // Measured on 2026-10-22: 51-56 ms after the tone, under one frame at 15 fps
  expect(Math.abs(white.at - span.start), 'the picture is in sync with the sound').toBeLessThan(0.3);
});
