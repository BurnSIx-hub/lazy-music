/**
 * Lazy Music — Player Receiver
 * Основа: рабочая v14. Добавлено: setFoundryVolume, setGMVolume, мини-плеер.
 */

import { LMMini } from './mini-player.mjs';
import { LMLog } from './log.mjs';

// Громкость: итоговая = foundryVol * gmVol
let ytPlayer    = null;
let audioEl     = null;   // HTML5 Audio — поток с нашего сервера (обход ошибки 150)
let mode        = 'yt';   // 'yt' | 'stream' — что сейчас играет
let foundryVol  = 1.0;
let gmVol       = 1.0;

function _effectiveVol() {
  return Math.round(Math.min(1, foundryVol * gmVol) * 100);
}

function _applyAudioVol() {
  if (audioEl) audioEl.volume = Math.min(1, foundryVol * gmVol);
}

// ── Для журнала Мастера (log.mjs): что получили и чем кончилось ─────────────

const r2 = (x) => Math.round(x * 100) / 100;
/** Громкость: итоговая, ползунок «Музыка» Foundry, громкость Мастера. 0 — не услышит. */
const _vol = () => ({ vol: r2(Math.min(1, foundryVol * gmVol)), fv: r2(foundryVol), gv: r2(gmVol) });

/** Последняя команда «играй»: заиграло ли и через сколько. */
let cmd = null;
const _id = () => window._lmCurrentTrack?.videoId || window._lmCurrentTrack?.id || null;

function _reportPlaying() {
  if (!cmd || cmd.reported) return;
  cmd.reported = true;
  LMLog.report('playing', { id: cmd.id, mode, ms: Math.round(performance.now() - cmd.at), ..._vol() });
}

function _getAudio() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
    let waitAt = 0;
    audioEl.addEventListener('playing', () => {
      if (waitAt && performance.now() - waitAt > 3000) {
        LMLog.report('stall', { id: _id(), mode: 'stream', ms: Math.round(performance.now() - waitAt) });
      }
      waitAt = 0;
      if (mode === 'stream') _reportPlaying();
    });
    audioEl.addEventListener('waiting', () => { waitAt = performance.now(); });
    audioEl.addEventListener('error', () => {
      if (!audioEl.getAttribute('src')) return; // сами сняли src при «стоп»
      // 2 — сеть, 3 — не разобрал, 4 — не открылся (часто 404: файла нет у Foundry)
      LMLog.report('error', { id: _id(), mode: 'stream', code: audioEl.error?.code, msg: audioEl.error?.message, src: audioEl.getAttribute('src') });
    });
  }
  return audioEl;
}

/** Браузер игрока: автоплей и звук у них ведут себя по-разному. */
function _browser() {
  const ua = navigator.userAgent || '';
  const m = (re) => ua.match(re)?.[1];
  const name = /Electron\//.test(ua) ? `приложение Foundry ${m(/Electron\/(\d+)/)}`
    : /Firefox\//.test(ua) ? `Firefox ${m(/Firefox\/(\d+)/)}`
    : /Edg\//.test(ua) ? `Edge ${m(/Edg\/(\d+)/)}`
    : /OPR\//.test(ua) ? `Opera ${m(/OPR\/(\d+)/)}`
    : /Chrome\//.test(ua) ? `Chrome ${m(/Chrome\/(\d+)/)}`
    : /Safari\//.test(ua) ? `Safari ${m(/Version\/(\d+)/) ?? ''}`.trim()
    : 'неизвестный';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${name}, ${os}` : name;
}

export class PlayerReceiver {
  static _intentionalPause = false;

  // Ползунок «Музыка» Foundry — личная громкость каждого
  static setFoundryVolume(vol) {
    foundryVol = Math.max(0, Math.min(1, vol));
    ytPlayer?.setVolume?.(_effectiveVol());
    _applyAudioVol();
  }

  // Мастер-громкость от GM для всех
  static setGMVolume(vol) {
    gmVol = Math.max(0, Math.min(1, vol));
    ytPlayer?.setVolume?.(_effectiveVol());
    _applyAudioVol();
  }

  /** Браузер и система — для журнала Мастера. */
  static browser() { return _browser(); }

  /** Что играет у этого клиента — для журнала Мастера раз в минуту. */
  static status() {
    const id = _id();
    if (!id) return null;
    let pos = 0, paused = true;
    if (mode === 'stream') {
      pos = audioEl?.currentTime ?? 0;
      paused = !!audioEl?.paused;
    } else {
      try { pos = ytPlayer?.getCurrentTime?.() ?? 0; paused = ytPlayer?.getPlayerState?.() !== 1; } catch {}
    }
    return { id, mode, pos: Math.round(pos), paused, ..._vol() };
  }

  static play(payload, { autoplay = true, showBanner = true, via = 'play' } = {}) {
    PlayerReceiver._intentionalPause = !autoplay;
    console.log('Lazy Music | Player received play:', payload);
    const id = payload.videoId || payload.id;
    cmd = autoplay ? { id, at: performance.now(), reported: false } : null;
    LMLog.report('got', {
      a: via, id, mode: payload.streamUrl ? 'stream' : 'yt',
      pos: Math.round(payload.position || 0), auto: autoplay,
    });

    if (payload.streamUrl) {
      // Аудио с нашего сервера — без YouTube-iframe, ошибки 150 не бывает
      PlayerReceiver._playStream(payload.streamUrl, payload.position || 0, autoplay);
    } else if (payload.source === 'youtube') {
      PlayerReceiver._playYouTube(payload.videoId || payload.id, payload.position || 0, autoplay);
    }

    if (showBanner) PlayerReceiver._showBanner(payload);
    window._lmCurrentTrack = payload;
    if (!game.user.isGM) {
      LMMini.update({ title: payload.displayTitle || payload.title || '', playing: autoplay });
    }
  }

  static restoreState({ gmVolume: volume = 1, playback = null } = {}) {
    PlayerReceiver.setGMVolume(volume);
    if (!playback?.track) {
      LMLog.report('got', { a: 'state', id: null });
      PlayerReceiver.stop();
      return;
    }
    PlayerReceiver.play(playback.track, {
      autoplay: !!playback.playing,
      showBanner: false,
      via: 'state'
    });
  }

  static pause() {
    LMLog.report('got', { a: 'pause', id: _id() });
    PlayerReceiver._intentionalPause = true;
    if (mode === 'stream') audioEl?.pause();
    else ytPlayer?.pauseVideo?.();
    if (!game.user.isGM) LMMini.setPlaying(false);
  }

  static stop() {
    if (_id()) LMLog.report('got', { a: 'stop', id: _id() });
    cmd = null;
    PlayerReceiver._intentionalPause = true;
    PlayerReceiver._stopWatchdog();
    ytPlayer?.stopVideo?.();
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); audioEl.load(); }
    PlayerReceiver._hideBanner();
    window._lmCurrentTrack = null;
    if (!game.user.isGM) LMMini.stop();
  }

  static seek(position) {
    if (mode === 'stream') { if (audioEl) try { audioEl.currentTime = position; } catch {} }
    else ytPlayer?.seekTo?.(position, true);
  }

  // ── Поток с нашего сервера ────────────────────────────────────────────────

  static _playStream(url, position = 0, autoplay = true) {
    mode = 'stream';
    ytPlayer?.stopVideo?.();   // глушим YouTube, если играл

    // Путь может быть относительным (lazy-music-cache/…) — тогда каждый
    // клиент качает файл со своего же адреса Foundry. Приводим к абсолютному.
    url = new URL(url, window.location.href).href;

    const a = _getAudio();
    const start = () => {
      try { a.currentTime = position; } catch {}
      _applyAudioVol();
      if (!autoplay) {
        a.pause();
        PlayerReceiver._stopWatchdog();
        return;
      }
      a.play().catch((e) => {
        // Автоплей заблокирован браузером — запустим по первому действию игрока
        console.warn('Lazy Music | autoplay blocked, waiting for user gesture:', e?.message);
        // NotAllowedError — не было щелчка по странице; AbortError — сменили трек
        if (e?.name !== 'AbortError') LMLog.report('blocked', { id: _id(), mode: 'stream', err: e?.name || String(e) });
        const blockedAt = performance.now();
        const resume = () => {
          a.play()
            .then(() => LMLog.report('unblocked', { id: _id(), ms: Math.round(performance.now() - blockedAt) }))
            .catch(() => {});
        };
        document.addEventListener('click',   resume, { once: true });
        document.addEventListener('keydown', resume, { once: true });
      });
      PlayerReceiver._startWatchdog();
    };

    if (a.src === url && a.readyState >= 1) {
      start();
    } else {
      a.src = url;
      a.addEventListener('loadedmetadata', start, { once: true });
      a.load();
    }
  }

  // ── YouTube — точная копия рабочей v14 ───────────────────────────────────

  static _playYouTube(videoId, position = 0, autoplay = true) {
    if (!videoId) { console.error('Lazy Music | No videoId!'); return; }
    mode = 'yt';
    if (audioEl) audioEl.pause();   // глушим поток сервера, если играл
    console.log('Lazy Music | Client playing:', videoId);

    const containerId = 'lazy-music-yt-player';
    if (!document.getElementById(containerId)) {
      const div = document.createElement('div');
      div.id = containerId;
      div.style.cssText = 'position:fixed;bottom:0;right:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
      document.body.appendChild(div);
    }

    const startPlay = () => {
      if (ytPlayer) {
        const method = autoplay ? 'loadVideoById' : 'cueVideoById';
        ytPlayer[method]?.({ videoId, startSeconds: Math.floor(position) });
        ytPlayer.setVolume(_effectiveVol());
      } else {
        ytPlayer = new YT.Player(containerId, {
          width: '1', height: '1', videoId,
          playerVars: { autoplay: autoplay ? 1 : 0, start: Math.floor(position), controls: 0, disablekb: 1, fs: 0, rel: 0 },
          events: {
            onReady: (e) => {
              e.target.setVolume(_effectiveVol());
              if (autoplay) e.target.playVideo();
              else e.target.cueVideoById({ videoId, startSeconds: Math.floor(position) });
              window._lmYTPlayer = ytPlayer;
              if (autoplay) PlayerReceiver._startWatchdog();
            },
            onStateChange: (e) => {
              if (e.data === 1 && mode === 'yt') _reportPlaying();
              // PAUSED=2, ENDED=0
              if (e.data === 2 && !PlayerReceiver._intentionalPause) {
                // Браузер поставил на паузу сам — возобновляем
                setTimeout(() => {
                  try { ytPlayer?.playVideo?.(); } catch {}
                }, 200);
              }
            },
            onError: (e) => {
              console.error('Lazy Music | YT error:', e.data);
              // 150/101 — владелец запретил встраивание, 100 — ролика нет, 2 — плохой id, 5 — HTML5
              LMLog.report('error', { id: _id(), mode: 'yt', code: e.data });
            }
          }
        });
      }
    };

    if (window.YT?.Player) {
      startPlay();
    } else {
      if (!document.getElementById('yt-iframe-api')) {
        const tag = document.createElement('script');
        tag.id = 'yt-iframe-api';
        tag.src = 'https://www.youtube.com/iframe_api';
        document.head.appendChild(tag);
      }
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { if (prev) prev(); startPlay(); };
    }
  }

  // ── Banner ────────────────────────────────────────────────────────────────

  static _showBanner({ title, displayTitle, artist, albumArt }) {
    PlayerReceiver._hideBanner();
    const esc = (s) => foundry.utils.escapeHTML(String(s || ''));
    const banner = document.createElement('div');
    banner.id = 'lm-banner';
    banner.innerHTML = `
      <div class="lm-banner-inner">
        ${albumArt
          ? `<img src="${esc(albumArt)}" class="lm-banner-art" alt="">`
          : `<div class="lm-banner-art-ph"><i class="fas fa-music"></i></div>`}
        <div class="lm-banner-info">
          <div class="lm-banner-title">${esc(displayTitle || title || 'Unknown')}</div>
          <div class="lm-banner-artist">${esc(artist || '')}</div>
        </div>
        <div class="lm-banner-eq"><span></span><span></span><span></span><span></span></div>
      </div>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.classList.add('visible'), 100);
    setTimeout(() => { banner.classList.remove('visible'); setTimeout(() => banner.remove(), 500); }, 5000);
  }

  static _hideBanner() { document.getElementById('lm-banner')?.remove(); }

  // ── Watchdog: следит что плеер не замер ──────────────────────────────────
  static _startWatchdog() {
    PlayerReceiver._stopWatchdog();

    PlayerReceiver._watchdogInterval = setInterval(() => {
      if (PlayerReceiver._intentionalPause) return;

      if (mode === 'stream') {
        // Поток с сервера: возобновляем, если браузер сам поставил паузу
        if (audioEl && audioEl.src && audioEl.paused && !audioEl.ended) {
          console.log('Lazy Music | Watchdog: stream paused unexpectedly, resuming');
          LMLog.report('resume', { id: _id(), mode: 'stream' }, 'resume:' + _id());
          audioEl.play().catch(() => {});
        }
        return;
      }

      if (!ytPlayer) return;
      try {
        const state = ytPlayer.getPlayerState?.();
        // 1 = PLAYING, 3 = BUFFERING — эти нормальные
        // 2 = PAUSED без нашей команды — возобновляем
        // -1 = UNSTARTED, 5 = CUED — тоже запускаем
        if (state === 2 || state === -1 || state === 5) {
          console.log('Lazy Music | Watchdog: player stopped unexpectedly, resuming. State:', state);
          LMLog.report('resume', { id: _id(), mode: 'yt', state }, 'resume:' + _id());
          ytPlayer.playVideo();
        }
      } catch {}
    }, 3000); // проверяем каждые 3 секунды
  }

  static _stopWatchdog() {
    if (PlayerReceiver._watchdogInterval) {
      clearInterval(PlayerReceiver._watchdogInterval);
      PlayerReceiver._watchdogInterval = null;
    }
  }
}
