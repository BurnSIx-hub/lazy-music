/**
 * Lazy Music — Player Receiver
 * Основа: рабочая v14. Добавлено: setFoundryVolume, setGMVolume, мини-плеер.
 */

import { LMMini } from './mini-player.mjs';

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

function _getAudio() {
  if (!audioEl) {
    audioEl = new Audio();
    audioEl.preload = 'auto';
  }
  return audioEl;
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

  static play(payload, { autoplay = true, showBanner = true } = {}) {
    PlayerReceiver._intentionalPause = !autoplay;
    console.log('Lazy Music | Player received play:', payload);

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
      PlayerReceiver.stop();
      return;
    }
    PlayerReceiver.play(playback.track, {
      autoplay: !!playback.playing,
      showBanner: false
    });
  }

  static pause() {
    PlayerReceiver._intentionalPause = true;
    if (mode === 'stream') audioEl?.pause();
    else ytPlayer?.pauseVideo?.();
    if (!game.user.isGM) LMMini.setPlaying(false);
  }

  static stop() {
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

    // Путь может быть относительным (modules/lazy-music/cache/…) — тогда каждый
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
        const resume = () => { a.play().catch(() => {}); };
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
              // PAUSED=2, ENDED=0
              if (e.data === 2 && !PlayerReceiver._intentionalPause) {
                // Браузер поставил на паузу сам — возобновляем
                setTimeout(() => {
                  try { ytPlayer?.playVideo?.(); } catch {}
                }, 200);
              }
            },
            onError: (e) => console.error('Lazy Music | YT error:', e.data)
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
