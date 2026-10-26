# Marduk recorder (Foundry VTT module)

Records a Foundry game's jukebox (playlists and ambient sounds) and, when the GM
asks for it, the board, while Marduk records the session's voices in Discord. The
video Marduk publishes then has the game's music, and the board if recorded,
under the voices.

The Foundry counterpart of Lullaby's jukebox recorder on Roll20: same server ([roll20-audio-sync](https://github.com/SoTrxII/roll20-audio-sync)),
same upload protocol.

## For a GM

1. In Foundry's setup screen, *Add-on Modules → Install Module*, paste the
   manifest URL:
   `https://github.com/SoTrxII/foundry-recorder/releases/latest/download/module.json`
2. Enable *Marduk recorder* in the world (*Manage Modules*).
3. In *Configure Settings → Marduk recorder*, paste the campaign's session key,
   shown by Velvet in `/campaign show` (for a one-shot, by `/session start`).
4. Each session: `/session start` in Discord, then **Record jukebox** at the top
   of the Playlists tab. A notification reminds you if you forget. It stops by
   itself at `/session end`.

Keep the tab open: closing or reloading Foundry stops the recording (it resumes
with a click). Tick *Also record the board* to have the board in the video: it
is recorded **as you see it**, hidden tokens and GM drawings included, and at
about 2 frames a second while the tab is in the background.

## How it works

Foundry plays music, ambience and interface sounds through three AudioContexts
(`game.audio.music`, `.environment`, `.interface`). The module taps the first two
after their gain node (what the GM hears, volume included; dice and pings are
left out), mixes them, and records the mix with `MediaRecorder`, in 5 s chunks
sent to roll20-audio-sync. The board is `canvas.app.view.captureStream()`: the
canvas only, without the sidebar or chat.

Unlike Roll20's tab capture there is no share dialog, so nothing but the GM's
click is needed, and only Foundry's own sounds are recorded: music played by
something else (a YouTube embed, another tab) is not.

Foundry is hosted by the GM, usually behind a temporary tunnel: nothing on
Marduk's side ever connects to it. Everything is sent from the GM's browser,
during the game.

The session key is a world setting. Players can read it (Foundry sends world
and user settings to every client); all it allows is sending sound to a session
while it is being recorded.

## Testing

`e2e/` runs Foundry v14 ([felddy/foundryvtt](https://github.com/felddy/foundryvtt-docker))
with the module mounted in, roll20-audio-sync as deployed, and Chrome through
Playwright. It checks that a GM without a key is warned, plays a tone through a playlist, and checks it lands in the
recording where it was played, that an interface sound does not, that a co-GM
is told the jukebox is already recorded, and with the board, that the picture
is in sync with the sound.

Needs Docker, Chrome, ffmpeg, and a foundryvtt.com account with a licence, in a
file outside the repo (default `~/.foundry/config.json`, or `FOUNDRY_SECRETS`):

```json
{ "foundry_username": "...", "foundry_password": "...", "foundry_admin_key": "anything" }
```

```bash
cd e2e
npm install
npx playwright test               # the first run downloads Foundry (~200 MB)
KEEP_STACK=1 npx playwright test  # keep the containers for `docker compose logs`
```

**It plays beeps.** Local only: it needs the licence, so not in CI. The
Foundry volume (download, licence, test world) is kept between runs.
