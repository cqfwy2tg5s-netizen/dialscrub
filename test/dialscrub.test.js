'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createDialScrubber,
  createScrubAudio,
  createScrubAudioSync,
  pickAudioFormat,
} = require('../dialscrub.js');

// ---------------------------------------------------------------------------
// Controller harness: a deterministic model of an <audio> element with play,
// seek and buffering latency, driven one millisecond at a time.

function createFakeMedia({
  duration = 1500,
  playLatencyMs = 50,
  bufferedSeekMs = 40,
  networkSeekMs = 250,
  downloadSpeed = 15,
} = {}) {
  const media = {
    now: 0,
    time: 0,
    paused: true,
    appliedRate: 1,
    ready: true,
    seekDoneAt: null,
    playingAt: null,
    bufferStart: 0,
    bufferEnd: 0,
    seeks: [],
    rates: [],
    onSeeked: null,
    get seeking() {
      return media.seekDoneAt !== null;
    },
    bufferedEnd(position) {
      return position >= media.bufferStart && position <= media.bufferEnd ? media.bufferEnd : position;
    },
    seek(position) {
      const target = Math.min(duration, Math.max(0, position));
      const buffered = target >= media.bufferStart && target < media.bufferEnd - 0.05;
      media.seekDoneAt = media.now + (buffered ? bufferedSeekMs : networkSeekMs);
      if (!buffered) {
        media.bufferStart = target;
        media.bufferEnd = target;
      }
      media.time = target;
      media.seeks.push({ at: media.now, to: target });
    },
    setRate(rate) {
      media.appliedRate = rate;
      media.rates.push(rate);
    },
    play() {
      if (!media.paused) return;
      media.paused = false;
      media.playingAt = media.now + playLatencyMs;
    },
    pause() {
      media.paused = true;
      media.playingAt = null;
    },
    get audible() {
      return !media.paused && media.seekDoneAt === null && media.now >= media.playingAt;
    },
    advance() {
      media.now += 1;
      if (media.seekDoneAt !== null && media.now >= media.seekDoneAt) {
        media.seekDoneAt = null;
        media.onSeeked?.(media.now);
      }
      if (media.bufferEnd - media.time < 60) {
        media.bufferEnd = Math.min(duration, media.bufferEnd + downloadSpeed / 1000);
      }
      if (media.audible) {
        media.time = Math.min(media.bufferEnd, media.time + media.appliedRate / 1000);
      }
    },
  };
  return media;
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function detents({ from = 1000, rate, durationMs, direction = 1, jitter = 0.15, seed = 7 }) {
  const random = mulberry32(seed);
  const times = [];
  for (let time = from; time < from + durationMs;) {
    times.push({ time: Math.round(time), direction });
    time += 1000 / rate * (1 + jitter * (random() * 2 - 1) * 1.7);
  }
  return times;
}

function simulate(events, { start = 100, step = 1.25, untilMs, jumps = {}, media = createFakeMedia() } = {}) {
  const sync = createScrubAudioSync(media);
  media.onSeeked = (now) => sync.onSeeked(now);
  const samples = [];
  let head = start;
  let index = 0;
  let nextTick = 0;
  const end = untilMs ?? (events.at(-1)?.time ?? 0) + 4000;
  sync.start(head, 0);
  for (let now = 0; now <= end; now += 1) {
    media.now = now;
    while (index < events.length && events[index].time <= now) {
      const event = events[index];
      head += event.direction * (jumps[index] ?? step);
      sync.detent({ time: now, position: head, direction: event.direction, step });
      index += 1;
    }
    if (now >= nextTick) {
      sync.tick(now);
      nextTick = now + 33;
    }
    media.advance();
    samples.push({ now, head, time: media.time, audible: media.audible, rate: media.appliedRate });
  }
  return { sync, media, samples, head };
}

const during = (samples, from, to) => samples.filter((sample) => sample.now >= from && sample.now <= to);
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

test('parks the audio at the scrub start without playing', () => {
  const { media, samples } = simulate([], { start: 321, untilMs: 1000 });
  assert.equal(media.seeks.length, 1);
  assert.equal(media.seeks[0].to, 321);
  assert.ok(samples.every((sample) => !sample.audible));
});

test('follows steady turning at the dial tempo without running ahead of the scrub head', () => {
  const events = detents({ rate: 2, durationMs: 20000 });
  const { samples } = simulate(events);
  const steady = during(samples, 3000, events.at(-1).time);
  const playing = steady.filter((sample) => sample.audible);
  assert.ok(playing.length / steady.length > 0.97, 'audio plays continuously while the dial turns');
  assert.ok(Math.abs(mean(playing.map((sample) => sample.rate)) - 2.5) < 0.2, 'rate matches 2 detents/s x 1.25 s');
  const lead = Math.max(...playing.map((sample) => sample.time - sample.head));
  assert.ok(lead < 0.1, `audio never plays past the scrub head (lead ${lead.toFixed(3)}s)`);
  const lag = mean(steady.map((sample) => sample.head - sample.time));
  assert.ok(lag > 0 && lag < 2, `audio trails by about one detent (lag ${lag.toFixed(2)}s)`);
});

test('plays slow turning at a matching slow rate', () => {
  const events = detents({ rate: 0.5, durationMs: 20000 });
  const { samples } = simulate(events);
  const playing = during(samples, 5000, events.at(-1).time).filter((sample) => sample.audible);
  const rate = mean(playing.map((sample) => sample.rate));
  assert.ok(rate >= 0.5 && rate < 0.8, `slow rate ${rate.toFixed(2)}`);
});

test('never exceeds 3.5x and jumps ahead when the dial outruns it', () => {
  const events = detents({ rate: 6, durationMs: 15000 });
  const { media, samples } = simulate(events);
  const steady = during(samples, 3000, events.at(-1).time);
  assert.ok(Math.max(...media.rates) <= 3.5);
  assert.ok(Math.min(...media.rates) >= 0.5);
  assert.ok(media.seeks.length > 5, 'jumps forward to keep up');
  const lag = Math.max(...steady.map((sample) => sample.head - sample.time));
  assert.ok(lag < 5, `bounded lag (${lag.toFixed(2)}s)`);
  const playing = steady.filter((sample) => sample.audible);
  assert.ok(Math.abs(mean(playing.map((sample) => sample.rate)) - 3.5) < 0.01);
});

test('stops at the scrub head shortly after the dial stops', () => {
  const events = detents({ rate: 2, durationMs: 8000 });
  const last = events.at(-1).time;
  const { samples, head } = simulate(events, { untilMs: last + 3000 });
  const after = during(samples, last, last + 3000);
  const stoppedAt = after.find((sample, index) => index > 0 && !sample.audible && after[index - 1].audible);
  assert.ok(stoppedAt, 'audio stops');
  assert.ok(stoppedAt.now - last < 1200, `stops ${stoppedAt.now - last}ms after the last detent`);
  assert.ok(head - stoppedAt.time < 0.3 && head - stoppedAt.time > -0.05, `stops at the head (${(head - stoppedAt.time).toFixed(3)}s behind)`);
  assert.ok(during(samples, stoppedAt.now, last + 3000).every((sample) => !sample.audible));
});

test('stays silent while reversing, then parks at the reversed position and replays from it', () => {
  const forward = detents({ rate: 2, durationMs: 4000 });
  const reverse = detents({ from: 5500, rate: 3, durationMs: 1300, direction: -1 });
  const again = detents({ from: 7500, rate: 2, durationMs: 3000 });
  const { samples, media } = simulate([...forward, ...reverse, ...again]);
  const reversing = during(samples, reverse[0].time, reverse.at(-1).time);
  assert.ok(reversing.every((sample) => !sample.audible), 'silent from the first reverse detent');
  const parkedHead = samples.find((sample) => sample.now === again[0].time - 1).head;
  const parkSeek = media.seeks.find((seek) => seek.at > reverse.at(-1).time);
  assert.ok(parkSeek && Math.abs(parkSeek.to - parkedHead) < 0.01, 'parks at the reversed head');
  const resumed = during(samples, again[0].time, again[0].time + 600).find((sample) => sample.audible);
  assert.ok(resumed && resumed.time < parkedHead + 0.3, 'replays from the reversed position');
});

test('jumps over SponsorBlock skips instead of racing through them', () => {
  const events = detents({ rate: 2, durationMs: 12000 });
  const { media, samples } = simulate(events, { jumps: { 10: 40 } });
  const jumpTime = events[10].time;
  const skipSeek = media.seeks.find((seek) => seek.at >= jumpTime);
  assert.ok(skipSeek && skipSeek.at - jumpTime < 100, 'seeks right after the jump');
  const headBefore = samples.find((sample) => sample.now === jumpTime - 1).head;
  assert.ok(skipSeek.to > headBefore + 38, 'lands past the skipped segment');
  const heard = samples.filter((sample) => sample.audible).map((sample) => sample.time);
  assert.ok(!heard.some((time) => time > headBefore + 1 && time < headBefore + 38), 'skipped segment is not played');
});

test('stop() silences the audio immediately', () => {
  const media = createFakeMedia();
  const sync = createScrubAudioSync(media);
  sync.start(50, 0);
  for (let now = 0; now < 200; now += 1) {
    media.now = now;
    sync.tick(now);
    media.advance();
  }
  sync.detent({ time: 200, position: 51.25, direction: 1, step: 1.25 });
  for (let now = 200; now < 400; now += 1) {
    media.now = now;
    sync.tick(now);
    media.advance();
  }
  assert.equal(media.paused, false);
  sync.stop();
  assert.equal(media.paused, true);
  sync.tick(500);
  assert.equal(media.paused, true);
});

// ---------------------------------------------------------------------------
// Format selection

const format = (itag, mimeType, extra = {}) => ({
  itag,
  mimeType,
  url: `https://rr1---sn-test.googlevideo.com/videoplayback?itag=${itag}&expire=2000000000`,
  bitrate: 100000,
  ...extra,
});

test('picks the preferred audio-only Opus stream', () => {
  const response = {
    streamingData: {
      adaptiveFormats: [
        format(248, 'video/webm; codecs="vp9"'),
        format(140, 'audio/mp4; codecs="mp4a.40.2"'),
        format(251, 'audio/webm; codecs="opus"'),
        format(250, 'audio/webm; codecs="opus"', { isDrc: true }),
        format(250, 'audio/webm; codecs="opus"'),
        { itag: 249, mimeType: 'audio/webm; codecs="opus"', signatureCipher: 's=abc&url=x' },
      ],
    },
  };
  const picked = pickAudioFormat(response, { preferredItags: [250, 251, 249, 140] });
  assert.equal(picked.itag, 250);
  assert.notEqual(picked.isDrc, true);
});

test('falls back through preferences, playability and audio tracks', () => {
  const response = {
    streamingData: {
      adaptiveFormats: [
        format(251, 'audio/webm; codecs="opus"', { audioTrack: { displayName: 'German', audioIsDefault: true } }),
        format(251, 'audio/webm; codecs="opus"', { audioTrack: { displayName: 'English (original)' } }),
        format(140, 'audio/mp4; codecs="mp4a.40.2"', { audioTrack: { displayName: 'English (original)' } }),
        format(250, 'audio/webm; codecs="opus"', { drmFamilies: ['WIDEVINE'] }),
        format(249, 'audio/webm; codecs="opus"', { type: 'FORMAT_STREAM_TYPE_OTF' }),
        format(139, 'audio/mp4; codecs="mp4a.40.5"', { targetDurationSec: 5 }),
      ],
    },
  };
  const preferredItags = [250, 251, 249, 140, 139];
  const original = pickAudioFormat(response, { preferredItags });
  assert.equal(original.itag, 251);
  assert.match(original.audioTrack.displayName, /original/);
  const noWebm = pickAudioFormat(response, { preferredItags, canPlay: (type) => !type.includes('webm') });
  assert.equal(noWebm.itag, 140);
  assert.equal(pickAudioFormat({ streamingData: {} }), null);
  assert.equal(pickAudioFormat(null), null);
});

// ---------------------------------------------------------------------------
// Scrubber integration with a minimal fake YouTube page

function createFakePage({ duration = 600, currentTime = 100, fetch } = {}) {
  const dispatched = [];
  const listeners = [];
  const rect = (left, width, top = 600, height = 5) => ({
    left, width, top, height, right: left + width, bottom: top + height,
  });
  const video = { duration, currentTime, volume: 0.7, muted: false };
  const player = { classList: { contains: () => false } };
  const bar = {
    getBoundingClientRect: () => rect(12, 1176),
    dispatchEvent: (event) => dispatched.push(event),
  };
  const parts = [rect(12, 390), rect(404, 392), rect(798, 390)].map((value) => ({
    getBoundingClientRect: () => value,
  }));
  const document = {
    querySelector(selector) {
      return {
        '#movie_player': player,
        '#movie_player video': video,
        '.ytp-progress-bar': bar,
      }[selector] ?? null;
    },
    querySelectorAll(selector) {
      return selector === '.ytp-progress-list' ? parts : [];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  class FakeEvent {
    constructor(type, init) {
      Object.assign(this, init, { type });
    }
  }
  let clock = 0;
  const root = {
    document,
    PointerEvent: FakeEvent,
    MouseEvent: FakeEvent,
    performance: { now: () => clock },
    addEventListener: (type, listener) => listeners.push({ type, listener }),
    removeEventListener() {},
    console: { warn() {} },
    ...(fetch ? { fetch } : {}),
  };
  return {
    root,
    video,
    dispatched,
    listeners,
    setClock: (value) => { clock = value; },
  };
}

test('reports scrub positions and step size to the audio feed', () => {
  const page = createFakePage();
  const calls = [];
  const scrubAudio = Object.fromEntries(['begin', 'detent', 'end', 'destroy']
    .map((method) => [method, (details) => calls.push({ method, details })]));
  const scrubber = createDialScrubber(page.root, { scrubAudio });
  const step = 2.5 / 1172 * 600;

  assert.equal(scrubber.turn(1, 1000), true);
  assert.equal(scrubber.turn(1, 1400), true);
  assert.equal(scrubber.turn(-1, 1700), true);
  scrubber.finish();

  assert.deepEqual(calls.map((call) => call.method), ['begin', 'detent', 'detent', 'detent', 'end']);
  assert.equal(calls[0].details.position, 100);
  assert.equal(calls[0].details.time, 1000);
  assert.equal(calls[0].details.video, page.video);
  assert.ok(Math.abs(calls[1].details.position - (100 + step)) < 1e-9);
  assert.ok(Math.abs(calls[1].details.step - step) < 1e-9);
  assert.equal(calls[2].details.time, 1400);
  assert.ok(Math.abs(calls[3].details.position - (100 + step)) < 1e-9);
  assert.equal(calls[3].details.direction, -1);
  assert.deepEqual(page.dispatched.map((event) => event.type), [
    'pointermove', 'mousemove', 'pointerdown', 'mousedown',
    'pointermove', 'mousemove', 'pointermove', 'mousemove', 'pointermove', 'mousemove',
    'pointerup', 'mouseup',
  ]);
});

test('keeps scrubbing when the audio feed fails', () => {
  const page = createFakePage();
  const broken = () => {
    throw new Error('boom');
  };
  const scrubber = createDialScrubber(page.root, {
    scrubAudio: { begin: broken, detent: broken, end: broken, destroy: broken },
  });
  assert.equal(scrubber.turn(1), true);
  assert.equal(scrubber.turn(1), true);
  assert.equal(scrubber.finish(), true);
  assert.equal(page.dispatched.filter((event) => event.type === 'pointerup').length, 1);
});

test('scrubs without audio when the page cannot fetch', () => {
  const page = createFakePage();
  const scrubber = createDialScrubber(page.root);
  assert.equal(scrubber.turn(1), true);
  assert.equal(scrubber.finish(), true);
});

test('times detents from the keydown event', () => {
  const page = createFakePage();
  const times = [];
  const scrubber = createDialScrubber(page.root, {
    scrubAudio: {
      begin() {},
      detent: (details) => times.push(details.time),
      end() {},
      destroy() {},
    },
  });
  scrubber.install();
  const onKeyDown = page.listeners.find((entry) => entry.type === 'keydown').listener;
  const key = (name, timeStamp) => onKeyDown({
    key: name,
    timeStamp,
    preventDefault() {},
    stopImmediatePropagation() {},
  });
  page.setClock(5000);
  key('F8', 4990);
  key('F8', 1234);
  assert.deepEqual(times, [4990, 5000]);
});

// ---------------------------------------------------------------------------
// Audio feed: InnerTube request, stream selection, status and lifecycle

function createScheduler() {
  let now = 0;
  let nextId = 1;
  const tasks = new Map();
  const schedule = (callback, delay, every) => {
    const id = nextId;
    nextId += 1;
    tasks.set(id, { callback, at: now + delay, every });
    return id;
  };
  return {
    get now() {
      return now;
    },
    setTimeout: (callback, delay) => schedule(callback, delay, null),
    setInterval: (callback, delay) => schedule(callback, delay, delay),
    clearTimeout: (id) => tasks.delete(id),
    clearInterval: (id) => tasks.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let nextTask = null;
        for (const [id, task] of tasks) {
          if (task.at <= end && (!nextTask || task.at < nextTask[1].at)) nextTask = [id, task];
        }
        if (!nextTask) break;
        const [id, task] = nextTask;
        now = task.at;
        if (task.every) task.at += task.every;
        else tasks.delete(id);
        task.callback();
      }
      now = end;
    },
  };
}

class FakeAudio {
  constructor() {
    this.listeners = {};
    this.attributes = {};
    this.readyState = 0;
    this.currentTime = 0;
    this.duration = NaN;
    this.paused = true;
    this.seeking = false;
    this.ended = false;
    this.playbackRate = 1;
    this.volume = 1;
    this.muted = false;
    this.preservesPitch = false;
    this.error = null;
    this.buffered = { length: 0 };
    this.log = [];
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  emit(type) {
    for (const listener of this.listeners[type] || []) listener({ type });
  }

  canPlayType(type) {
    return /opus|mp4a/.test(type) ? 'probably' : '';
  }

  set src(value) {
    this.attributes.src = value;
  }

  get src() {
    return this.attributes.src ?? '';
  }

  removeAttribute(name) {
    delete this.attributes[name];
  }

  load() {
    this.log.push('load');
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }
}

function createFeedPage(respond) {
  const scheduler = createScheduler();
  const audios = [];
  const requests = [];
  const player = { children: [], appendChild(child) { this.children.push(child); child.parentNode = this; } };
  const root = {
    document: {
      createElement(tag) {
        if (tag === 'audio') {
          const audio = new FakeAudio();
          audios.push(audio);
          return audio;
        }
        return { style: {}, textContent: '', remove() {} };
      },
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    location: { href: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', origin: 'https://www.youtube.com' },
    performance: { now: () => scheduler.now },
    setTimeout: scheduler.setTimeout,
    clearTimeout: scheduler.clearTimeout,
    setInterval: scheduler.setInterval,
    clearInterval: scheduler.clearInterval,
    ytcfg: { data_: { VISITOR_DATA: 'CgtWaXNpdG9y', HL: 'en', GL: 'GB' } },
    async fetch(url, init) {
      requests.push({ url, init, body: JSON.parse(init.body) });
      const { status = 200, body } = await respond(url, init);
      return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
    },
  };
  return { root, scheduler, audios, requests, player };
}

const okResponse = (videoId = 'dQw4w9WgXcQ') => ({
  body: {
    playabilityStatus: { status: 'OK' },
    videoDetails: { videoId },
    streamingData: {
      adaptiveFormats: [
        format(251, 'audio/webm; codecs="opus"'),
        format(250, 'audio/webm; codecs="opus"'),
        format(137, 'video/mp4; codecs="avc1.640028"'),
      ],
    },
  },
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('requests a VISIONOS player response without cookies and plays the preferred audio-only stream', async () => {
  const page = createFeedPage(() => okResponse());
  const audio = createScrubAudio(page.root);
  audio.begin({ player: page.player, video: { volume: 0.4, muted: false }, position: 120, time: 0 });
  await flush();

  assert.equal(page.requests.length, 1);
  const [{ url, init, body }] = page.requests;
  assert.equal(url, 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.headers['X-YouTube-Client-Name'], '101');
  assert.equal(init.headers['X-Goog-Visitor-Id'], 'CgtWaXNpdG9y');
  assert.equal(body.videoId, 'dQw4w9WgXcQ');
  assert.equal(body.context.client.clientName, 'VISIONOS');
  assert.equal(body.context.client.gl, 'GB');

  const [element] = page.audios.filter((candidate) => candidate.src);
  assert.match(element.src, /itag=250/);
  assert.equal(element.preservesPitch, true);
  assert.equal(element.volume, 0.4);
  assert.equal(audio.feed.status.state, 'loading');

  element.readyState = 4;
  element.duration = 600;
  element.emit('loadedmetadata');
  page.scheduler.advance(40);
  assert.equal(audio.feed.status.state, 'ready');
  assert.equal(element.currentTime, 120, 'parks at the scrub start');
  assert.equal(element.paused, true);
  assert.equal(page.player.children.length, 1, 'status badge attached to the player');

  audio.end();
  page.scheduler.advance(5 * 60 * 1000);
  assert.equal(element.src, '', 'idle feed is torn down');
});

test('reports why audio is unavailable and retries only after a cooldown', async () => {
  let mode = 'login';
  const page = createFeedPage(() => (mode === 'login'
    ? { body: { playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you\'re not a bot' } } }
    : okResponse()));
  const audio = createScrubAudio(page.root);
  const begin = () => audio.begin({ player: page.player, video: {}, position: 10, time: page.scheduler.now });

  begin();
  await flush();
  assert.equal(audio.feed.status.state, 'failed');
  assert.match(audio.feed.status.detail, /LOGIN_REQUIRED/);
  audio.end();

  mode = 'ok';
  begin();
  await flush();
  assert.equal(page.requests.length, 1, 'no immediate retry');
  audio.end();

  page.scheduler.advance(31 * 1000);
  begin();
  await flush();
  assert.equal(page.requests.length, 2);
  assert.equal(audio.feed.status.state, 'loading');
});

test('surfaces HTTP and media errors', async () => {
  const failing = createFeedPage(() => ({ status: 500, body: {} }));
  const audio = createScrubAudio(failing.root);
  audio.begin({ player: failing.player, video: {}, position: 0, time: 0 });
  await flush();
  assert.equal(audio.feed.status.state, 'failed');
  assert.match(audio.feed.status.detail, /HTTP 500/);

  const refused = createFeedPage(() => okResponse());
  const second = createScrubAudio(refused.root);
  second.begin({ player: refused.player, video: {}, position: 0, time: 0 });
  await flush();
  const element = refused.audios.find((candidate) => candidate.src);
  element.error = { code: 4, message: 'Format error' };
  element.emit('error');
  assert.equal(second.feed.status.state, 'failed');
  assert.match(second.feed.status.detail, /stream refused/);
});

test('ignores player responses for a different video', async () => {
  const page = createFeedPage(() => okResponse('xxxxxxxxxxx'));
  const audio = createScrubAudio(page.root);
  audio.begin({ player: page.player, video: {}, position: 0, time: 0 });
  await flush();
  assert.equal(audio.feed.status.state, 'failed');
  assert.ok(page.audios.every((element) => !element.src));
});
