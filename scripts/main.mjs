/**
 * Lazy Music — Entry Point v2.1.2
 */

import { LMApp }         from './app.mjs';
import { LMSocket }       from './socket.mjs';
import { LMSettings }     from './settings.mjs';
import { PlayerReceiver } from './player-receiver.mjs';
import { LMMini }         from './mini-player.mjs';

Hooks.once('init', () => {
  console.log('Lazy Music | init');
  // Foundry не предоставляет хелпер `eq` — регистрируем свой, если его нет.
  // Без него шаблон падает с "Missing helper: eq" и окно не рендерится.
  if (!Handlebars.helpers.eq) {
    Handlebars.registerHelper('eq', (a, b) => a === b);
  }
  LMSettings.register();
});

Hooks.once('ready', () => {
  console.log('Lazy Music | ready');
  LMSocket.init({
    onStateRequest: (userId) => LMApp._instance?.syncStateToPlayer(userId)
  });

  // Одноразовая миграция: убираем API-ключ из world-настроек.
  LMSettings.migrateWorldSecrets().catch(e => console.warn('Lazy Music | migrate:', e));

  // Кнопка в панели плейлистов (только GM)
  if (game.user.isGM) {
    Hooks.on('renderPlaylistDirectory', _injectButton);
    const el = ui.playlists?.element;
    if (el) _injectButton(ui.playlists, el);
  }

  // Мини-плеер (у всех) не имеет своего личного регулятора громкости:
  // индивидуальная громкость берётся из штатного Foundry-ползунка «Музыка».
  LMMini.init();

  // Применяем текущую громкость сразу
  _syncVol();

  // Следим за громкостью — несколько методов параллельно для надёжности
  _setupVolumeSync();

  // A player joining during playback asks the GM for the current track,
  // position, pause state, and master volume.
  if (!game.user.isGM) {
    setTimeout(() => LMSocket.requestState(), 1000);
    setTimeout(() => LMSocket.requestState(), 5000);
  }
});

// ── Читаем globalPlaylistVolume из Foundry ───────────────────────────────────
function _normalizeVol(vol) {
  const n = Number.parseFloat(vol);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function _getFoundryVol() {
  try { return _normalizeVol(game.settings.get('core', 'globalPlaylistVolume') ?? 1); } catch { return 1; }
}

function _applyFoundryVol(vol) {
  const v = _normalizeVol(vol);
  PlayerReceiver.setFoundryVolume(v);
  if (game.user.isGM) LMApp._instance?.applyFoundryVolume(v);
}

function _syncVol() {
  _applyFoundryVol(_getFoundryVol());
}

// ── Синхронизация громкости — несколько независимых методов ─────────────────
function _setupVolumeSync() {

  // Метод 1: хук Foundry updateSetting
  // В v14 key может быть в разных форматах — проверяем оба
  Hooks.on('updateSetting', (doc) => {
    const raw = doc?.key ?? doc?.id ?? doc ?? '';
    const key = typeof raw === 'string' ? raw : '';
    if (key.endsWith('globalPlaylistVolume')) {
      setTimeout(_syncVol, 10);
    }
  });

  // Метод 2: DOM observer на штатный Foundry-ползунок «Музыка».
  // Во время перетаскивания Foundry не во всех версиях сразу пишет setting,
  // поэтому применяем input-событие напрямую к нашему плееру.
  const tryAttachSlider = () => {
    const sliders = document.querySelectorAll('input[type="range"]');
    let found = false;

    sliders.forEach(slider => {
      if (slider._lmWatched) return;
      if (!_isFoundryMusicVolumeSlider(slider)) return;

      slider._lmWatched = true;
      found = true;
      console.log('Lazy Music | Found Foundry music volume slider');

      const apply = () => _applyFoundryVol(slider.value);
      slider.addEventListener('input', apply);
      slider.addEventListener('change', apply);
    });

    return found;
  };

  Hooks.on('renderPlaylistDirectory', () => setTimeout(tryAttachSlider, 0));
  Hooks.on('renderSidebarTab', () => setTimeout(tryAttachSlider, 0));

  // Пробуем сразу
  if (!tryAttachSlider()) {
    // Панель не отрисована — ждём через MutationObserver
    const obs = new MutationObserver(() => {
      if (tryAttachSlider()) {
        obs.disconnect();
        console.log('Lazy Music | Volume slider attached via MutationObserver');
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), 30000);
  }

  // Метод 3: polling каждые 500мс — грубо, но работает как последний резерв
  // Только пока слайдер не найден через DOM
  let _pollCount = 0;
  const poll = setInterval(() => {
    _pollCount++;
    _syncVol(); // синхронизируем из game.settings
    if (tryAttachSlider() || _pollCount > 20) clearInterval(poll);
  }, 500);
}

function _isFoundryMusicVolumeSlider(slider) {
  if (slider.closest('#lazy-music-app, .lazy-music-app, #lm-mini')) return false;

  const text = _sliderContext(slider).toLowerCase();
  if (text.includes('globalplaylistvolume') || text.includes('global-playlist-volume')) return true;

  const inPlaylists = slider.closest('#playlists, .playlists-sidebar, [data-tab="playlists"], aside.playlists');
  if (!inPlaylists) return false;

  return text.includes('музык') || text.includes('music') ||
         text.includes('плейлист') || text.includes('playlist');
}

function _sliderContext(slider) {
  const parts = [
    slider.name,
    slider.id,
    slider.getAttribute('aria-label'),
    slider.getAttribute('title'),
    slider.getAttribute('data-tooltip'),
    slider.dataset?.setting,
    slider.dataset?.settingId,
  ];

  let node = slider;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    parts.push(
      node.textContent,
      node.className,
      node.id,
      node.getAttribute?.('aria-label'),
      node.getAttribute?.('title'),
      node.getAttribute?.('data-tooltip'),
      node.dataset?.setting,
      node.dataset?.settingId,
    );
  }

  return parts.filter(Boolean).join(' ');
}

// ── Кнопка LAZY MUSIC в панели ───────────────────────────────────────────────
function _injectButton(app, html) {
  const root = html instanceof HTMLElement ? html : html[0];
  if (!root || root.querySelector('#lm-panel-btn')) return;

  const btn = document.createElement('button');
  btn.id = 'lm-panel-btn';
  btn.className = 'lm-panel-btn';
  btn.innerHTML = `<i class="fas fa-compact-disc"></i> Lazy Music`;
  btn.addEventListener('click', () => LMApp.open());

  const header = root.querySelector('.directory-header, header');
  if (!header) return;

  const wrap = document.createElement('div');
  wrap.className = 'lm-panel-btn-wrap';
  wrap.appendChild(btn);
  header.after(wrap);
}

// ─── BurnHub tile (необязательная интеграция: без хаба вызов уходит в никуда) ───
Hooks.once("ready", () => {
  Hooks.callAll("hubRegisterTile", {
    moduleId: "lazy-music",
    title: "Lazy Music",
    icon: "fa-solid fa-music",
    order: 10,
    gmOnly: true,
    onClick: () => LMApp.open()
  });
});
