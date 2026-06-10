/**
 * Lazy Music — Entry Point v2.1.2
 */

import { LMApp }         from './app.mjs';
import { LMSocket }       from './socket.mjs';
import { LMSettings }     from './settings.mjs';
import { PlayerReceiver } from './player-receiver.mjs';

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
  LMSocket.init();

  // Одноразовая миграция: убираем секреты (API-ключи, Spotify-токен) из world-настроек
  LMSettings.migrateWorldSecrets().catch(e => console.warn('Lazy Music | migrate:', e));

  // Кнопка в панели плейлистов (только GM)
  if (game.user.isGM) {
    Hooks.on('renderPlaylistDirectory', _injectButton);
    const el = ui.playlists?.element;
    if (el) _injectButton(ui.playlists, el);
  }

  // Применяем текущую громкость сразу
  _syncVol();

  // Следим за громкостью — несколько методов параллельно для надёжности
  _setupVolumeSync();
});

// ── Читаем globalPlaylistVolume из Foundry ───────────────────────────────────
function _getFoundryVol() {
  try { return game.settings.get('core', 'globalPlaylistVolume') ?? 1; } catch { return 1; }
}

function _syncVol() {
  const vol = _getFoundryVol();
  PlayerReceiver.setFoundryVolume(vol);
  if (game.user.isGM) LMApp._instance?.applyFoundryVolume(vol);
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

  // Метод 2: DOM observer на ползунок — самый надёжный
  // Ищем все range input в панели плейлистов
  const tryAttachSlider = () => {
    // В Foundry v14 панель плейлистов — #playlists или .playlists-sidebar
    const panel = document.querySelector('#playlists, .playlists-sidebar, [data-tab="playlists"], aside.playlists');
    if (!panel) return false;

    // Ищем все range слайдеры в панели
    const sliders = panel.querySelectorAll('input[type=range]');
    let found = false;

    sliders.forEach((slider, idx) => {
      if (slider._lmWatched) return;

      // Определяем что это за ползунок по контексту
      const parent = slider.closest('li, .form-group, label, div');
      const text = (parent?.textContent || '').toLowerCase();
      const isMusic = text.includes('музык') || text.includes('music') ||
                      text.includes('playlist');

      if (isMusic) {
        slider._lmWatched = true;
        found = true;
        console.log('Lazy Music | Found volume slider, text context:', text.trim().slice(0, 40));

        slider.addEventListener('input', () => {
          const vol = parseFloat(slider.value);
          if (!isNaN(vol)) {
            PlayerReceiver.setFoundryVolume(vol);
            if (game.user.isGM) LMApp._instance?.applyFoundryVolume(vol);
          }
        });
      }
    });

    return found;
  };

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
