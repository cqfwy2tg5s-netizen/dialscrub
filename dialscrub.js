// ==UserScript==
// @name         YouTube USB Dial Scrubber
// @namespace    local.youtube-dial-scrubber
// @version      1.4.0
// @description  Duration-scaled YouTube scrubbing with flexible release controls, SponsorBlock support, and an audio-only feed that follows the scrub at up to 3.5x with preserved pitch.
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-start
// @inject-into  content
// @noframes
// ==/UserScript==

(function bootstrap(root, factory) {
  'use strict';

  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    api.createDialScrubber(root).install();
  }
})(typeof globalThis === 'object' ? globalThis : this, function makeApi() {
  'use strict';

  const scrubAudioDefaults = {
    enabled: true,
    showStatus: true,
    maxRate: 3.5,
    minRate: 0.5,
    // Audio-only itags in order of preference: Opus ~70/~160/~50 kbps, then AAC.
    preferredItags: [250, 251, 249, 140, 139],
    idleTeardownMs: 5 * 60 * 1000,
    retryAfterMs: 30 * 1000,
    requestTimeoutMs: 10 * 1000,
    tickMs: 33,
  };

  // Tuned against a simulated Firefox <audio> element and synthetic dial patterns
  // (steady, jittery, accelerating, stop-start, reversing, SponsorBlock jumps).
  const scrubAudioTuning = {
    startRate: 1,
    slack: 1.3,
    backlogGain: 0.6,
    intervalSmoothing: 0.2,
    slowdownSmoothing: 0.6,
    minIntervalMs: 15,
    maxIntervalMs: 2500,
    pauseFactor: 2.5,
    pausePadMs: 250,
    forgetTempoMs: 4000,
    headMargin: 0.06,
    correctionGain: 1.5,
    maxLag: 2.5,
    maxLead: 1,
    pauseLead: 0.35,
    tailWindow: 1.25,
    reverseSettleMs: 250,
    repositionTolerance: 0.15,
    parkTolerance: 0.05,
    rateStep: 0.05,
    bufferedSeekLatencyMs: 60,
    networkSeekLatencyMs: 350,
    maxSeekLead: 1.5,
  };

  // InnerTube client whose player responses carry plain audio-only stream URLs (no PO token
  // or signature challenge). Mirrors yt-dlp's no-JavaScript default as of 2026.09; when
  // YouTube retires it, replace it with whatever yt-dlp's _DEFAULT_JSLESS_CLIENTS uses.
  const innertubeClients = [{
    id: 101,
    context: {
      clientName: 'VISIONOS',
      clientVersion: '1.02',
      deviceMake: 'Apple',
      deviceModel: 'RealityDevice17,1',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      osName: 'visionOS',
      osVersion: '26.5.23O471',
    },
  }];

  function clockFor(root) {
    const performance = root.performance;
    return performance && typeof performance.now === 'function'
      ? () => performance.now()
      : () => Date.now();
  }

  function timersFor(root) {
    const scope = typeof root.setTimeout === 'function' ? root : globalThis;
    return {
      setTimeout: (callback, delay) => scope.setTimeout(callback, delay),
      clearTimeout: (id) => scope.clearTimeout(id),
      setInterval: (callback, delay) => scope.setInterval(callback, delay),
      clearInterval: (id) => scope.clearInterval(id),
    };
  }

  // Keeps an audio element trailing the scrub head. Each detent reveals `step` seconds; the
  // audio replays the revealed span one detent behind, spread over slightly more than the
  // expected time until the next detent, so steady turning gives steady playback and the
  // audio never runs ahead of what the scrubber shows. Beyond maxRate it jumps forward.
  function createScrubAudioSync(media, overrides = {}) {
    const config = { ...scrubAudioTuning, ...scrubAudioDefaults, ...overrides };
    let mode = 'idle';
    let head = 0;
    let headTime = 0;
    let lastForwardTime = -Infinity;
    let interval = null;
    let segment = { from: 0, at: 0, slope: 0, end: 0 };
    let parkExactly = false;
    let repositionTo = null;
    let rate = 1;
    let seekStartedAt = null;
    let seekWasBuffered = false;
    const seekLatencyMs = {
      buffered: config.bufferedSeekLatencyMs,
      network: config.networkSeekLatencyMs,
    };

    function targetAt(now) {
      const elapsed = Math.max(0, now - segment.at) / 1000;
      return Math.min(segment.end, segment.from + segment.slope * elapsed);
    }

    function setSegment(from, at, slope, end) {
      segment = { from, at, slope, end };
    }

    function isBuffered(position) {
      return media.bufferedEnd(position) > position + 0.25;
    }

    function seek(position, now) {
      const target = Math.max(0, position);
      seekWasBuffered = isBuffered(target);
      media.seek(target);
      seekStartedAt = now;
    }

    function jumpTarget(target, end, audioTime) {
      const ahead = (latency) => Math.min(
        end,
        target + Math.min(config.maxSeekLead, segment.slope * latency / 1000),
      );
      const buffered = ahead(seekLatencyMs.buffered);
      if (isBuffered(buffered)) return buffered;
      const edge = media.bufferedEnd(audioTime) - 0.3;
      if (edge > audioTime && target - edge < config.maxLag / 2) return edge;
      return ahead(seekLatencyMs.network);
    }

    function applyRate(desired) {
      const clamped = Math.min(config.maxRate, Math.max(config.minRate, desired));
      if (Math.abs(clamped - rate) >= config.rateStep * 0.75) {
        rate = Math.round(clamped / config.rateStep) * config.rateStep;
        media.setRate(rate);
      }
    }

    function play() {
      if (media.paused) media.play();
    }

    function pause() {
      if (!media.paused) media.pause();
    }

    function start(position, now) {
      mode = 'forward';
      head = position;
      headTime = now;
      repositionTo = null;
      parkExactly = true;
      setSegment(position, now, 0, position);
      tick(now);
    }

    function stop() {
      mode = 'idle';
      pause();
    }

    function detent({ time: now, position, direction, step }) {
      if (mode === 'idle') return;
      const previousHead = head;
      head = position;
      headTime = now;

      if (direction < 0) {
        mode = 'reverse';
        setSegment(position, now, 0, position);
        pause();
        return;
      }

      const gap = now - lastForwardTime;
      if (gap > config.forgetTempoMs) interval = null;
      const resuming = mode !== 'forward' || parkExactly || gap > config.maxIntervalMs
        || (interval !== null && gap > interval * config.pauseFactor + config.pausePadMs);
      let from = targetAt(now);
      if (resuming) {
        from = Math.max(from, previousHead);
        repositionTo = from;
        interval = null;
      } else if (gap >= config.minIntervalMs) {
        const weight = interval !== null && gap > interval
          ? config.slowdownSmoothing
          : config.intervalSmoothing;
        interval = interval === null ? gap : interval + weight * (gap - interval);
      }
      if (position - previousHead > step * 1.6) {
        from = Math.max(from, position - step);
        repositionTo = null;
      }
      lastForwardTime = now;

      const end = Math.max(from, position - config.headMargin);
      let slope = config.startRate;
      if (interval !== null) {
        const expected = config.slack * interval / 1000;
        slope = step / (interval / 1000)
          + config.backlogGain * (end - from - config.slack * step) / expected;
      }
      setSegment(from, now, Math.max(0, slope), end);
      mode = 'forward';
      parkExactly = false;
      tick(now);
    }

    function onSeeked(now) {
      if (seekStartedAt === null) return;
      const sample = Math.min(1500, now - seekStartedAt);
      const kind = seekWasBuffered ? 'buffered' : 'network';
      seekStartedAt = null;
      seekLatencyMs[kind] += 0.3 * (sample - seekLatencyMs[kind]);
    }

    function tick(now) {
      if (mode === 'idle' || !media.ready || media.seeking) return;
      const audioTime = media.time;

      if (mode === 'reverse') {
        pause();
        if (now - headTime < config.reverseSettleMs) return;
        mode = 'forward';
        parkExactly = true;
        setSegment(head, now, 0, head);
      }

      const end = segment.end;
      if (parkExactly) {
        pause();
        if (Math.abs(end - audioTime) > config.parkTolerance) seek(end, now);
        return;
      }

      if (repositionTo !== null) {
        const position = repositionTo;
        repositionTo = null;
        if (Math.abs(position - audioTime) > config.repositionTolerance) {
          seek(position, now);
          return;
        }
      }

      const target = targetAt(now);
      const atEnd = target >= end - 1e-9;
      const error = target - audioTime;

      if (error > config.maxLag) {
        seek(atEnd
          ? Math.max(audioTime, end - config.tailWindow)
          : jumpTarget(target, end, audioTime), now);
        return;
      }
      if (error < -config.maxLead) {
        seek(target, now);
        return;
      }

      if (atEnd) {
        const stopWithin = Math.max(0.02, rate * config.tickMs / 1000);
        if (end - audioTime <= stopWithin) {
          pause();
          return;
        }
        applyRate(rate);
        play();
        return;
      }

      if (error < -config.pauseLead) {
        pause();
        return;
      }
      applyRate(segment.slope + config.correctionGain * error);
      play();
    }

    return {
      start,
      stop,
      detent,
      tick,
      onSeeked,
      targetAt,
      get state() {
        return { mode, head, rate, interval, segment: { ...segment } };
      },
    };
  }

  function pickAudioFormat(playerResponse, { preferredItags = [], canPlay } = {}) {
    const formats = playerResponse?.streamingData?.adaptiveFormats;
    if (!Array.isArray(formats)) return null;

    const trackRank = (format) => {
      const track = format.audioTrack;
      if (!track) return 1;
      const name = String(track.displayName || '').toLowerCase();
      if (name.includes('descriptive')) return -1;
      if (name.includes('original')) return 3;
      return track.audioIsDefault ? 2 : 0;
    };
    const itagRank = (format) => {
      const index = preferredItags.indexOf(Number(format.itag));
      return index < 0 ? preferredItags.length : index;
    };

    return formats
      .filter((format) => typeof format.url === 'string'
        && /^audio\//.test(format.mimeType || '')
        && !format.drmFamilies
        && !format.targetDurationSec
        && format.type !== 'FORMAT_STREAM_TYPE_OTF'
        && (!canPlay || canPlay(format.mimeType)))
      .sort((left, right) => trackRank(right) - trackRank(left)
        || Number(Boolean(left.isDrc)) - Number(Boolean(right.isDrc))
        || itagRank(left) - itagRank(right)
        || (Number(left.bitrate) || 0) - (Number(right.bitrate) || 0))[0] ?? null;
  }

  function readVideoId(root) {
    const valid = (id) => (typeof id === 'string' && /^[\w-]{11}$/.test(id) ? id : null);
    try {
      const url = new URL(root.location.href);
      const id = valid(url.searchParams.get('v'))
        || valid(url.pathname.match(/^\/(?:live|embed)\/([\w-]{11})/)?.[1]);
      if (id) return id;
    } catch {
      // Fall through to the watch page element.
    }
    return valid(root.document.querySelector('ytd-watch-flexy[video-id]')?.getAttribute('video-id'));
  }

  function readPageConfig(root) {
    const config = {};
    try {
      const pageWindow = root.window?.wrappedJSObject ?? root.wrappedJSObject
        ?? (typeof unsafeWindow === 'object' ? unsafeWindow : root);
      const data = pageWindow?.ytcfg?.data_;
      if (data) {
        config.visitorData = data.VISITOR_DATA || data.INNERTUBE_CONTEXT?.client?.visitorData;
        config.hl = data.HL;
        config.gl = data.GL;
      }
    } catch {
      // Page objects are unreachable from this realm; scan inline scripts instead.
    }
    if (!config.visitorData) {
      for (const script of root.document.querySelectorAll('script:not([src])')) {
        const match = /"VISITOR_DATA":"([^"]+)"/.exec(script.textContent);
        if (match) {
          config.visitorData = match[1];
          break;
        }
      }
    }
    return config;
  }

  function pageFetch(root, url, init) {
    // Firefox content scripts only send the page's Origin with content.fetch.
    const scope = typeof content === 'object' && content && typeof content.fetch === 'function'
      ? content
      : root;
    return scope.fetch(url, init);
  }

  async function requestPlayer(root, videoId, client) {
    const page = readPageConfig(root);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': client.context.userAgent,
      'X-YouTube-Client-Name': String(client.id),
      'X-YouTube-Client-Version': client.context.clientVersion,
    };
    if (page.visitorData) headers['X-Goog-Visitor-Id'] = page.visitorData;
    const response = await pageFetch(root, `${root.location.origin}/youtubei/v1/player?prettyPrint=false`, {
      method: 'POST',
      credentials: 'omit',
      headers,
      body: JSON.stringify({
        context: {
          client: {
            ...client.context,
            hl: page.hl || 'en',
            ...(page.gl ? { gl: page.gl } : {}),
            timeZone: 'UTC',
            utcOffsetMinutes: 0,
          },
        },
        videoId,
        playbackContext: { contentPlaybackContext: { html5Preference: 'HTML5_PREF_WANTS' } },
        contentCheckOk: true,
        racyCheckOk: true,
      }),
    });
    if (!response.ok) throw new Error(`player request failed (HTTP ${response.status})`);
    return JSON.parse(await response.text());
  }

  function describeMediaError(audio) {
    const kinds = { 1: 'aborted', 2: 'network error', 3: 'decode error', 4: 'stream refused' };
    const error = audio.error;
    return `${kinds[error?.code] || 'playback error'}${error?.message ? ` (${error.message})` : ''}`;
  }

  function createAudioFeed(root, settings, onSeeked) {
    const timers = timersFor(root);
    const now = clockFor(root);
    let record = null;
    let rate = 1;
    let volume = { level: 1, muted: false };
    let playBlockedUntil = 0;

    const media = {
      get ready() {
        return Boolean(record?.state === 'ready' && record.audio.readyState >= 1);
      },
      get time() {
        return record?.audio?.currentTime ?? 0;
      },
      get paused() {
        return record?.audio?.paused ?? true;
      },
      get seeking() {
        return Boolean(record?.audio?.seeking);
      },
      bufferedEnd(position) {
        const ranges = record?.audio?.buffered;
        for (let index = 0; ranges && index < ranges.length; index += 1) {
          if (position >= ranges.start(index) - 0.05 && position <= ranges.end(index)) {
            return ranges.end(index);
          }
        }
        return position;
      },
      seek(position) {
        const audio = record?.audio;
        if (!audio) return;
        const limit = Number.isFinite(audio.duration) ? audio.duration - 0.05 : position;
        audio.currentTime = Math.max(0, Math.min(position, limit));
      },
      setRate(value) {
        rate = value;
        if (record?.audio) record.audio.playbackRate = value;
      },
      play() {
        const audio = record?.audio;
        if (!audio || audio.ended || now() < playBlockedUntil) return;
        const started = audio.play();
        started?.catch?.((error) => {
          if (error?.name === 'NotAllowedError') {
            playBlockedUntil = now() + 1000;
            if (record?.audio === audio) record.detail = 'autoplay blocked';
          }
        });
      },
      pause() {
        record?.audio?.pause();
      },
    };

    function createAudioElement() {
      const audio = root.document.createElement('audio');
      audio.preload = 'auto';
      if ('preservesPitch' in audio) {
        audio.preservesPitch = true;
      } else if ('mozPreservesPitch' in audio) {
        audio.mozPreservesPitch = true;
      }
      return audio;
    }

    function withTimeout(promise) {
      return new Promise((resolve, reject) => {
        const timer = timers.setTimeout(
          () => reject(new Error('player request timed out')),
          settings.requestTimeoutMs,
        );
        promise.then((value) => {
          timers.clearTimeout(timer);
          resolve(value);
        }, (error) => {
          timers.clearTimeout(timer);
          reject(error);
        });
      });
    }

    function fail(target, detail) {
      if (target.audio && target.wasReady && !target.retried) {
        load(target.videoId, true);
        return;
      }
      target.state = 'failed';
      target.detail = detail;
      target.failedAt = now();
      release(target.audio);
    }

    function attach(target, audio, format) {
      target.audio = audio;
      target.itag = Number(format.itag);
      const expire = Number(new URL(format.url).searchParams.get('expire'));
      target.expiresAt = Number.isFinite(expire) && expire > 0 ? expire * 1000 : Infinity;
      audio.addEventListener('loadedmetadata', () => {
        if (record !== target) return;
        target.state = 'ready';
        target.wasReady = true;
      });
      audio.addEventListener('seeked', () => {
        if (record === target) onSeeked();
      });
      audio.addEventListener('playing', () => {
        if (record === target) target.detail = '';
      });
      audio.addEventListener('error', () => {
        if (record === target && target.state !== 'failed') fail(target, describeMediaError(audio));
      });
      audio.playbackRate = rate;
      audio.volume = volume.level;
      audio.muted = volume.muted;
      audio.src = format.url;
    }

    async function fetchFeed(target) {
      let failure = 'no audio-only stream';
      for (const client of innertubeClients) {
        try {
          const response = await withTimeout(requestPlayer(root, target.videoId, client));
          if (record !== target) return;
          const playability = response?.playabilityStatus;
          if (playability?.status !== 'OK') {
            failure = [playability?.status, playability?.reason].filter(Boolean).join(': ')
              || 'not playable';
            continue;
          }
          if (response.videoDetails?.videoId !== target.videoId) {
            failure = 'player response was for another video';
            continue;
          }
          const audio = createAudioElement();
          const format = pickAudioFormat(response, {
            preferredItags: settings.preferredItags,
            canPlay: (type) => audio.canPlayType(type) !== '',
          });
          if (!format) {
            failure = 'no audio-only stream';
            continue;
          }
          attach(target, audio, format);
          return;
        } catch (error) {
          if (record !== target) return;
          failure = error?.message || String(error);
        }
      }
      fail(target, failure);
    }

    function release(audio) {
      if (!audio) return;
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }

    function teardown() {
      const previous = record;
      record = null;
      release(previous?.audio);
    }

    function load(videoId, retried = false) {
      teardown();
      const target = { videoId, state: 'loading', detail: '', audio: null, retried };
      record = target;
      fetchFeed(target).catch((error) => {
        if (record === target) fail(target, error?.message || String(error));
      });
    }

    function ensure(videoId) {
      if (!videoId) return false;
      const stale = !record || record.videoId !== videoId
        || (record.state === 'failed' && now() - record.failedAt > settings.retryAfterMs)
        || Date.now() > record.expiresAt - 2 * 60 * 1000;
      if (stale) load(videoId);
      return true;
    }

    function setVolume(level, muted) {
      volume = {
        level: Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 1,
        muted: Boolean(muted),
      };
      if (!record?.audio) return;
      record.audio.volume = volume.level;
      record.audio.muted = volume.muted;
    }

    return {
      media,
      ensure,
      setVolume,
      teardown,
      get status() {
        return record ? { state: record.state, detail: record.detail, itag: record.itag } : { state: 'idle' };
      },
    };
  }

  function createStatusBadge(root) {
    const timers = timersFor(root);
    let element = null;
    let hideTimer = null;

    function attach(player) {
      if (!player) return;
      if (!element) {
        element = root.document.createElement('div');
        element.className = 'dial-scrubber-audio-status';
        element.style.cssText = [
          'position:absolute', 'top:12px', 'right:12px', 'z-index:100', 'max-width:60%',
          'padding:3px 9px', 'border-radius:12px', 'background:rgba(0,0,0,.65)', 'color:#fff',
          'font:500 12px/1.5 Roboto,Arial,sans-serif', 'white-space:nowrap', 'overflow:hidden',
          'text-overflow:ellipsis', 'pointer-events:none', 'transition:opacity .25s', 'opacity:0',
        ].join(';');
      }
      if (element.parentNode !== player) player.appendChild(element);
      timers.clearTimeout(hideTimer);
      element.style.opacity = '1';
    }

    function render(text) {
      if (!element || element.textContent === text) return;
      element.textContent = text;
    }

    function hide() {
      if (!element) return;
      timers.clearTimeout(hideTimer);
      hideTimer = timers.setTimeout(() => {
        if (element) element.style.opacity = '0';
      }, 1200);
    }

    function destroy() {
      timers.clearTimeout(hideTimer);
      element?.remove();
      element = null;
    }

    return { attach, render, hide, destroy };
  }

  function supportsScrubAudio(root) {
    return typeof root.document?.createElement === 'function'
      && typeof root.fetch === 'function'
      && typeof root.location?.origin === 'string';
  }

  function createScrubAudio(root, overrides = {}) {
    if (overrides === false) return null;
    const settings = { ...scrubAudioDefaults, ...overrides };
    if (!settings.enabled || !supportsScrubAudio(root)) return null;

    const timers = timersFor(root);
    const now = clockFor(root);
    let sync = null;
    const feed = createAudioFeed(root, settings, () => sync.onSeeked(now()));
    sync = createScrubAudioSync(feed.media, settings);
    const badge = settings.showStatus ? createStatusBadge(root) : null;
    let active = false;
    let loop = null;
    let teardownTimer = null;

    function statusText() {
      const note = '\u266a';
      const { state, detail } = feed.status;
      if (state === 'loading') return `${note} loading audio\u2026`;
      if (state === 'failed') return `${note} audio unavailable${detail ? `: ${detail}` : ''}`;
      if (state === 'ready' && detail) return `${note} ${detail}`;
      if (state !== 'ready' || feed.media.paused) return note;
      const { rate, segment } = sync.state;
      const capped = segment.slope > settings.maxRate + 0.05;
      return `${note} ${rate.toFixed(1)}\u00d7${capped ? ' max' : ''}`;
    }

    function update() {
      sync.tick(now());
      badge?.render(statusText());
    }

    function begin({ player, video, position, time }) {
      if (!feed.ensure(readVideoId(root))) return;
      timers.clearTimeout(teardownTimer);
      feed.setVolume(video?.volume, video?.muted);
      active = true;
      sync.start(position, time);
      if (loop === null) {
        loop = timers.setInterval(update, settings.tickMs);
        loop?.unref?.();
      }
      badge?.attach(player);
      update();
    }

    function detent(event) {
      if (!active) return;
      sync.detent(event);
      badge?.render(statusText());
    }

    function end() {
      if (!active) return;
      active = false;
      sync.stop();
      timers.clearInterval(loop);
      loop = null;
      badge?.render(statusText());
      badge?.hide();
      timers.clearTimeout(teardownTimer);
      teardownTimer = timers.setTimeout(feed.teardown, settings.idleTeardownMs);
      teardownTimer?.unref?.();
    }

    function destroy() {
      end();
      timers.clearTimeout(teardownTimer);
      feed.teardown();
      badge?.destroy();
    }

    return { begin, detent, end, destroy, feed, sync };
  }

  function createDialScrubber(root, options = {}) {
    const referenceDuration = 25 * 60;
    const minimumScaledDuration = 30;
    const physicalMouseEvents = [
      'pointermove', 'mousemove', 'pointerover', 'mouseover', 'pointerout', 'mouseout',
    ];
    const mouseInterruptEvents = ['pointerdown', 'mousedown'];
    const now = clockFor(root);
    const scrubAudio = 'scrubAudio' in options
      ? options.scrubAudio
      : createScrubAudio(root, options.audio);
    const state = {
      active: false,
      contentOffset: 0,
      lastFinishedOffset: null,
      totalContentWidth: 0,
      bar: null,
      x: 0,
      y: 0,
      installed: false,
    };

    function readLayout() {
      const document = root.document;
      const player = document.querySelector('#movie_player');
      const video = document.querySelector('#movie_player video');
      const bar = document.querySelector('.ytp-progress-bar');
      if (!player || !video || !bar || player.classList.contains('ad-showing')
        || !Number.isFinite(video.duration) || video.duration <= 0) {
        return null;
      }

      const parts = [...document.querySelectorAll('.ytp-progress-list')]
        .map((element) => element.getBoundingClientRect())
        .filter((rect) => rect.width > 0)
        .sort((left, right) => left.left - right.left);
      const totalContentWidth = parts.reduce((total, rect) => total + rect.width, 0);
      if (!parts.length || totalContentWidth <= 0) return null;

      return { player, video, bar, parts, totalContentWidth };
    }

    function pointForOffset(layout, contentOffset) {
      let remaining = Math.max(0, Math.min(layout.totalContentWidth, contentOffset));
      let x = layout.parts[0].left;
      for (const rect of layout.parts) {
        if (remaining <= rect.width) {
          x = rect.left + remaining;
          break;
        }
        remaining -= rect.width;
        x = rect.right;
      }
      const barRect = layout.bar.getBoundingClientRect();
      return {
        x: Math.round(x),
        y: Math.round(barRect.top + barRect.height / 2),
      };
    }

    function offsetForX(layout, x) {
      let contentOffset = 0;
      for (const rect of layout.parts) {
        if (x <= rect.left) return contentOffset;
        if (x <= rect.right) return contentOffset + x - rect.left;
        contentOffset += rect.width;
      }
      return layout.totalContentWidth;
    }

    function timeForOffset(layout, contentOffset) {
      return contentOffset / layout.totalContentWidth * layout.video.duration;
    }

    function readSponsorBlockIntervals(layout) {
      const previewBar = root.document.querySelector('#previewbar');
      if (!previewBar) return [];

      const previewRect = previewBar.getBoundingClientRect();
      if (previewRect.width <= 0) return [];

      const intervals = [...root.document.querySelectorAll(
        '#previewbar > .previewbar[sponsorblock-category]',
      )].flatMap((element) => {
        const category = element.getAttribute('sponsorblock-category') || '';
        if (category.startsWith('preview-')) return [];
        if (!element.style.left.endsWith('%') || !element.style.right.endsWith('%')) return [];

        const left = Number.parseFloat(element.style.left);
        const right = Number.parseFloat(element.style.right);
        if (!Number.isFinite(left) || !Number.isFinite(right)) return [];

        const start = offsetForX(layout, previewRect.left + previewRect.width * left / 100);
        const end = offsetForX(layout, previewRect.left + previewRect.width * (1 - right / 100));
        return end > start ? [{ start, end }] : [];
      }).sort((left, right) => left.start - right.start);

      return intervals.reduce((merged, interval) => {
        const previous = merged.at(-1);
        if (previous && interval.start <= previous.end) {
          previous.end = Math.max(previous.end, interval.end);
        } else {
          merged.push(interval);
        }
        return merged;
      }, []);
    }

    function moveByPixels(layout, start, direction, distance) {
      const intervals = readSponsorBlockIntervals(layout);
      let position = start;
      let remaining = distance;

      if (direction > 0) {
        for (const interval of intervals) {
          if (interval.end <= position) continue;
          if (position >= interval.start) {
            position = interval.end;
            continue;
          }

          const gap = interval.start - position;
          if (remaining < gap) return position + remaining;
          remaining -= gap;
          position = interval.end;
        }
        return Math.min(layout.totalContentWidth, position + remaining);
      }

      for (const interval of intervals.toReversed()) {
        if (interval.start >= position) continue;
        if (position <= interval.end) {
          position = interval.start;
          continue;
        }

        const gap = position - interval.end;
        if (remaining < gap) return position - remaining;
        remaining -= gap;
        position = interval.start;
      }
      return Math.max(0, position - remaining);
    }

    function pixelsPerTurn(duration) {
      const scaledDuration = Math.max(
        minimumScaledDuration,
        Math.min(referenceDuration, duration),
      );
      return referenceDuration / scaledDuration;
    }

    function readStartingOffset(layout) {
      const playbackOffset = layout.video.currentTime / layout.video.duration
        * layout.totalContentWidth;
      const scrubberButton = root.document.querySelector('.ytp-scrubber-button');
      if (scrubberButton) {
        const rect = scrubberButton.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const firstPart = layout.parts[0];
        const lastPart = layout.parts.at(-1);
        if (rect.width > 0 && x >= firstPart.left && x <= lastPart.right) {
          const renderedOffset = offsetForX(layout, x);
          const renderedPositionIsStale = Number.isFinite(state.lastFinishedOffset)
            && Math.abs(renderedOffset - state.lastFinishedOffset) < 0.5
            && Math.abs(playbackOffset - state.lastFinishedOffset) >= 0.5;
          if (!renderedPositionIsStale) return renderedOffset;
        }
      }
      return playbackOffset;
    }

    function notifyAudio(method, details) {
      if (!scrubAudio) return;
      try {
        scrubAudio[method](details);
      } catch (error) {
        root.console?.warn?.('[dial scrubber] audio feed error', error);
      }
    }

    function fire(type, buttons) {
      const EventConstructor = type.startsWith('pointer') ? root.PointerEvent : root.MouseEvent;
      state.bar.dispatchEvent(new EventConstructor(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        clientX: state.x,
        clientY: state.y,
        screenX: state.x,
        screenY: state.y,
        button: 0,
        buttons,
        pointerId: 411,
        pointerType: 'mouse',
        isPrimary: true,
      }));
    }

    function move(buttons) {
      fire('pointermove', buttons);
      fire('mousemove', buttons);
    }

    function begin(time) {
      const layout = readLayout();
      if (!layout) return false;

      state.bar = layout.bar;
      state.totalContentWidth = layout.totalContentWidth;
      state.contentOffset = readStartingOffset(layout);
      Object.assign(state, pointForOffset(layout, state.contentOffset));
      notifyAudio('begin', {
        player: layout.player,
        video: layout.video,
        position: timeForOffset(layout, state.contentOffset),
        time,
      });
      move(0);
      fire('pointerdown', 1);
      fire('mousedown', 1);
      state.active = true;
      return true;
    }

    function turn(direction, time = now()) {
      if (!state.active && !begin(time)) return false;
      const layout = readLayout();
      if (!layout) return false;

      state.bar = layout.bar;
      const pixelStep = pixelsPerTurn(layout.video.duration);
      state.contentOffset = moveByPixels(
        layout,
        state.contentOffset,
        direction,
        pixelStep,
      );
      state.totalContentWidth = layout.totalContentWidth;
      Object.assign(state, pointForOffset(layout, state.contentOffset));
      move(1);
      notifyAudio('detent', {
        time,
        direction,
        position: timeForOffset(layout, state.contentOffset),
        step: timeForOffset(layout, pixelStep),
      });
      return true;
    }

    function onPhysicalPointerMove(event) {
      if (!state.active || !event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function finish() {
      if (!state.active) return false;
      fire('pointerup', 0);
      fire('mouseup', 0);
      state.active = false;
      state.lastFinishedOffset = state.contentOffset;
      notifyAudio('end');
      return true;
    }

    function isKeyboardInterrupt(event) {
      return event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space'
        || /^[a-z]$/i.test(event.key);
    }

    function eventTime(event) {
      const current = now();
      const stamp = event.timeStamp;
      return Number.isFinite(stamp) && stamp > 0 && stamp <= current && current - stamp < 1000
        ? stamp
        : current;
    }

    function onMouseInterrupt(event) {
      if (state.active && event.isTrusted) finish();
    }

    function onKeyDown(event) {
      if (event.key === 'F9') {
        if (!finish()) return;
      } else if (event.key === 'F2' || event.key === 'F8') {
        if (!turn(event.key === 'F8' ? 1 : -1, eventTime(event))) return;
      } else if (state.active && isKeyboardInterrupt(event)) {
        finish();
        return;
      } else {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function install() {
      if (state.installed) return;
      root.addEventListener('keydown', onKeyDown, true);
      for (const type of physicalMouseEvents) {
        root.addEventListener(type, onPhysicalPointerMove, true);
      }
      for (const type of mouseInterruptEvents) {
        root.addEventListener(type, onMouseInterrupt, true);
      }
      root.document.addEventListener('yt-navigate-start', finish, true);
      state.installed = true;
    }

    function destroy() {
      if (!state.installed) return;
      finish();
      notifyAudio('destroy');
      root.removeEventListener('keydown', onKeyDown, true);
      for (const type of physicalMouseEvents) {
        root.removeEventListener(type, onPhysicalPointerMove, true);
      }
      for (const type of mouseInterruptEvents) {
        root.removeEventListener(type, onMouseInterrupt, true);
      }
      root.document.removeEventListener('yt-navigate-start', finish, true);
      state.installed = false;
    }

    return { install, destroy, turn, finish, state };
  }

  return {
    createDialScrubber,
    createScrubAudio,
    createScrubAudioSync,
    pickAudioFormat,
    scrubAudioDefaults,
    scrubAudioTuning,
  };
});
