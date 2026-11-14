/**
 * TeslaCinema: a real, normally launched Google Chrome on a virtual display (Xvfb + Fluxbox), captured together with its
 * sound by ffmpeg and delivered to the car's browser as one MPEG-TS stream over plain HTTP long polls (or a WebSocket,
 * which the page tries first and falls back from). Mouse, touch and keyboard come back as plain HTTP POSTs
 * (xhelper.c for the mouse, xdotool for the keyboard).
 *
 * Chrome is started like any desktop app, not through Playwright/CDP with automation flags, so logins, extensions and
 * DRM playback (Widevine) behave like in a normal browser. Everything sits behind HTTP Basic Auth (AUTH_USER /
 * AUTH_PASSWORD); the server refuses to start without a password unless ALLOW_NO_AUTH=1.
 */
const path = require("path");
const crypto = require("crypto");
const fsp = require("fs/promises");
const fssync = require("fs");
const { spawn, execFile } = require("child_process");
const express = require("express");
const multer = require("multer");
const { WebSocket, WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || "/data";
const PROFILE_DIR = path.join(DATA_DIR, "chrome-profile");
const SHARED_DIR = path.join(DATA_DIR, "shared");
const UPLOAD_TMP_DIR = "/tmp/teslacinema-uploads";

// Mutable: /resize changes these at runtime (real xrandr resolution
// switching, not just a client-side CSS scale) -- see resizeDisplay().
let DISPLAY_WIDTH = parseInt(process.env.DISPLAY_WIDTH || "1920", 10);
let DISPLAY_HEIGHT = parseInt(process.env.DISPLAY_HEIGHT || "1080", 10);
const TARGET_FPS = parseInt(process.env.TARGET_FPS || "24", 10);
const DISPLAY = ":99";
const MJPEG_BOUNDARY = "frame";
const PULSE_SOCKET = "/var/run/pulse/native";
// Deliberately NOT under /tmp: it's world-writable with the sticky bit set,
// and the kernel's fs.protected_fifos hardening (on by default on modern
// Debian) refuses to open a FIFO there when its owner doesn't match the
// opening process's uid -- even for root. PulseAudio's pipe-source module
// creates and owns this FIFO as the "pulse" system user, so ffmpeg (running
// as root) got a flat "Permission denied" trying to open it under /tmp.
// A root-owned, non-world-writable directory sidesteps the restriction
// entirely (it only applies to world-writable/sticky directories).
const MIC_FIFO_DIR = "/run/teslacinema";
const MIC_FIFO_PATH = path.join(MIC_FIFO_DIR, "virtmic");

const LOCALE = process.env.LOCALE || "en_US.UTF-8";
const CHROME_LANG = process.env.CHROME_LANG || LOCALE.split(".")[0].replace("_", "-");
const HAS_GPU = fssync.existsSync("/dev/dri/renderD128");

const childEnv = {
  ...process.env,
  DISPLAY,
  PULSE_SERVER: `unix:${PULSE_SOCKET}`,
  // Any UTF-8 locale is required: under the default "C" locale xdotool cannot type multi-byte characters (umlauts,
  // accents, emoji) at all. LOCALE also sets the language of Chrome's own UI (see CHROME_LANG below).
  LANG: LOCALE,
  LC_ALL: LOCALE,
  LANGUAGE: LOCALE.split(".")[0],
};

function xdotool(args) {
  return new Promise((resolve, reject) => {
    execFile("xdotool", args, { env: childEnv }, (err) => (err ? reject(err) : resolve()));
  });
}

function execFilePromise(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { env: childEnv }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

async function waitForX11Socket(timeoutMs = 15000) {
  const socketPath = `/tmp/.X11-unix/X99`;
  const start = Date.now();
  while (!fssync.existsSync(socketPath)) {
    if (Date.now() - start > timeoutMs) throw new Error("Xvfb did not start in time");
    await new Promise((r) => setTimeout(r, 200));
  }
  // The socket file can exist slightly before Xvfb accepts connections.
  await new Promise((r) => setTimeout(r, 300));
}

async function waitForPulseSocket(timeoutMs = 15000) {
  const start = Date.now();
  while (!fssync.existsSync(PULSE_SOCKET)) {
    if (Date.now() - start > timeoutMs) throw new Error("PulseAudio did not start in time");
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 300));
}

// Keeps a process running: restarts it whenever it exits. A process that keeps dying right away (something it needs is missing or
// broken) is retried less and less often - 2 s, 4 s, 8 s ... up to 60 s - instead of every 2 s for ever: on 2026-10-02 a stale Xvfb
// lock made Xvfb, fluxbox and Chrome fail every 2 s for four days, and every failed Chrome start left a 4 MB BrowserMetrics file in
// the profile until the host's disk was full. One that ran for a minute or more starts over at 2 s. `before` (sync) runs before
// every start - the place to clear whatever a dead instance left behind.
function spawnPersistent(name, command, args, before = null, delay = 1000) {
  if (before) { try { before(); } catch (e) { console.error(`${name}: clean-up before start failed: ${e.message}`); } }
  const started = Date.now();
  const proc = spawn(command, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.on("exit", (code, signal) => {
    const ran = Date.now() - started, next = ran >= 60000 ? 2000 : Math.min(60000, delay * 2);
    console.error(`${name} exited (code=${code}, signal=${signal}) after ${Math.round(ran / 1000)}s -- restarting in ${next / 1000}s`);
    setTimeout(() => spawnPersistent(name, command, args, before, next), next);
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  return proc;
}

// Xvfb's lock (/tmp/.X99-lock, holding its PID) and socket outlive Xvfb itself when the container is stopped or the host goes down,
// and /tmp is not cleared when the same container starts again. After the host reboot of 2026-10-02 the lock named PID 20 - by
// then a different process - so every new Xvfb said "Server is already active for display 99" and quit, for days. Only this
// server ever runs an Xvfb here, and it only starts one after the last one exited: whatever lock is there is stale.
function clearStaleXvfbLock() {
  for (const f of ["/tmp/.X99-lock", "/tmp/.X11-unix/X99"]) fssync.rmSync(f, { force: true });
}

// Chrome leaves a BrowserMetrics-*.pma file (about 4 MB of usage statistics, nothing else) for every start it does not shut down
// cleanly. They piled up to 37 GB. Chrome is not running when this runs (before each start), so all of them can go.
function clearChromeMetrics() {
  const dir = path.join(PROFILE_DIR, "BrowserMetrics");
  if (!fssync.existsSync(dir)) return;
  for (const f of fssync.readdirSync(dir)) if (f.endsWith(".pma")) fssync.rmSync(path.join(dir, f), { force: true });
}
function clearStaleChromeLockSync() {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) fssync.rmSync(path.join(PROFILE_DIR, name), { force: true });
}

// Chrome writes SingletonLock/-Socket/-Cookie into the profile dir to stop
// two instances from sharing (and corrupting) one profile at once, keyed by
// hostname+PID. That protection is meaningless here -- this container's
// whole job is running exactly one Chrome against this profile at a time --
// but the check itself doesn't know that: PROFILE_DIR lives on a volume that
// outlives any single container, and every fresh container gets a new
// random hostname (Docker's default), so Chrome sees "different computer,
// lock still held" and refuses to start with a profile-in-use dialog on any
// container *recreate* (not a plain restart of the same container, which
// keeps the same hostname and lets Chrome's own graceful-shutdown handling
// clean this up itself). Confirmed by reproducing it after a rebuild+
// recreate cycle. Deleting these unconditionally before every launch is
// safe precisely because there is never a second real instance to protect
// against.
async function clearStaleChromeLock() {
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    await fsp.rm(path.join(PROFILE_DIR, name), { force: true }).catch(() => {});
  }
}

// Chrome has no CLI flag for "default download directory" -- it's a
// profile preference. Seeding it before first launch means downloads land
// in SHARED_DIR without a save-dialog prompt, no CDP involved.
async function seedChromePreferences() {
  const defaultProfileDir = path.join(PROFILE_DIR, "Default");
  const prefsPath = path.join(defaultProfileDir, "Preferences");
  if (fssync.existsSync(prefsPath)) {
    // the container is stopped hard on every update: tell Chrome its last run ended cleanly, or it greets the car with
    // "Restore pages?" every time
    try {
      const prefs = JSON.parse(await fsp.readFile(prefsPath, "utf8"));
      prefs.profile = { ...(prefs.profile ?? {}), exit_type: "Normal", exited_cleanly: true };
      await fsp.writeFile(prefsPath, JSON.stringify(prefs));
    } catch {}
    return;
  }
  await fsp.mkdir(defaultProfileDir, { recursive: true });
  const prefs = {
    download: { default_directory: SHARED_DIR, prompt_for_download: false, directory_upgrade: true },
    profile: { default_content_setting_values: { notifications: 2 } },
    browser: { check_default_browser: false },
  };
  await fsp.writeFile(prefsPath, JSON.stringify(prefs));
}

// --- Video. Two pipelines, each an ffmpeg capturing the X display, started when a client first asks for frames and stopped
// again when nobody has asked for a while:
//
//   h264  H.264 for browsers with WebCodecs (GPU encoder via VAAPI, libx264 if that fails): about 1.5-6 Mbit/s.
//   jpeg  one JPEG per frame for everything else; a frame identical to the last one is not counted as new, so a still screen
//         costs nothing.
//
// Delivery is pull, one request per answer: the client asks for "anything after seq N", the server answers as soon as there
// is something newer (or after FRAME_WAIT_MS with 204). There is never more than one answer in flight per client, whatever
// sits in between. The old design streamed frames down one long response; behind a buffering reverse proxy (nginx reads the
// upstream as fast as it can and spools to disk) every frame the client could not take in time piled up there, so the picture
// fell further and further behind after a few seconds of use, until a reload.
//
// Neither pipeline draws the mouse pointer: the browser draws the real pointer shape itself (see /cursor), so it never lags.
const FRAME_WAIT_MS = 15000;
const PIPELINE_IDLE_MS = 15000;
// a client further behind than this many H.264 frames skips ahead to the newest keyframe instead of catching up frame by frame
const H264_MAX_LAG = TARGET_FPS;
const H264_GOP = TARGET_FPS; // a keyframe every second: bounds how long a skip ahead can take
// Bitrate steps (average / peak). A still screen needs about 0.2 Mbit/s at any step (a constant-bitrate setting filled even
// that up to the full rate). When a client keeps having to skip ahead, its line is slower than the stream: the encoder
// restarts one step lower. After a minute without skips it tries one step higher again.
const H264_STEPS = [
  [process.env.H264_BITRATE || "3M", process.env.H264_MAXRATE || "8M"],
  ["1500k", "4M"],
  ["800k", "2M"],
  ["400k", "1M"],
];
const H264_STEP_UP_MS = 60000;
const JPEG_QUALITY = process.env.JPEG_QUALITY || "7"; // ffmpeg -q:v, 2 (best) .. 31; was 5

function makePipeline(name) {
  return { name, proc: null, wanted: false, restartExpected: false, lastPoll: 0, startedAt: 0, produced: 0, waiters: new Set(), buffer: Buffer.alloc(0), seq: 0 };
}
const jpeg = Object.assign(makePipeline("jpeg"), { frame: null });
const h264 = Object.assign(makePipeline("h264"), {
  encoder: process.env.H264_ENCODER || "vaapi",
  frames: [], // {seq, key, data}, the newest last
  au: [], // NAL units of the access unit being collected
  sps: null,
  pps: null,
  codec: null,
  epoch: 0, // bumped for every new ffmpeg: frames of different epochs cannot be decoded one after the other
  width: 0,
  height: 0,
  step: 0, // index into H264_STEPS
  skips: [], // times a continuing client was made to skip ahead
  stepChangedAt: 0,
});

// Picture and sound together for the Tesla browser: one ffmpeg grabs the screen and Chrome's sound into one MPEG-TS stream
// (MPEG-1 video, MP2 audio), so both carry timestamps of the same clock. The page decodes it with JSMpeg onto a canvas and
// plays the sound through Web Audio, with the sound as the clock the pictures follow - no <video> element anywhere.
const AV_BITRATE = process.env.AV_BITRATE || "3500k";
const AV_FPS = parseInt(process.env.AV_FPS || "30", 10); // MPEG-1 knows 24, 25, 30, 50 and 60 among others
const AV_MAX_BEHIND_MS = parseInt(process.env.AV_MAX_BEHIND_MS || "400", 10);
const AV_KEEP_MS = 4000;
const av = Object.assign(makePipeline("av"), {
  chunks: [], // {seq, t, data, gop}: gop is the byte offset of a picture with a sequence header (a point to start from), or -1
});

function setH264Step(step) {
  if (step === h264.step) return;
  console.error(`h264: bitrate step ${h264.step} -> ${step} (${H264_STEPS[step][0]} / ${H264_STEPS[step][1]})`);
  h264.step = step;
  h264.stepChangedAt = Date.now();
  h264.skips = [];
  if (h264.proc) {
    h264.restartExpected = true;
    h264.proc.kill("SIGTERM");
  }
}

function noteH264Skip() {
  const now = Date.now();
  h264.skips = h264.skips.filter((t) => now - t < 20000);
  h264.skips.push(now);
  // two skips in 20 s, and the last change was a while ago (the new step needs a moment to show its effect)
  if (h264.skips.length >= 2 && now - h264.stepChangedAt > 5000 && h264.step < H264_STEPS.length - 1) setH264Step(h264.step + 1);
}

setInterval(() => {
  const quiet = Date.now() - Math.max(h264.stepChangedAt, h264.skips[h264.skips.length - 1] || 0);
  if (h264.proc && h264.step > 0 && quiet > H264_STEP_UP_MS) setH264Step(h264.step - 1);
}, 5000);

function wake(p) {
  for (const w of p.waiters) w();
}

function captureInput() {
  return ["-f", "x11grab", "-draw_mouse", "0", "-framerate", String(TARGET_FPS), "-video_size", `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`, "-i", DISPLAY];
}

function pipelineArgs(p) {
  if (p === av) {
    return [
      "-loglevel", "error",
      "-thread_queue_size", "64", "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(AV_FPS), "-video_size", `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}`, "-i", DISPLAY,
      // small pulse fragments: the muxer waits for the sound before it writes the pictures of the same moment
      "-thread_queue_size", "64", "-f", "pulse", "-fragment_size", "3840", "-i", "chrome_out.monitor",
      "-map", "0:v", "-map", "1:a",
      "-c:v", "mpeg1video", "-b:v", AV_BITRATE, "-maxrate", AV_BITRATE, "-bufsize", "2M", "-g", String(AV_FPS), "-bf", "0", "-fps_mode", "cfr", "-r", String(AV_FPS),
      "-c:a", "mp2", "-b:a", "128k", "-ac", "2", "-ar", "48000",
      // every audio frame in its own packet (by default the muxer collects ~170 ms of them), nothing held back
      "-f", "mpegts", "-pes_payload_size", "0", "-omit_video_pes_length", "0", "-muxdelay", "0", "-muxpreload", "0", "-max_interleave_delta", "100000", "-flush_packets", "1",
      "pipe:1",
    ];
  }
  if (p === jpeg) return ["-loglevel", "error", ...captureInput(), "-f", "mpjpeg", "-boundary_tag", MJPEG_BOUNDARY, "-q:v", JPEG_QUALITY, "-flush_packets", "1", "pipe:1"];
  const [bitrate, maxrate] = H264_STEPS[h264.step];
  const common = ["-g", String(H264_GOP), "-bf", "0", "-maxrate", maxrate, "-flush_packets", "1", "-f", "h264", "pipe:1"];
  if (h264.encoder === "vaapi") {
    const vaapi = ["-c:v", "h264_vaapi", "-rc_mode", "VBR", "-b:v", bitrate, "-aud", "1", "-async_depth", "1"];
    return ["-loglevel", "error", "-vaapi_device", "/dev/dri/renderD128", ...captureInput(), "-vf", "format=nv12,hwupload", ...vaapi, ...common];
  }
  const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", "23", "-bufsize", maxrate, "-x264-params", "aud=1:repeat-headers=1"];
  return ["-loglevel", "error", ...captureInput(), "-vf", "format=yuv420p", ...x264, ...common];
}

function startPipeline(p) {
  p.wanted = true;
  if (p.proc) return;
  p.buffer = Buffer.alloc(0);
  p.startedAt = Date.now();
  p.produced = 0;
  if (p === av) av.chunks = [];
  if (p === h264) {
    h264.epoch++;
    h264.frames = [];
    h264.au = [];
    h264.width = DISPLAY_WIDTH;
    h264.height = DISPLAY_HEIGHT;
  }
  const proc = spawn("ffmpeg", pipelineArgs(p), { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => (p === jpeg ? parseJpegChunk(chunk) : p === av ? parseTsChunk(chunk) : parseH264Chunk(chunk)));
  proc.stderr.on("data", (d) => process.stderr.write(`[ffmpeg ${p.name}] ${d}`));
  proc.on("exit", (code, signal) => {
    p.proc = null;
    if (!p.wanted) return;
    if (p.restartExpected) {
      p.restartExpected = false;
      return startPipeline(p);
    }
    // the GPU encoder died before its first frame: not available here, use the CPU encoder from now on
    if (p === h264 && h264.encoder === "vaapi" && p.produced === 0) {
      console.error("h264_vaapi failed, switching to libx264");
      h264.encoder = "x264";
      return startPipeline(p);
    }
    console.error(`ffmpeg ${p.name} exited (code=${code}, signal=${signal}) -- restarting in 1s`);
    setTimeout(() => p.wanted && startPipeline(p), 1000);
  });
  p.proc = proc;
}

function stopPipeline(p) {
  p.wanted = false;
  if (p.proc) p.proc.kill("SIGTERM");
}

// after a resize: ffmpeg's capture size is fixed when it starts
function restartPipelines() {
  for (const p of [jpeg, h264, av]) {
    if (!p.proc) continue;
    p.restartExpected = true;
    p.proc.kill("SIGTERM");
  }
}

// nobody asked for frames for a while (tab closed, switched to the other mode): stop encoding
setInterval(() => {
  if (avSockets.size > 0) av.lastPoll = Date.now();
  for (const p of [jpeg, h264, av]) if (p.wanted && Date.now() - p.lastPoll > PIPELINE_IDLE_MS && p.waiters.size === 0) stopPipeline(p);
}, 3000);

// ffmpeg's MPEG-TS: whole 188-byte packets, collected per read into chunks. A chunk remembers where a video packet starts a
// picture that carries a sequence header (every keyframe has one): a client that falls behind starts again from there.
function tsGopOffset(data) {
  for (let o = 0; o + 188 <= data.length; o += 188) {
    if (!(data[o + 1] & 0x40)) continue; // no payload unit start
    const afc = (data[o + 3] >> 4) & 3;
    const start = o + 4 + (afc & 2 ? 1 + data[o + 4] : 0);
    if (!(afc & 1) || start + 4 > o + 188) continue;
    if (data[start] !== 0 || data[start + 1] !== 0 || data[start + 2] !== 1 || (data[start + 3] & 0xf0) !== 0xe0) continue;
    const payload = data.subarray(start, o + 188);
    for (let i = 4; i + 3 < payload.length; i++) {
      if (payload[i] === 0 && payload[i + 1] === 0 && payload[i + 2] === 1 && payload[i + 3] === 0xb3) return o;
    }
  }
  return -1;
}

function parseTsChunk(chunk) {
  av.buffer = av.buffer.length ? Buffer.concat([av.buffer, chunk]) : chunk;
  if (av.buffer[0] !== 0x47) {
    const sync = av.buffer.indexOf(0x47);
    av.buffer = sync === -1 ? Buffer.alloc(0) : av.buffer.subarray(sync);
  }
  // a chunk ends right before a packet that starts a new PES packet: every frame in it is complete, so the page can tell
  // each picture and each piece of sound by its own timestamp, also after a jump
  let whole = 0;
  for (let o = 188; o + 188 <= av.buffer.length; o += 188) if (av.buffer[o + 1] & 0x40) whole = o;
  if (whole === 0) return;
  const data = Buffer.from(av.buffer.subarray(0, whole));
  av.buffer = av.buffer.subarray(whole);
  av.produced++;
  const now = Date.now();
  av.chunks.push({ seq: ++av.seq, t: now, data, gop: tsGopOffset(data) });
  pushToSockets();
  // keep a few seconds, and always the newest starting point
  let lastGop = -1;
  for (let i = av.chunks.length - 1; i >= 0; i--) if (av.chunks[i].gop >= 0) { lastGop = i; break; }
  let drop = 0;
  while (drop < av.chunks.length - 1 && now - av.chunks[drop].t > AV_KEEP_MS && (lastGop === -1 || drop < lastGop)) drop++;
  if (drop) av.chunks.splice(0, drop);
  wake(av);
}

// What a client that has everything up to `after` gets next: the chunks after it, or - when it is new, missed chunks or is
// more than AV_MAX_BEHIND_MS behind - everything from the newest starting point.
function avDataFor(after) {
  const chunks = av.chunks;
  if (chunks.length === 0 || chunks[chunks.length - 1].seq <= after) return null;
  const next = chunks.findIndex((c) => c.seq > after);
  const newest = chunks[chunks.length - 1];
  if (after > 0 && chunks[next].seq === after + 1 && newest.t - chunks[next].t <= AV_MAX_BEHIND_MS) {
    return { jump: false, seq: newest.seq, parts: chunks.slice(next).map((c) => c.data) };
  }
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i].gop < 0) continue;
    if (chunks[i].seq <= after && after > 0) return null; // it already has the newest starting point: wait for more
    return { jump: true, seq: newest.seq, parts: [chunks[i].data.subarray(chunks[i].gop), ...chunks.slice(i + 1).map((c) => c.data)] };
  }
  return null;
}

// ffmpeg's mpjpeg output: "Content-type: image/jpeg\r\nContent-length: N\r\n\r\n<N bytes>" parts
const HEADER_RE = /Content-type: image\/jpeg\r\nContent-length: (\d+)\r\n\r\n/i;
function parseJpegChunk(chunk) {
  jpeg.buffer = jpeg.buffer.length ? Buffer.concat([jpeg.buffer, chunk]) : chunk;
  for (;;) {
    const match = HEADER_RE.exec(jpeg.buffer.toString("latin1", 0, Math.min(jpeg.buffer.length, 256)));
    if (!match) {
      if (jpeg.buffer.length > 256) jpeg.buffer = jpeg.buffer.subarray(jpeg.buffer.length - 256);
      return;
    }
    const headerEnd = match.index + match[0].length;
    const length = parseInt(match[1], 10);
    if (jpeg.buffer.length < headerEnd + length) return;
    const frame = Buffer.from(jpeg.buffer.subarray(headerEnd, headerEnd + length));
    jpeg.buffer = jpeg.buffer.subarray(headerEnd + length);
    jpeg.produced++;
    // the encoder is deterministic: an unchanged screen gives the same bytes, and that is no new frame
    if (jpeg.frame && jpeg.frame.equals(frame)) continue;
    jpeg.frame = frame;
    jpeg.seq++;
    wake(jpeg);
  }
}

// ffmpeg's raw H.264 (Annex B): NAL units behind 00 00 01 start codes, every access unit (frame) opened by an AUD (type 9).
// A frame is complete when the next AUD arrives, so it goes out one frame late (1/TARGET_FPS s) - the price for knowing where
// it ends.
const START_CODE = Buffer.from([0, 0, 1]);
const START_CODE_4 = Buffer.from([0, 0, 0, 1]);
function parseH264Chunk(chunk) {
  let buf = h264.buffer.length ? Buffer.concat([h264.buffer, chunk]) : chunk;
  let at = buf.indexOf(START_CODE);
  if (at < 0) {
    h264.buffer = buf;
    return;
  }
  for (;;) {
    const next = buf.indexOf(START_CODE, at + 3);
    if (next < 0) break;
    // a 4-byte start code's leading zero is not part of the NAL before it
    const end = next > 0 && buf[next - 1] === 0 ? next - 1 : next;
    onNal(Buffer.from(buf.subarray(at + 3, end)));
    at = next;
  }
  h264.buffer = buf.subarray(at);
}

function onNal(nal) {
  if (!nal.length) return;
  const type = nal[0] & 0x1f;
  if (type === 9) {
    if (h264.au.some((n) => (n[0] & 0x1f) >= 1 && (n[0] & 0x1f) <= 5)) emitAccessUnit(h264.au);
    h264.au = [];
    return;
  }
  if (type === 7) {
    h264.sps = nal;
    h264.codec = `avc1.${[nal[1], nal[2], nal[3]].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  if (type === 8) h264.pps = nal;
  h264.au.push(nal);
}

function emitAccessUnit(nals) {
  const key = nals.some((n) => (n[0] & 0x1f) === 5);
  // a keyframe has to carry SPS/PPS itself: it is where a decoder starts
  if (key && !nals.some((n) => (n[0] & 0x1f) === 7) && h264.sps && h264.pps) nals = [h264.sps, h264.pps, ...nals];
  const data = Buffer.concat(nals.flatMap((n) => [START_CODE_4, n]));
  h264.produced++;
  h264.frames.push({ seq: ++h264.seq, key, data });
  // keep the newest keyframe and everything after it, and at least 2 s
  const lastKey = h264.frames.findLastIndex((f) => f.key);
  const keepFrom = Math.max(0, Math.min(lastKey < 0 ? 0 : lastKey, h264.frames.length - 2 * TARGET_FPS));
  if (keepFrom > 0) h264.frames.splice(0, keepFrom);
  wake(h264);
}

// The H.264 frames a client needs after `after`: the next ones in order, or - for a new client, a new epoch, or one too far
// behind - everything from the newest keyframe on.
function h264FramesFor(after, epoch) {
  const frames = h264.frames;
  if (!frames.length || !h264.codec) return [];
  const latest = frames[frames.length - 1].seq;
  if (after >= latest && epoch === h264.epoch) return [];
  const continuing = epoch === h264.epoch && frames[0].seq <= after + 1 && latest - after <= H264_MAX_LAG;
  if (continuing) return frames.filter((f) => f.seq > after);
  const lastKey = frames.findLastIndex((f) => f.key);
  if (lastKey < 0) return [];
  // the newest keyframe is not newer than what the client has: wait for the next one rather than going back in time
  if (epoch === h264.epoch && frames[lastKey].seq <= after) return [];
  if (epoch === h264.epoch && after >= 0) noteH264Skip();
  return frames.slice(lastKey);
}

// Waits until `ready()` returns something or FRAME_WAIT_MS passes; answers 204 then. Ends early if the client goes away.
function longPoll(p, req, res, ready, send) {
  p.lastPoll = Date.now();
  const now = ready();
  if (now) return send(now);
  let done = false;
  const finish = (value) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    p.waiters.delete(check);
    p.lastPoll = Date.now();
    if (value) send(value);
    else if (!res.writableEnded) res.status(204).end();
  };
  const check = () => {
    const value = ready();
    if (value) finish(value);
  };
  const timer = setTimeout(() => finish(null), FRAME_WAIT_MS);
  p.waiters.add(check);
  req.on("close", () => finish(null));
}

// --- Pointer and mouse: one long-running xhelper (xhelper.c) instead of an xdotool process per event, and the source of the
// pointer's shape for the browser. xdotool stays for the keyboard (its `type` handles any Unicode text). ---
let helper = null;
let cursor = null; // {version, serial, w, h, xhot, yhot, rgba}
let cursorVersion = 0;
const cursorWaiters = makePipeline("cursor"); // only its waiters/lastPoll are used

// German characters on spare keys (unused multimedia keycodes) of the US keymap. Without them `xdotool type` remaps a scratch
// key for every ä/ö/ü/ß/€ on the fly, and Chrome sometimes reads the key before the new mapping: about one word in six lost a
// character. Free keycodes stay free for xdotool's on-the-fly mapping of rarer characters. Runs with every helper start,
// which follows every Xvfb (re)start, since a new X server starts with the plain keymap.
const GERMAN_KEYS = [
  "keycode 189 = adiaeresis Adiaeresis",
  "keycode 191 = odiaeresis Odiaeresis",
  "keycode 192 = udiaeresis Udiaeresis",
  "keycode 193 = ssharp U1E9E",
  "keycode 194 = EuroSign section",
  "keycode 195 = degree mu",
  "keycode 196 = twosuperior threesuperior",
];

let germanKeysAt = 0;
// Once seen lost right after the very first start (some X client reset the keymap), so it is also re-applied before typing
// such characters, at most every 10 s; it is idempotent and takes a few ms.
async function ensureGermanKeys(force = false) {
  if (!force && Date.now() - germanKeysAt < 10000) return;
  germanKeysAt = Date.now();
  await execFilePromise("xmodmap", GERMAN_KEYS.flatMap((line) => ["-e", line])).catch((e) => console.error(`xmodmap failed: ${e.message}`));
}

function startHelper() {
  ensureGermanKeys(true);
  let out = "";
  const proc = spawn(path.join(__dirname, "xhelper"), [], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
  proc.stdout.on("data", (d) => {
    out += d.toString("latin1");
    let nl;
    while ((nl = out.indexOf("\n")) >= 0) {
      const line = out.slice(0, nl);
      out = out.slice(nl + 1);
      const [tag, serial, w, h, xhot, yhot, rgba = ""] = line.split(" ");
      if (tag !== "C") continue;
      cursor = { version: ++cursorVersion, serial: Number(serial), w: Number(w), h: Number(h), xhot: Number(xhot), yhot: Number(yhot), rgba };
      wake(cursorWaiters);
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write(`[xhelper] ${d}`));
  proc.stdin.on("error", () => {});
  proc.on("error", (e) => console.error(`xhelper failed to start: ${e.message}`));
  proc.on("exit", (code) => {
    if (helper === proc) helper = null;
    console.error(`xhelper exited (code=${code}) -- restarting in 2s`);
    setTimeout(startHelper, 2000);
  });
  helper = proc;
}

// sends lines to xhelper; without it (not built, crashed) the same through xdotool
async function pointer(lines) {
  if (helper && helper.stdin.writable) {
    helper.stdin.write(lines.join("\n") + "\n");
    return;
  }
  for (const line of lines) {
    const [op, a, b] = line.split(" ");
    if (op === "m") await xdotool(["mousemove", a, b]);
    else if (op === "d") await xdotool(["mousedown", a]);
    else if (op === "u") await xdotool(["mouseup", a]);
    else if (op === "c") await xdotool(["click", "--repeat", b, a]);
  }
}

// --- Audio out: Chrome's audio (default sink "chrome_out", see
// seedPulseSystemConfig) captured live and served as Ogg/Opus over plain
// HTTP -- GET /audio. Same principle as the video relay above (never
// blindly forward a source byte stream to a client with no priming), but
// the reframing unit here is an Ogg *page*, not an MJPEG part: any client
// that starts receiving mid-stream without first getting the initial pages
// (OpusHead + OpusTags) can't initialize its decoder at all, so those first
// pages are cached and replayed to every new client before it joins the
// live broadcast. Push-based broadcast (not the video relay's pull-based
// per-client loop) is the right tradeoff here -- some client-side audio
// buffering is normal/expected for a "listen along" stream, unlike the
// video path's deliberate low-latency/no-backlog requirement for mouse
// control responsiveness. ---

const OGG_HEADER_PAGE_COUNT = 2; // OpusHead + OpusTags, always exactly 2 for a fresh Opus stream
let oggHeaderPages = []; // cached raw bytes of the first 2 pages, replayed to every new listener
let oggBuffer = Buffer.alloc(0);
const audioListeners = new Set(); // Set<express.Response>
// A listener connecting in the brief window before ffmpeg has produced its
// first 2 pages yet would otherwise get an empty header replay and never
// receive one at all (the live-broadcast branch below never sends header
// pages to `audioListeners`) -- park them here instead, flushed the instant
// headers complete.
const pendingAudioListeners = new Set();
let audioFfmpegProc = null;

function parseOggPages(chunk, onPage) {
  oggBuffer = oggBuffer.length ? Buffer.concat([oggBuffer, chunk]) : chunk;
  for (;;) {
    if (oggBuffer.length < 27) return; // minimum fixed Ogg page header size
    if (oggBuffer.toString("latin1", 0, 4) !== "OggS") {
      // Should never happen with a well-formed ffmpeg ogg stream -- resync
      // by scanning forward rather than getting stuck if it ever does.
      const nextMagic = oggBuffer.indexOf("OggS", 1, "latin1");
      if (nextMagic === -1) {
        oggBuffer = Buffer.alloc(0);
        return;
      }
      oggBuffer = oggBuffer.subarray(nextMagic);
      continue;
    }
    const segmentCount = oggBuffer[26];
    const headerLen = 27 + segmentCount;
    if (oggBuffer.length < headerLen) return; // wait for the segment table itself
    let payloadLen = 0;
    for (let i = 0; i < segmentCount; i++) payloadLen += oggBuffer[27 + i];
    const pageLen = headerLen + payloadLen;
    if (oggBuffer.length < pageLen) return; // wait for the full payload
    onPage(Buffer.from(oggBuffer.subarray(0, pageLen)));
    oggBuffer = oggBuffer.subarray(pageLen);
  }
}

function broadcastOggPage(page) {
  if (oggHeaderPages.length < OGG_HEADER_PAGE_COUNT) {
    oggHeaderPages.push(page);
    if (oggHeaderPages.length === OGG_HEADER_PAGE_COUNT) {
      for (const res of pendingAudioListeners) {
        for (const headerPage of oggHeaderPages) res.write(headerPage);
        audioListeners.add(res);
      }
      pendingAudioListeners.clear();
    }
    return; // header pages are sent to listeners as they join, not live-broadcast
  }
  for (const res of audioListeners) res.write(page);
}

function startAudioCapture() {
  const args = [
    "-loglevel", "error",
    "-f", "pulse",
    "-i", "chrome_out.monitor",
    "-ac", "2",
    "-ar", "48000",
    "-c:a", "libopus",
    "-b:a", "96k",
    "-f", "ogg",
    "pipe:1",
  ];
  const proc = spawn("ffmpeg", args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => parseOggPages(chunk, broadcastOggPage));
  proc.stderr.on("data", (d) => process.stderr.write(`[audio-ffmpeg] ${d}`));
  proc.on("exit", (code, signal) => {
    oggBuffer = Buffer.alloc(0);
    oggHeaderPages = [];
    console.error(`audio ffmpeg exited (code=${code}, signal=${signal}) -- restarting in 1s`);
    setTimeout(startAudioCapture, 1000);
  });
  audioFfmpegProc = proc;
}

// --- Audio in: a client's real microphone, streamed here and transcoded
// into the "virtmic" named-pipe source (see seedPulseSystemConfig) so
// Chrome inside the container sees it as their default microphone.
// The client streams a live MediaRecorder(audio/webm;codecs=opus) session as
// the POST body (a genuinely long-lived streaming request, not repeated
// small POSTs -- webm chunks after the first aren't independently
// decodable, they need the original stream's header) straight into ffmpeg's
// stdin; ffmpeg writes raw PCM directly to the pipe path. Only one mic
// session makes sense at a time (there's exactly one virtual microphone) --
// a new POST simply takes over from whatever was streaming before. ---

let micFfmpegProc = null;

function stopMicCapture() {
  if (micFfmpegProc) {
    micFfmpegProc.kill("SIGTERM");
    micFfmpegProc = null;
  }
}

// Real xrandr resolution switching (not a client-side CSS scale) so the
// remote desktop's actual pixels match the viewer's window -- crisp text,
// no letterboxing. `cvt` computes a valid modeline for the target size;
// ffmpeg can't resize its capture without restarting, so that follows; the
// browser window itself is resized/repositioned to fill the new screen.
let randrOutputName = null;

async function getRandrOutputName() {
  if (randrOutputName) return randrOutputName;
  const out = await execFilePromise("xrandr", []);
  const connected = out.split("\n").find((l) => / connected/.test(l));
  randrOutputName = connected ? connected.split(" ")[0] : "screen";
  return randrOutputName;
}

async function resizeDisplay(width, height) {
  const output = await getRandrOutputName();
  const cvtOut = await execFilePromise("cvt", [String(width), String(height)]);
  const modeline = /Modeline\s+"[^"]+"\s+(.+)/.exec(cvtOut);
  if (!modeline) throw new Error("cvt produced no modeline");
  const modeParams = modeline[1].trim().split(/\s+/);
  const modeName = `custom_${width}x${height}`;

  await execFilePromise("xrandr", ["--newmode", modeName, ...modeParams]).catch(() => {});
  await execFilePromise("xrandr", ["--addmode", output, modeName]).catch(() => {});
  await execFilePromise("xrandr", ["--output", output, "--mode", modeName]);

  // cvt may round the mode; capture exactly what the screen now is (a too-large x11grab size makes ffmpeg fail)
  const current = /current (\d+) x (\d+)/.exec(await execFilePromise("xrandr", []));
  DISPLAY_WIDTH = current ? parseInt(current[1], 10) : width;
  DISPLAY_HEIGHT = current ? parseInt(current[2], 10) : height;
  restartPipelines();

  await xdotool(["getactivewindow", "windowsize", String(DISPLAY_WIDTH), String(DISPLAY_HEIGHT)]).catch(() => {});
  await xdotool(["getactivewindow", "windowmove", "0", "0"]).catch(() => {});
}

// Fluxbox's own default init config runs `fbsetbg` (an ImageMagick-backed
// wallpaper setter) on startup, which pops an error dialog on failure --
// this minimal image's ImageMagick build doesn't support the X11 root-
// window write fbsetbg needs. A plain solid color via xsetroot needs no
// such dependency, so override fluxbox's rootCommand before its first
// launch (its config dir is not on the persistent volume -- regenerated
// fresh every container start, so this must run every time, not just once).
async function seedFluxboxInit() {
  const fluxboxDir = path.join(process.env.HOME || "/root", ".fluxbox");
  await fsp.mkdir(fluxboxDir, { recursive: true });
  const initPath = path.join(fluxboxDir, "init");
  const existing = fssync.existsSync(initPath) ? await fsp.readFile(initPath, "utf8") : "";
  const withoutRootCommand = existing
    .split("\n")
    .filter((line) => !line.startsWith("session.screen0.rootCommand:") && !line.startsWith("session.screen0.toolbar.visible:"))
    .join("\n");
  // no toolbar either: it would cover the bottom edge of Chrome in the stream
  await fsp.writeFile(initPath, `${withoutRootCommand}\nsession.screen0.rootCommand: xsetroot -solid "#2b2b2b"\nsession.screen0.toolbar.visible: false\n`);
}

// Fluxbox draws its own title bar above every window by default. With
// Chrome positioned at (0,0) filling the whole Xvfb screen, that decoration
// has nowhere to go but off the top edge of the screen -- it's the "cut off
// head" at the top of the captured video. Same as seedFluxboxInit,
// this file isn't on the persistent volume and must be rewritten every
// container start.
async function seedFluxboxApps() {
  const fluxboxDir = path.join(process.env.HOME || "/root", ".fluxbox");
  await fsp.mkdir(fluxboxDir, { recursive: true });
  const appsPath = path.join(fluxboxDir, "apps");
  await fsp.writeFile(
    appsPath,
    "[app] (class=Google-chrome)\n [Deco]\t{NONE}\n[end]\n"
  );
}

// PulseAudio in --system mode (not a per-user session daemon) since
// everything in this container runs as root and there's no multi-user
// desktop to isolate -- system mode is the one PulseAudio explicitly
// supports running as root. Two virtual devices, no real sound hardware
// needed at all: "chrome_out" is a null-sink Chrome's audio defaults to
// (its .monitor is what ffmpeg captures for GET /audio), and "virtmic" is a
// module-pipe-source backed by a named pipe at MIC_FIFO_PATH -- anything
// written there (see the /audio/mic route's ffmpeg transcoder) shows up as
// live microphone input. Both are set as defaults so Chrome picks
// them up with no manual device selection. system.pa isn't on the
// persistent volume, so, like the fluxbox config, this must be (re)written
// every container start, not just once.
async function seedPulseSystemConfig() {
  const systemPaPath = "/etc/pulse/system.pa";
  const config = [
    "#!/usr/bin/pulseaudio -nF",
    "load-module module-native-protocol-unix auth-anonymous=1",
    "load-module module-null-sink sink_name=chrome_out sink_properties=device.description=ChromeOutput",
    "set-default-sink chrome_out",
    `load-module module-pipe-source source_name=virtmic file=${MIC_FIFO_PATH} format=s16le rate=48000 channels=2 source_properties=device.description=VirtualMicrophone`,
    "set-default-source virtmic",
    "",
  ].join("\n");
  await fsp.mkdir(path.dirname(systemPaPath), { recursive: true });
  await fsp.writeFile(systemPaPath, config);
  await fsp.mkdir(path.dirname(PULSE_SOCKET), { recursive: true }).catch(() => {});
  // PulseAudio's module-pipe-source runs as the "pulse" system user (not
  // root) and mkfifo()s this path itself -- needs the directory writable by
  // that user, but NOT the sticky bit (0o755 caused a plain mkfifo
  // "Permission denied" from pulseaudio itself; adding the sticky bit
  // instead of avoiding it would just reintroduce the fs.protected_fifos
  // issue this directory exists to sidestep in the first place). mkdir's
  // own `mode` option is masked by the process umask, so chmod explicitly
  // afterward to guarantee 0o777 regardless of umask.
  await fsp.mkdir(MIC_FIFO_DIR, { recursive: true });
  await fsp.chmod(MIC_FIFO_DIR, 0o777);
}

async function initDesktop() {
  await fsp.mkdir(PROFILE_DIR, { recursive: true });
  await fsp.mkdir(SHARED_DIR, { recursive: true });
  await fsp.mkdir(UPLOAD_TMP_DIR, { recursive: true });
  await clearStaleChromeLock();
  await seedChromePreferences();

  await seedPulseSystemConfig();
  spawnPersistent("pulseaudio", "pulseaudio", ["--system", "--disallow-exit", "--exit-idle-time=-1"]);
  await waitForPulseSocket();

  spawnPersistent("Xvfb", "Xvfb", [DISPLAY, "-screen", "0", `${DISPLAY_WIDTH}x${DISPLAY_HEIGHT}x24`, "-nolisten", "tcp", "-ac"], clearStaleXvfbLock);
  await waitForX11Socket();

  await seedFluxboxInit();
  await seedFluxboxApps();
  spawnPersistent("fluxbox", "fluxbox", []);
  await new Promise((r) => setTimeout(r, 1000));

  // No --enable-automation -- a normal Chrome launch. The debugging port only listens inside the container and is used for
  // one thing: asking the focused tab whether a text field has the focus (see "Text field focus" below), so the car's
  // on-screen keyboard can open and close by itself. No domains are enabled on the pages, nothing is injected.
  //
  // GPU flags below hand rendering to the passed-through iGPU (/dev/dri)
  // instead of Chrome's software rasterizer (SwiftShader) -- Xvfb has no
  // GPU of its own, so Chrome must be told explicitly to use the real
  // device via EGL/Mesa rather than falling back to software. This only
  // affects how Chrome renders internally; ffmpeg's x11grab capture of the
  // resulting X11 framebuffer, and the MJPEG streaming pipeline, are
  // unaffected either way.
  spawnPersistent("chrome", "google-chrome", [
    `--user-data-dir=${PROFILE_DIR}`,
    "--no-sandbox", // required running as root in a container; unrelated to automation flagging
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    `--lang=${CHROME_LANG}`,
    "--window-position=0,0",
    `--window-size=${DISPLAY_WIDTH},${DISPLAY_HEIGHT}`,
    // With a GPU passed through (/dev/dri), Chrome renders and decodes video on it; without one it falls back to software.
    ...(HAS_GPU
      ? ["--ignore-gpu-blocklist", "--disable-gpu-sandbox", "--use-gl=angle", "--use-angle=gl", "--enable-gpu-rasterization", "--enable-zero-copy", "--enable-native-gpu-memory-buffers", "--enable-features=VaapiVideoDecoder,VaapiVideoEncoder"]
      : []),
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${CDP_PORT}`,
    "about:blank",
  ], () => { clearStaleChromeLockSync(); clearChromeMetrics(); });

  startHelper();
  startAudioCapture();
}

// --- Text field focus: whether the user is typing into a field in Chrome right now. Polled a few times a second over the
// local debugging port while a page is watching (/focus), with one plain Runtime.evaluate per tab and no enabled domains.
// null = unknown (a field inside a frame from another site): the page leaves its keyboard as it is then. ---
const CDP_PORT = 9222;
const FOCUS_EXPR = `(() => {
  if (!document.hasFocus()) return false;
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  if (e && e.tagName === "IFRAME") { try { e = e.contentDocument.activeElement; } catch (x) { return null; } }
  if (!e) return false;
  if (e.isContentEditable) return true;
  if (e.tagName === "TEXTAREA") return !e.readOnly && !e.disabled;
  if (e.tagName === "INPUT") {
    const t = (e.type || "text").toLowerCase();
    return !e.readOnly && !e.disabled && ["text", "search", "email", "url", "tel", "password", "number"].includes(t);
  }
  return false;
})()`;
const focusState = { editable: false, version: 0, lastPoll: 0 };
const focusWaiters = makePipeline("focus"); // only its waiters/lastPoll are used
const cdpTabs = new Map(); // target id -> {ws, nextId, pending}

function cdpTab(target) {
  let tab = cdpTabs.get(target.id);
  if (tab) return tab;
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  tab = { ws, nextId: 1, pending: new Map(), open: false };
  ws.on("open", () => (tab.open = true));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const done = tab.pending.get(msg.id);
    if (done) { tab.pending.delete(msg.id); done(msg); }
  });
  const drop = () => { cdpTabs.delete(target.id); for (const done of tab.pending.values()) done({}); tab.pending.clear(); };
  ws.on("close", drop);
  ws.on("error", drop);
  cdpTabs.set(target.id, tab);
  return tab;
}

function cdpEvaluate(tab, expression) {
  if (!tab.open) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const id = tab.nextId++;
    const timer = setTimeout(() => { tab.pending.delete(id); resolve(undefined); }, 800);
    tab.pending.set(id, (msg) => { clearTimeout(timer); resolve(msg.result?.result?.value); });
    tab.ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
}

async function pollFocus() {
  if (Date.now() - focusState.lastPoll > 20000) return; // nobody watching
  let targets;
  try {
    targets = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  } catch {
    return;
  }
  for (const id of cdpTabs.keys()) if (!targets.some((t) => t.id === id)) { cdpTabs.get(id).ws.close(); cdpTabs.delete(id); }
  const answers = await Promise.all(targets.map((t) => cdpEvaluate(cdpTab(t), FOCUS_EXPR)));
  const editable = answers.includes(true) ? true : answers.includes(null) ? null : false;
  if (editable !== focusState.editable) {
    focusState.editable = editable;
    focusState.version++;
    wake(focusWaiters);
  }
}
setInterval(() => pollFocus().catch(() => {}), 300);

const app = express();

// --- Login: HTTP Basic Auth on everything except /healthz (also on the WebSocket upgrade, which bypasses Express). ---
const AUTH_USER = process.env.AUTH_USER || "cinema";
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || "";
if (!AUTH_PASSWORD && process.env.ALLOW_NO_AUTH !== "1") {
  console.error("AUTH_PASSWORD is not set. TeslaCinema gives full control of a browser, so it refuses to start without a login.");
  console.error("Set AUTH_PASSWORD in .env (setup.sh does that for you), or set ALLOW_NO_AUTH=1 if something else in front of it does the login.");
  process.exit(1);
}
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
function authorized(req) {
  if (!AUTH_PASSWORD) return true;
  const m = /^Basic (.+)$/i.exec(req.headers.authorization || "");
  if (!m) return false;
  const decoded = Buffer.from(m[1], "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  // compare hashes, so length and content leak nothing through timing
  const userOk = crypto.timingSafeEqual(sha(decoded.slice(0, i)), sha(AUTH_USER));
  const passOk = crypto.timingSafeEqual(sha(decoded.slice(i + 1)), sha(AUTH_PASSWORD));
  return userOk && passOk;
}
function denyHeaders() {
  return { "WWW-Authenticate": 'Basic realm="TeslaCinema", charset="UTF-8"', "Content-Type": "text/plain", "Cache-Control": "no-store" };
}
app.use((req, res, next) => {
  if (req.path === "/healthz" || authorized(req)) return next();
  // a short pause per failed attempt makes guessing the password slow
  setTimeout(() => {
    res.writeHead(401, denyHeaders());
    res.end("Login required");
  }, 800);
});
app.use((req, res, next) => (req.path === "/clipboard" ? next() : express.json()(req, res, next)));
// long polls and streams must reach the client as they are: tells a reverse proxy like nginx (NPM) not to buffer them
app.use((req, res, next) => {
  res.setHeader("X-Accel-Buffering", "no");
  next();
});
const upload = multer({ dest: UPLOAD_TMP_DIR });

app.get("/", (req, res) => {
  res.sendFile(__dirname + "/static/index.html");
});
app.use("/static", express.static(__dirname + "/static"));

app.get("/info", (req, res) => {
  res.json({ width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, fps: TARGET_FPS, encoder: h264.encoder, h264Step: H264_STEPS[h264.step].join("/"), h264Seq: h264.seq, jpegSeq: jpeg.seq });
});

app.post("/resize", async (req, res) => {
  // the H.264 encoders want even sizes; widths in steps of 8 match what cvt produces anyway
  const width = Math.max(320, Math.min(3840, parseInt(req.body?.width, 10) || DISPLAY_WIDTH)) & ~7;
  const height = Math.max(240, Math.min(2160, parseInt(req.body?.height, 10) || DISPLAY_HEIGHT)) & ~1;
  if (width === DISPLAY_WIDTH && height === DISPLAY_HEIGHT) {
    return res.json({ ok: true, width, height, changed: false });
  }
  try {
    await resizeDisplay(width, height);
    res.json({ ok: true, width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT, changed: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// The newest JPEG frame once it is newer than `after` (X-Seq tells its number).
app.get("/video/jpeg", (req, res) => {
  const after = parseInt(req.query.after, 10) || 0;
  startPipeline(jpeg);
  longPoll(jpeg, req, res, () => jpeg.frame && jpeg.seq > after && { frame: jpeg.frame, seq: jpeg.seq }, ({ frame, seq }) => {
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": frame.length, "X-Seq": String(seq), "Cache-Control": "no-store" });
    res.end(frame);
  });
});

// H.264 frames after `after` of encoder run `epoch`, as one binary answer: per frame a 4-byte seq, a 1-byte keyframe flag, a
// 4-byte length and the Annex B data. X-Codec / X-Epoch / X-Width / X-Height describe the stream; a client whose epoch differs
// gets everything from the newest keyframe and has to configure a new decoder.
app.get("/video/h264", (req, res) => {
  const after = parseInt(req.query.after, 10);
  const epoch = parseInt(req.query.epoch, 10);
  startPipeline(h264);
  longPoll(h264, req, res, () => {
    const frames = h264FramesFor(Number.isNaN(after) ? -1 : after, Number.isNaN(epoch) ? -1 : epoch);
    return frames.length > 0 && frames;
  }, (frames) => {
    const parts = [];
    for (const f of frames) {
      const head = Buffer.alloc(9);
      head.writeUInt32BE(f.seq, 0);
      head.writeUInt8(f.key ? 1 : 0, 4);
      head.writeUInt32BE(f.data.length, 5);
      parts.push(head, f.data);
    }
    const body = Buffer.concat(parts);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Codec": h264.codec,
      "X-Epoch": String(h264.epoch),
      "X-Width": String(h264.width),
      "X-Height": String(h264.height),
      "X-Encoder": h264.encoder,
      "X-Bitrate": H264_STEPS[h264.step][0],
    });
    res.end(body);
  });
});

// The same stream pushed over a WebSocket (only the Tesla page uses it; the polling below stays as the fallback): every chunk
// goes out the moment it exists, with no request in between. A client whose socket backs up (a slow line) gets nothing
// until it has drained, then continues from the newest keyframe, so delay never piles up.
const AV_SOCKET_BACKLOG = 256 * 1024;
const avSockets = new Set(); // {ws, after}
function pushToSockets() {
  if (avSockets.size === 0) return;
  av.lastPoll = Date.now();
  for (const client of avSockets) {
    if (client.ws.readyState !== 1) continue;
    if (client.ws.bufferedAmount > AV_SOCKET_BACKLOG) {
      client.behind = true;
      continue;
    }
    // after a backlog: start again at a keyframe (avDataFor jumps when chunks were missed)
    const next = avDataFor(client.behind ? 0 : client.after);
    if (!next) continue;
    client.behind = false;
    client.after = next.seq;
    client.ws.send(next.parts.length === 1 ? next.parts[0] : Buffer.concat(next.parts));
  }
}
const avWss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
avWss.on("connection", (ws) => {
  const client = { ws, after: 0, behind: false };
  avSockets.add(client);
  startPipeline(av);
  pushToSockets();
  ws.on("close", () => avSockets.delete(client));
  ws.on("error", () => avSockets.delete(client));
});

// The MPEG-TS stream (see "Picture and sound together"): everything after chunk `after` as one answer, X-Seq tells the
// newest chunk in it, X-Jump that it starts at a fresh keyframe instead of continuing.
app.get("/av", (req, res) => {
  const after = parseInt(req.query.after, 10) || 0;
  startPipeline(av);
  longPoll(av, req, res, () => avDataFor(after), ({ jump, seq, parts }) => {
    const body = Buffer.concat(parts);
    res.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": body.length, "Cache-Control": "no-store", "X-Seq": String(seq), "X-Jump": jump ? "1" : "0" });
    res.end(body);
  });
});

// Whether a text field has the focus in Chrome, once it differs from version `after`: {version, editable (true/false/null)}.
app.get("/focus", (req, res) => {
  const after = parseInt(req.query.after, 10) || 0;
  focusState.lastPoll = Date.now();
  longPoll(focusWaiters, req, res, () => focusState.version > after && { version: focusState.version, editable: focusState.editable }, (s) => {
    focusState.lastPoll = Date.now();
    res.json(s);
  });
});

// The pointer's current shape once it differs from version `after`: {version, w, h, xhot, yhot, rgba (hex)}.
app.get("/cursor", (req, res) => {
  const after = parseInt(req.query.after, 10) || 0;
  longPoll(cursorWaiters, req, res, () => cursor && cursor.version > after && cursor, (c) => res.json(c));
});

// Live audio out (Chrome's sound) -- see the "Audio out" block above for the
// header-priming rationale. Every new listener gets the cached OpusHead/
// OpusTags pages first, then joins the live broadcast set.
app.get("/audio", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "audio/ogg",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
  });
  if (oggHeaderPages.length === OGG_HEADER_PAGE_COUNT) {
    for (const page of oggHeaderPages) res.write(page);
    audioListeners.add(res);
  } else {
    pendingAudioListeners.add(res); // flushed by broadcastOggPage once headers complete
  }
  req.on("close", () => {
    audioListeners.delete(res);
    pendingAudioListeners.delete(res);
  });
});

// Microphone in -- see the "Audio in" block above. Deliberately NOT behind
// express.json() (that middleware only touches application/json bodies by
// default, so this raw audio/webm body passes through untouched). The
// request stays open for as long as the client keeps streaming; ffmpeg's
// stdin ends (and the transcoder exits) when the client stops.
app.post("/audio/mic", (req, res) => {
  stopMicCapture();
  const proc = spawn(
    "ffmpeg",
    ["-y", "-loglevel", "error", "-f", "webm", "-i", "pipe:0", "-ac", "2", "-ar", "48000", "-f", "s16le", MIC_FIFO_PATH],
    { env: childEnv, stdio: ["pipe", "ignore", "pipe"] }
  );
  proc.stderr.on("data", (d) => process.stderr.write(`[mic-ffmpeg] ${d}`));
  micFfmpegProc = proc;
  // `.pipe()` ends proc.stdin (EOF) once req finishes -- that alone is
  // enough for ffmpeg to flush whatever it's still decoding and exit on its
  // own; don't SIGTERM it right when the request body ends, that killed it
  // mid-flush and dropped nearly everything still buffered (caught via a
  // real test: a throttled-but-finite upload only ever produced ~29 bytes
  // of PCM out of an expected ~500KB+ until this was fixed).
  req.pipe(proc.stdin);
  req.on("close", () => {
    if (!res.headersSent) res.json({ ok: true });
  });
  proc.on("exit", () => {
    if (micFfmpegProc === proc) micFfmpegProc = null;
  });
});

const NAMED_KEY_TO_XDOTOOL = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Insert: "Insert",
  F1: "F1",
  F2: "F2",
  F3: "F3",
  F4: "F4",
  F5: "F5",
  F6: "F6",
  F7: "F7",
  F8: "F8",
  F9: "F9",
  F10: "F10",
  F11: "F11",
  F12: "F12",
};
const MODIFIER_TO_XDOTOOL = { Control: "ctrl", Meta: "super", Alt: "alt", Shift: "shift" };

const BUTTONS = { left: 1, middle: 2, right: 3 };

function xdotoolKeyCombo(key) {
  // "Control+Shift+T"-style combo strings (see static/index.html) split
  // into xdotool's lowercase-modifier "ctrl+shift+t" syntax. Critically,
  // a bare letter must be lowercased unless "Shift" is explicitly one of
  // the parts: X11 keysym "A" *is* shift+a, so "ctrl+A" from xdotool's
  // perspective means Ctrl+Shift+a, not plain Ctrl+A -- the client
  // already adds an explicit "Shift" part when it means to shift.
  return key
    .split("+")
    .map((p) => MODIFIER_TO_XDOTOOL[p] || NAMED_KEY_TO_XDOTOOL[p] || (p.length === 1 ? p.toLowerCase() : p))
    .join("+");
}

// All input in one ordered batch: the client keeps a single request in flight and collects what happens meanwhile (moves
// merged into the newest one, typed characters into one string), so input can never pile up behind a slow connection.
// Events: {t:"move",x,y} {t:"down",x,y,b} {t:"up",b} {t:"wheel",dx,dy} {t:"key",key} {t:"type",text}
app.post("/input", async (req, res) => {
  const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 500) : [];
  try {
    for (const e of events) {
      const button = BUTTONS[e.b] || 1;
      if (e.t === "move") await pointer([`m ${e.x | 0} ${e.y | 0}`]);
      else if (e.t === "down") await pointer([`m ${e.x | 0} ${e.y | 0}`, `d ${button}`]);
      else if (e.t === "up") await pointer([`u ${button}`]);
      else if (e.t === "wheel") {
        const lines = [];
        const steps = (d) => Math.min(10, Math.max(1, Math.round(Math.abs(d) / 50)));
        if (Math.abs(e.dy || 0) >= 1) lines.push(`c ${e.dy > 0 ? 5 : 4} ${steps(e.dy)}`);
        if (Math.abs(e.dx || 0) >= 1) lines.push(`c ${e.dx > 0 ? 7 : 6} ${steps(e.dx)}`);
        if (lines.length) await pointer(lines);
      } else if (e.t === "key" && typeof e.key === "string") await xdotool(["key", xdotoolKeyCombo(e.key)]);
      else if (e.t === "type" && typeof e.text === "string" && e.text) {
        if (/[^\x00-\x7f]/.test(e.text)) await ensureGermanKeys();
        await xdotool(["type", "--", e.text]);
      }
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// --- Shared folder: the one universal answer to both upload and download
// for a full desktop (no per-app hook like Playwright's filechooser exists
// generically across arbitrary native dialogs) -- point any file dialog at
// this folder, and downloads land here automatically (see
// seedChromePreferences). ---

app.get("/files", async (req, res) => {
  const entries = await fsp.readdir(SHARED_DIR, { withFileTypes: true });
  const files = await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e) => {
        const stat = await fsp.stat(path.join(SHARED_DIR, e.name));
        return { name: e.name, size: stat.size, mtime: stat.mtimeMs };
      })
  );
  res.json(files.sort((a, b) => b.mtime - a.mtime));
});

app.get("/files/:name", (req, res) => {
  const name = req.params.name;
  if (name.includes("/") || name.includes("..")) return res.status(400).end();
  res.download(path.join(SHARED_DIR, name));
});

app.post("/files", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "keine Datei" });
  try {
    const dest = path.join(SHARED_DIR, req.file.originalname);
    await fsp.rename(req.file.path, dest);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// --- Clipboard sync: the X CLIPBOARD selection of the remote desktop, read and
// written as UTF-8 text so the client can mirror it with the browser's own
// clipboard (see syncClipboard in static/index.html). ---

app.get("/clipboard", async (req, res) => {
  try {
    const text = await execFilePromise("xclip", ["-selection", "clipboard", "-o"]).catch(() => "");
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/clipboard", express.json({ limit: "5mb" }), (req, res) => {
  const text = typeof req.body?.text === "string" ? req.body.text : null;
  if (text === null) return res.status(400).json({ error: "text fehlt" });
  // xclip forks into the background as the selection owner and keeps its
  // inherited pipes open, so stdout/stderr are not piped: answer when the
  // foreground process exits instead of waiting for the pipes to close.
  const child = spawn("xclip", ["-selection", "clipboard", "-i"], { env: childEnv, stdio: ["pipe", "ignore", "ignore"] });
  child.on("error", (err) => res.status(500).json({ error: err.message }));
  child.on("exit", (code) => (code === 0 ? res.json({ ok: true }) : res.status(500).json({ error: `xclip exit ${code}` })));
  child.stdin.end(text, "utf8");
});

app.get("/healthz", (req, res) => res.send("ok"));

initDesktop()
  .then(() => {
    const server = app.listen(PORT, () => console.log(`TeslaCinema listening on :${PORT} (login: ${AUTH_PASSWORD ? "user " + AUTH_USER : "DISABLED"})`));
    server.on("upgrade", (req, socket, head) => {
      if (req.url.split("?")[0] !== "/avws") return socket.destroy();
      if (!authorized(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"TeslaCinema\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return socket.destroy();
      }
      avWss.handleUpgrade(req, socket, head, (ws) => avWss.emit("connection", ws));
    });
  })
  .catch((e) => {
    console.error("Failed to start desktop:", e);
    process.exit(1);
  });
