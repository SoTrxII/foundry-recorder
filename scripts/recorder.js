/**
 * Jukebox recorder: captures what Foundry plays (playlists and ambient sounds)
 * and, when the GM asks for it, the board, and streams them to
 * roll20-audio-sync, which aligns them with the Discord recording when the
 * session ends. The Foundry counterpart of Lullaby's tab capture on Roll20,
 * with the same server and the same upload protocol.
 *
 * Foundry is hosted by the GM, usually behind a temporary tunnel: nothing on
 * our side can reach it, during the game or after. Everything is sent from
 * here, while the game is on.
 *
 * Unlike Roll20, no tab capture: Foundry plays through its own AudioContexts,
 * which can be tapped, and draws the board on one canvas, which can be
 * captured. So no share dialog, only what the jukebox plays (no dice or
 * pings) and only the board (no sidebar or chat).
 */
const MODULE = "lullaby-recorder";
// 5s of opus is ~80 KB: cheap to retry, and at most 5s lost if the tab dies
const CHUNK_MS = 5000;
// Backoff for a failing upload, capped so a long outage resumes quickly
const MAX_RETRY_MS = 30000;
// ponytail: the session state is polled. A push channel from
// roll20-audio-sync if 30s between /session start and the reminder is too slow
const SESSION_POLL_MS = 30000;
// The board, when the GM asks for it: what roll20-audio-sync's object can
// carry through Dapr (~1.8 GB) bounds it, and 600 kbps of picture caps 4h at
// ~1.3 GB whatever moves (measured on Roll20). encode-box lays it out at 720p
// and 15 fps. The canvas is recorded at its own size (the GM's window times
// the pixel ratio): captureStream cannot scale, and copying the board into a
// smaller canvas would read a WebGL canvas Foundry does not preserve the
// drawing buffer of. The bitrate bounds the size anyway
const FPS = 15;
const VIDEO_BPS = 600000;
// H.264, else VP8. Measured side by side for Lullaby on one PC (GTX 1070):
// H.264 0.40 Mbps at half VP8's CPU (0.46 Mbps), as Chrome hands it to the
// graphics card. AV1 and VP9 were not worth the probing: software VP9 ignored
// the bitrate (1.1-1.3 Mbps) at twice the CPU
const VIDEO_MIME = ["h264", "vp8"]
  .map((codec) => `video/webm;codecs=${codec},opus`)
  .find((mime) => MediaRecorder.isTypeSupported(mime));

Hooks.once("init", () => {
  game.settings.register(MODULE, "key", {
    name: "Session key",
    hint: "The key Velvet shows for this campaign (/campaign show; for a one-shot, /session start). It ties this world's recordings to the campaign's sessions.",
    // Readable by players: Foundry sends world and user settings alike to
    // every client (checked on v14), and client settings live in
    // localStorage, which a new tunnel address empties every session. All
    // the key allows is sending sound to a session while it is recorded
    scope: "world",
    config: true,
    restricted: true,
    type: String,
    default: "",
    onChange: () => recorder?.reset(),
  });
  // Not shown: production unless a test points it elsewhere
  game.settings.register(MODULE, "endpoint", {
    scope: "world",
    config: false,
    type: String,
    default: "https://jukeboxsync.lullaby.pocot.fr",
  });
  // Per GM rather than per browser: localStorage is per address, and the
  // tunnel's changes every session
  game.settings.register(MODULE, "picture", {
    scope: "user",
    config: false,
    type: Boolean,
    default: false,
  });
});

let recorder = null;

Hooks.once("ready", () => {
  if (!game.user.isGM) return;
  recorder = new Recorder();
  // Rendered again with the sidebar: the same panel is moved back in
  Hooks.on("renderPlaylistDirectory", (app, element) => recorder.attach(element));
  if (ui.playlists?.element) recorder.attach(ui.playlists.element);
  // Without a key the module cannot see a Discord session either, so the
  // reminder never fires: only a disabled button in a tab the GM may never open
  if (!recorder.key) {
    recorder.noKey = ui.notifications.warn(
      "Lullaby: no session key. Paste the one Velvet shows (/campaign show, or /session start for a one-shot) in the module settings.",
      { permanent: true },
    );
  }
});

class Recorder {
  // This tab's id for the server, which lets one tab capture a game at a
  // time: two GM tabs recording the same game would double the music.
  // sessionStorage: different in every tab, and kept across a reload, so a GM
  // who reloads resumes at once instead of being refused by their own capture
  client = sessionStorage.getItem(`${MODULE}-client`) ?? Math.random().toString(36).slice(2);
  // The capture in progress: { stream, release, offset, segment, video }
  capture = null;
  // Chunks waiting for upload, sent one at a time and in order: the server
  // appends them to one webm file per segment
  queue = [];
  sending = false;
  sent = 0;
  // An upload is being retried: the recording goes on, but nothing arrives
  retrying = false;
  // Whether Discord is recording this game: "unknown" until the server answers
  session = "unknown";
  // Why the capture is not running, when there is something to say about it
  note = "";
  // Another tab (a co-GM, or this GM's other window) captures this game
  elsewhere = false;
  // The reminder shown for this session, and whether it was: closing it is
  // final until the session ends
  reminder = null;
  reminded = false;

  constructor() {
    sessionStorage.setItem(`${MODULE}-client`, this.client);
    this.panel = document.createElement("section");
    this.panel.className = `${MODULE} flexcol`;
    this.panel.innerHTML = `
      <h4><span class="${MODULE}-dot"></span>Lullaby</h4>
      <button type="button" class="${MODULE}-toggle"></button>
      <label><input type="checkbox" class="${MODULE}-picture" /> Also record the board</label>
      <p class="${MODULE}-status"></p>
      <p class="${MODULE}-hint hint"></p>`;
    this.button = this.panel.querySelector(`.${MODULE}-toggle`);
    this.picture = this.panel.querySelector(`.${MODULE}-picture`);
    this.status = this.panel.querySelector(`.${MODULE}-status`);
    this.hint = this.panel.querySelector(`.${MODULE}-hint`);
    this.dot = this.panel.querySelector(`.${MODULE}-dot`);
    this.picture.checked = game.settings.get(MODULE, "picture");
    this.picture.addEventListener("change", () => game.settings.set(MODULE, "picture", this.picture.checked));
    this.button.addEventListener("click", () => (this.capture ? this.stop("Stopped") : this.start()));

    // Leaving or reloading Foundry ends the capture: ask first
    window.addEventListener("beforeunload", (e) => {
      if (this.capture) e.preventDefault();
    });
    this.render();
    this.checkSession();
    setInterval(() => this.checkSession(), SESSION_POLL_MS);
    // Coming back to the tab is when the GM can act on it: do not wait for the poll
    document.addEventListener("visibilitychange", () => this.checkSession());
  }

  get key() {
    return game.settings.get(MODULE, "key").trim();
  }

  url(path) {
    return `${game.settings.get(MODULE, "endpoint")}/v1${path}`;
  }

  attach(element) {
    element.prepend(this.panel);
  }

  // The key changed: whatever the server said was about another campaign
  reset() {
    if (this.noKey && this.key) {
      try {
        ui.notifications.remove(this.noKey);
      } catch (e) {}
      this.noKey = null;
    }
    this.stop("Stopped: the session key changed");
    this.session = "unknown";
    this.elsewhere = false;
    this.checkSession();
  }

  // Everything shown comes from the state above, in one place
  render() {
    const running = !this.capture && this.session === "on";
    const unrecorded = running && !this.elsewhere;
    const taken = running && this.elsewhere;
    this.dot.className = `${MODULE}-dot`;
    if (this.capture) this.dot.classList.add(this.retrying ? "warn" : "rec");
    else if (unrecorded) this.dot.classList.add("warn");

    this.button.textContent = this.capture ? "Stop recording" : "Record jukebox";
    this.button.disabled = !this.key && !this.capture;
    // It applies from the next start
    this.picture.disabled = !!this.capture;
    if (this.capture && this.retrying) {
      this.status.textContent = `Recorder unreachable, retrying (${this.queue.length} chunks waiting)`;
    } else if (this.capture) {
      this.status.textContent = `Recording, ${Math.round((this.sent * CHUNK_MS) / 60000)} min sent`;
    } else if (taken) {
      this.status.textContent = "Recorded from another tab";
    } else {
      this.status.textContent = this.note;
    }
    if (!this.key) {
      this.hint.textContent = "Paste the session key Velvet shows (/campaign show, or /session start for a one-shot) in the module settings.";
    } else if (this.capture) {
      this.hint.textContent = this.capture.video
        ? "Keep this tab open, and in front: closing or reloading it stops the recording, and in the background the board is recorded at about 2 frames a second. The board is recorded as you see it, hidden tokens included."
        : "Keep this tab open: closing or reloading it stops the recording.";
    } else if (taken) {
      this.hint.textContent = "Another GM or another tab already records this session's jukebox. Nothing to do here.";
    } else if (unrecorded) {
      this.hint.textContent = "A session is being recorded in Discord. Record the jukebox to have its music in the video.";
    } else {
      this.hint.textContent = "Start the session in Discord first (/session start), then record the jukebox here.";
    }

    if (unrecorded && !this.reminded) {
      this.reminded = true;
      this.reminder = ui.notifications.warn(
        "Marduk records this session in Discord, but not Foundry's jukebox. Record it from the Playlists tab.",
        { permanent: true },
      );
    } else if (!unrecorded && this.reminder) {
      this.dismissReminder();
    }
    if (this.session !== "on") this.reminded = false;
  }

  dismissReminder() {
    try {
      ui.notifications.remove(this.reminder);
    } catch (e) {}
    this.reminder = null;
  }

  async checkSession() {
    // While capturing, the uploads tell: a 409 is the end of the session
    if (this.capture || document.hidden || !this.key) return;
    try {
      const body = await this.fetchStatus();
      if (this.capture) return;
      this.session = body.recording ? "on" : "off";
      this.elsewhere = body.capturedElsewhere === true;
    } catch (e) {
      this.session = "unknown";
      this.elsewhere = false;
    }
    this.render();
  }

  async fetchStatus() {
    const res = await fetch(this.url(`/capture/${encodeURIComponent(this.key)}/status?client=${this.client}`));
    return res.json();
  }

  // Server clock minus ours, from one round trip (accurate to RTT/2).
  // Segment start times must be on the server clock: that is the clock the
  // Discord recording start is stamped with
  async serverOffset() {
    const t0 = Date.now();
    const res = await fetch(this.url("/time"));
    const body = await res.json();
    return body.now - (t0 + Date.now()) / 2;
  }

  // Foundry plays music and ambience through two of its three AudioContexts
  // (the third is the interface: dice, pings), each ending in a gain node for
  // the GM's volume. Tapped after it, so the recording is what the GM hears,
  // volume sliders included, as on Roll20. Nodes cannot cross contexts, and
  // MediaRecorder records one audio track: both are mixed in a third context
  tapAudio() {
    const mix = new AudioContext();
    const out = mix.createMediaStreamDestination();
    const taps = [game.audio.music, game.audio.environment].map((ctx) => {
      const tap = ctx.createMediaStreamDestination();
      ctx.gainNode.connect(tap);
      mix.createMediaStreamSource(tap.stream).connect(out);
      return () => ctx.gainNode.disconnect(tap);
    });
    return {
      track: out.stream.getAudioTracks()[0],
      release: () => {
        taps.forEach((untap) => untap());
        mix.close();
      },
    };
  }

  async start() {
    const withPicture = this.picture.checked;
    // Foundry creates its AudioContexts on the first gesture, which this
    // click is at the latest
    await game.audio.unlock;
    try {
      const body = await this.fetchStatus();
      if (!body.recording) {
        this.session = "off";
        this.note = "Not recording: no session is running in Discord.";
        return this.render();
      }
      if (body.capturedElsewhere) {
        this.session = "on";
        this.elsewhere = true;
        return this.render();
      }
      const offset = await this.serverOffset();
      const board = canvas.app.view;
      const video = withPicture && VIDEO_MIME;
      const audio = this.tapAudio();
      const tracks = [audio.track];
      if (video) tracks.push(board.captureStream(FPS).getVideoTracks()[0]);
      this.capture = { stream: new MediaStream(tracks), release: audio.release, offset, segment: null, video };
    } catch (e) {
      this.note = `Not recording: recorder unreachable (${e.message})`;
      return this.render();
    }
    this.newSegment();
    this.session = "on";
    this.elsewhere = false;
    this.note = "";
    this.sent = 0;
    this.retrying = false;
    this.render();
  }

  // A segment is one MediaRecorder run: its first chunk holds the webm
  // header, so a broken sequence can only be recovered with a new segment.
  // Its id is its start time on the server clock: unique even across a page
  // reload, where a counter would restart at 0 and collide with the segments
  // already uploaded
  newSegment() {
    const recorder = new MediaRecorder(this.capture.stream, {
      mimeType: this.capture.video || "audio/webm;codecs=opus",
      audioBitsPerSecond: 128000,
      videoBitsPerSecond: VIDEO_BPS,
    });
    // Stamped on the call, not on the "start" event: the webm's clock starts
    // at the call, and with a picture Chrome fires the event once the encoder
    // delivers, measured 0.13s to 1.1s later on Roll20
    const segment = { recorder, id: Math.round(Date.now() + this.capture.offset), seq: 0, dead: false, video: !!this.capture.video };
    recorder.addEventListener("dataavailable", (e) => {
      if (e.data.size > 0 && !segment.dead) {
        this.queue.push({ segment, seq: segment.seq++, blob: e.data });
        this.pump();
      }
    });
    recorder.start(CHUNK_MS);
    this.capture.segment = segment;
  }

  async pump() {
    if (this.sending) return;
    this.sending = true;
    while (this.queue.length > 0) {
      const chunk = this.queue[0];
      if (chunk.segment.dead) {
        this.queue.shift();
        continue;
      }
      const code = await this.upload(chunk);
      this.queue.shift();
      if (code === 409) {
        // The session ended in Discord: nothing will accept sound anymore
        this.queue.length = 0;
        this.session = "off";
        this.stop("Session ended: recording stopped");
      } else if (code === 423) {
        // Another tab holds this game's capture: recording here too would
        // double the music
        this.queue.length = 0;
        this.elsewhere = true;
        this.stop("Stopped: the jukebox is already recorded from another tab");
      } else if (code >= 400) {
        // A sequence the server cannot append: start over in a new segment
        chunk.segment.dead = true;
        if (this.capture?.segment === chunk.segment) {
          chunk.segment.recorder.stop();
          this.newSegment();
        }
      } else {
        this.sent += 1;
        this.render();
      }
    }
    this.sending = false;
  }

  // Retries network errors and 5xx until the server answers for real: a chunk
  // given up on would be a hole in the recording
  async upload(chunk) {
    const s = chunk.segment;
    const url = this.url(
      `/capture/${encodeURIComponent(this.key)}/chunk?seg=${s.id}&seq=${chunk.seq}&startedAt=${s.id}&client=${this.client}${s.video ? "&video=1" : ""}`,
    );
    let delay = 1000;
    for (;;) {
      try {
        const res = await fetch(url, { method: "POST", body: chunk.blob });
        if (res.status < 500) {
          this.retrying = false;
          return res.status;
        }
      } catch (e) {
        console.log(`${MODULE} | upload failed, retrying in ${delay}ms (${e.message})`);
      }
      this.retrying = true;
      this.render();
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, MAX_RETRY_MS);
    }
  }

  stop(text) {
    if (!this.capture) return;
    const c = this.capture;
    this.capture = null;
    // Flushes the last chunk, which the queue still uploads
    if (c.segment.recorder.state !== "inactive") c.segment.recorder.stop();
    c.stream.getTracks().forEach((t) => t.stop());
    c.release();
    this.note = text;
    this.retrying = false;
    this.render();
  }
}
