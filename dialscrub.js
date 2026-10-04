// ==UserScript==
// @name         YouTube USB Dial Scrubber
// @namespace    local.youtube-dial-scrubber
// @version      1.3.1
// @description  Duration-scaled YouTube scrubbing with flexible release controls and SponsorBlock support.
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

  function createDialScrubber(root) {
    const referenceDuration = 25 * 60;
    const minimumScaledDuration = 30;
    const physicalMouseEvents = [
      'pointermove', 'mousemove', 'pointerover', 'mouseover', 'pointerout', 'mouseout',
    ];
    const mouseInterruptEvents = ['pointerdown', 'mousedown'];
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

    function begin() {
      const layout = readLayout();
      if (!layout) return false;

      state.bar = layout.bar;
      state.totalContentWidth = layout.totalContentWidth;
      state.contentOffset = readStartingOffset(layout);
      Object.assign(state, pointForOffset(layout, state.contentOffset));
      move(0);
      fire('pointerdown', 1);
      fire('mousedown', 1);
      state.active = true;
      return true;
    }

    function turn(direction) {
      if (!state.active && !begin()) return false;
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
      return true;
    }

    function isKeyboardInterrupt(event) {
      return event.key === ' ' || event.key === 'Spacebar' || event.code === 'Space'
        || /^[a-z]$/i.test(event.key);
    }

    function onMouseInterrupt(event) {
      if (state.active && event.isTrusted) finish();
    }

    function onKeyDown(event) {
      if (event.key === 'F9') {
        if (!finish()) return;
      } else if (event.key === 'F2' || event.key === 'F8') {
        if (!turn(event.key === 'F8' ? 1 : -1)) return;
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

  return { createDialScrubber };
});
