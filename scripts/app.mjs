/**
 * Lazy Music — GM Application (Foundry v14, ApplicationV2)
 */

import { LMSettings }   from './settings.mjs';
import { YouTubeAPI }   from './youtube-api.mjs';
import { LMSocket }     from './socket.mjs';
import { LMMini }       from './mini-player.mjs';
import { LMCache }      from './cache.mjs';

const MODULE_ID = 'lazy-music';

// Локализация: строки в lang/ru.json и lang/en.json (ключи LAZYMUSIC.*)
const L  = (k)    => game.i18n.localize(`LAZYMUSIC.${k}`);
const LF = (k, d) => game.i18n.format(`LAZYMUSIC.${k}`, d);

// Статический плеер — один на сессию
let _ytPlayer    = null;
let _ytReady     = false;
let _ytCallbacks = [];

function getYTPlayer() { return _ytPlayer; }

// HTML5-аудио GM для треков, идущих через наш сервер (обход ошибки 150)
let _gmAudio = null;

function getGMAudio() {
  if (!_gmAudio) {
    _gmAudio = new Audio();
    _gmAudio.preload = 'auto';
    _gmAudio.addEventListener('ended',   () => LMApp._instance?._onAudioEnded());
    _gmAudio.addEventListener('playing', () => LMApp._instance?._onAudioPlaying());
    _gmAudio.addEventListener('pause',   () => LMApp._instance?._onAudioPaused());
    _gmAudio.addEventListener('error',   () => LMApp._instance?._onAudioError());
  }
  return _gmAudio;
}

function initGMYTPlayer(onReady) {
  // Плеер уже готов — вызываем сразу
  if (_ytReady && _ytPlayer) {
    onReady?.(_ytPlayer);
    return;
  }

  // Плеер создаётся, ставим в очередь
  if (onReady) _ytCallbacks.push(onReady);

  // Уже создаём — ждём
  if (document.getElementById('lm-yt-gm')) return;

  // Создаём контейнер
  const d = document.createElement('div');
  d.id = 'lm-yt-gm';
  // ВАЖНО: минимальный размер должен быть > 0 и visible
  // иначе YouTube считает embed невидимым и блокирует autoplay
  d.style.cssText = 'position:fixed;width:1px;height:1px;bottom:0;left:0;clip:rect(0,0,0,0);pointer-events:none;';
  document.body.appendChild(d);

  const create = () => {
    if (_ytPlayer) return;
    _ytPlayer = new YT.Player('lm-yt-gm', {
      height: '2', width: '2',
      // Не передаём videoId при инициализации — это вызывает ошибки
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        rel: 0,
        modestbranding: 1
      },
      events: {
        onReady: () => {
          _ytReady = true;
          console.log('Lazy Music | GM YT Player ready');
          _ytCallbacks.forEach(cb => cb(_ytPlayer));
          _ytCallbacks = [];
        },
        onStateChange: (e) => LMApp._instance?._onYTState(e),
        onError:       (e) => LMApp._instance?._onYTError(e)
      }
    });
  };

  const loadAPI = () => {
    if (!document.getElementById('yt-iframe-api')) {
      const s = document.createElement('script');
      s.id = 'yt-iframe-api';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); create(); };
  };

  if (window.YT?.Player) create(); else loadAPI();
}

// ── Определяем базовый класс в зависимости от версии Foundry ─────────────────
const AppBase = foundry.applications?.api?.ApplicationV2 ?? Application;
const HandlebarsApp = foundry.applications?.api?.HandlebarsApplicationMixin?.(AppBase) ?? AppBase;

export class LMApp extends HandlebarsApp {
  constructor(options = {}) {
    super(options);
    this.playlists    = [];
    this.playlist     = null;
    this.tracks       = [];
    this.searchResults = [];
    this.searchMode   = false;
    this.track        = null;
    this.playing      = false;
    // volume берётся из game.settings 'core.globalPlaylistVolume' напрямую
    this.shuffle      = false;
    this.repeat       = false;
    this.trackIdx     = 0;
    this.position     = 0;
    this.duration     = 0;
    this.seeking      = false;
    this._progressInterval = null;
    this._playLock    = false;
    this.gmVolume     = parseFloat(localStorage.getItem('lm-gm-vol') ?? '1');
    this.relayMode    = false; // true — текущий трек играет через наш сервер, не через YT-iframe
    this._helperAlive = null;  // null — ещё не проверяли
  }

  // ── v14 ApplicationV2 options ─────────────────────────────────────────────
  static DEFAULT_OPTIONS = {
    id: 'lazy-music-app',
    classes: ['lazy-music-app'],
    tag: 'div',
    window: { title: 'Lazy Music', resizable: true, minimizable: true },
    position: { width: 720, height: 620 }
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/app.html` }
  };

  // ── v12/v13 fallback ──────────────────────────────────────────────────────
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions ?? {}, {
      id: 'lazy-music-app',
      title: 'Lazy Music',
      template: `modules/${MODULE_ID}/templates/app.html`,
      width: 720, height: 620,
      resizable: true, minimizable: true,
      classes: ['lazy-music-app']
    });
  }

  static _instance = null;

  static open() {
    if (!this._instance) {
      this._instance = new LMApp();
      // Загружаем сохранённые плейлисты сразу
      this._instance._refreshPlaylists();
    }
    // Что уже скачано и жив ли помощник — узнаём в фоне, окно ждать не должно.
    // render() в v12 возвращает сам объект, в v14 — промис; Promise.resolve ровняет.
    const app = this._instance;
    Promise.resolve(app.render(true)).then(() => app._syncCacheState());
    return app;
  }

  /** Перечитывает кэш и статус помощника, затем перерисовывает список. */
  async _syncCacheState() {
    await Promise.all([LMCache.refresh(), this._pingHelper()]);
    this.render(false); // при закрытом окне это no-op
  }

  _el() {
    return this.element instanceof HTMLElement ? this.element : this.element?.[0];
  }

  // Список плейлистов сайдбара: на вкладке YouTube сверху — свои (собранные
  // из поиска), затем обычные YouTube-плейлисты
  _refreshPlaylists() {
    const custom = LMSettings.getCustomPlaylists().map(p => ({
      id: p.id, name: p.name, trackCount: p.tracks.length,
      image: p.tracks[0]?.albumArt || '', source: 'youtube', custom: true
    }));
    this.playlists = [...custom, ...LMSettings.getPlaylists()];
  }

  // ── Template data ─────────────────────────────────────────────────────────
  async _prepareContext() { return this._getData(); }
  getData()               { return this._getData(); }

  _getData() {
    // Отмечаем, что уже лежит на диске: такие треки играют без помощника
    const tracks   = LMCache.mark(this.searchMode ? this.searchResults : this.tracks);
    const uncached = tracks.some(t => !t.cached);
    return {
      playlists: this.playlists,
      playlist: this.playlist,
      tracks,
      helperDown: this._helperAlive === false,
      // Подсказка «как закэшировать» нужна, только если нескачанное реально есть
      cacheHint: this._helperAlive === false && uncached,
      searchMode: this.searchMode,
      track: this.track,
      // Плашка «сейчас играет»: показываем обложку или заглушку, но не обе
      npArt:     this.track?.albumArt || '',
      npShowArt: !!this.track?.albumArt,
      npShowPh:  !!this.track && !this.track.albumArt,
      npTitle:   this.track ? (this.track.displayTitle || this.track.title || '') : '',
      npArtist:  this.track?.artist || '',
      playing: this.playing,
      volume: this._getFoundryVol(),
      shuffle: this.shuffle,
      repeat: this.repeat,
      ytApiKey: !!LMSettings.get('youtubeApiKey'),
      customView: !!this.playlist?.custom && !this.searchMode,
      canAddToCustom: !this.playlist?.custom,
      syncToPlayers: LMSettings.get('syncToPlayers'),
      gmVolume:    this.gmVolume,
      gmVolumePct: Math.round(this.gmVolume * 100)
    };
  }

  // ── Listeners ─────────────────────────────────────────────────────────────
  _attachListeners(html) {
    const root = html instanceof HTMLElement ? html : html[0];
    const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach(el => { el.removeEventListener(ev, el['_lm_' + sel + ev]); const h = fn.bind(this); el['_lm_' + sel + ev] = h; el.addEventListener(ev, h); });

    on('#lm-add-playlist',    'click', () => this._addPlaylistDialog());
    on('.lm-pl-item',         'click', e => { if (!e.target.closest('.lm-pl-del')) this._loadPlaylist(e.currentTarget.dataset.id); });
    on('.lm-pl-del',          'click', e => { e.stopPropagation(); this._delPlaylist(e.currentTarget.closest('.lm-pl-item').dataset.id); });
    on('.lm-track',           'click', e => { if (!e.target.closest('.lm-rename-btn, .lm-addpl-btn, .lm-deltrack-btn')) this._playIdx(+e.currentTarget.dataset.i); });
    on('.lm-rename-btn',      'click', e => { e.stopPropagation(); this._renameTrack(+e.currentTarget.closest('.lm-track').dataset.i); });
    on('.lm-addpl-btn',       'click', e => { e.stopPropagation(); this._addTrackToCustomDialog(+e.currentTarget.closest('.lm-track').dataset.i); });
    on('.lm-deltrack-btn',    'click', e => { e.stopPropagation(); this._removeTrackFromCustom(+e.currentTarget.closest('.lm-track').dataset.i); });
    on('#lm-play-pause',      'click', () => this._togglePlay());
    on('#lm-prev',            'click', () => this._prev());
    on('#lm-next',            'click', () => this._next());
    on('#lm-stop',            'click', () => this._stop());
    on('#lm-shuffle',         'click', () => { this.shuffle = !this.shuffle; root.querySelector('#lm-shuffle')?.classList.toggle('active', this.shuffle); });
    on('#lm-repeat',          'click', () => { this.repeat  = !this.repeat;  root.querySelector('#lm-repeat')?.classList.toggle('active', this.repeat); });
    // Громкость управляется ползунком 'Музыка' в панели Foundry
    on('#lm-search-input',    'keydown', e => { if (e.key === 'Enter') this._search(e.target.value); });
    on('#lm-search-btn',      'click', () => this._search(root.querySelector('#lm-search-input')?.value));
    on('#lm-clear-search',    'click', () => { this.searchMode = false; this.searchResults = []; this.render(false); });
    on('#lm-sync-toggle',     'change', e => this._setSync(e.target.checked));
    on('#lm-open-cache',      'click', () => this._openCacheFolder());
    on('#lm-clear-cache',     'click', () => this._clearCache());
    on('#lm-gm-vol-slider',   'input',  e => this._setGMVolume(parseFloat(e.target.value)));

    // Progress bar drag
    const pb = root.querySelector('#lm-progress-bar');
    if (pb) {
      pb.addEventListener('pointerdown', (e) => {
        this.seeking = true;
        pb.setPointerCapture(e.pointerId);
        const pct = (e.clientX - pb.getBoundingClientRect().left) / pb.offsetWidth;
        this._updateProgressUI(pct);
        const up = (ev) => {
          this.seeking = false;
          pb.releasePointerCapture(ev.pointerId);
          this._seekTo((ev.clientX - pb.getBoundingClientRect().left) / pb.offsetWidth);
          pb.removeEventListener('pointermove', move);
          pb.removeEventListener('pointerup', up);
        };
        const move = (ev) => {
          const p = Math.max(0, Math.min(1, (ev.clientX - pb.getBoundingClientRect().left) / pb.offsetWidth));
          this._updateProgressUI(p);
        };
        pb.addEventListener('pointermove', move);
        pb.addEventListener('pointerup', up);
      });
    }

    // Init YT player
    initGMYTPlayer();
  }

  // ApplicationV2 hook
  _onRender(context, options) { this._attachListeners(this.element); }
  // v12/v13 hook
  activateListeners(html)     { super.activateListeners?.(html); this._attachListeners(html); }

  // ── Playlists ─────────────────────────────────────────────────────────────
  async _addPlaylistDialog() {
    const label = L('PlaylistUrlYT');
    let url;
    // v14 DialogV2
    if (foundry.applications?.api?.DialogV2) {
      url = await foundry.applications.api.DialogV2.prompt({
        window: { title: L('AddPlaylist') },
        content: `<div style="padding:8px"><label>${label}</label><input type="text" name="url" style="width:100%;margin-top:4px;background:#1a1a24;border:1px solid #2a2a3e;color:#e8e0d0;padding:5px 8px;border-radius:4px;" autofocus></div>`,
        ok: { callback: (event) => event.target.closest('form')?.querySelector('[name=url]')?.value?.trim() ?? event.target.form?.url?.value?.trim() ?? '' }
      }).catch(() => null);
    } else {
      url = await Dialog.prompt({
        title: L('AddPlaylist'),
        content: `<div class="form-group"><label>${label}</label><input type="text" id="pl-url" style="width:100%"></div>`,
        callback: h => h.find('#pl-url').val()?.trim(),
        rejectClose: false
      }).catch(() => null);
    }
    if (!url) return;
    await this._addYTPlaylist(url);
  }

  async _addYTPlaylist(url) {
    try {
      ui.notifications.info(L('LoadingPlaylistInfo'));
      const id   = YouTubeAPI.extractPlaylistId(url);
      const info = await YouTubeAPI.getPlaylistInfo(id);
      const pl   = { id, name: info.snippet.title, trackCount: info.contentDetails.itemCount, image: info.snippet.thumbnails?.medium?.url || '', source: 'youtube' };
      LMSettings.addPlaylist(pl);
      this._refreshPlaylists();
      this.render(false);
      ui.notifications.info(LF('PlaylistAdded', { name: pl.name }));
    } catch (e) { ui.notifications.error(LF('YouTubeError', { error: e.message })); }
  }

  _delPlaylist(id) {
    if (id.startsWith('custom-')) LMSettings.deleteCustomPlaylist(id);
    else LMSettings.removePlaylist(id);
    this._refreshPlaylists();
    if (this.playlist?.id === id) { this.playlist = null; this.tracks = []; }
    this.render(false);
  }

  async _loadPlaylist(id) {
    const pl = this.playlists.find(p => p.id === id);
    if (!pl) return;
    this.playlist = pl;

    // Свой плейлист — треки лежат локально, в сеть ходить не нужно
    if (pl.custom) {
      const stored = LMSettings.getCustomPlaylists().find(p => p.id === id);
      this.tracks = (stored?.tracks ?? []).map(t => {
        const customName = LMSettings.getTrackName(t.id);
        return { ...t, displayTitle: customName || t.title, isRenamed: !!customName };
      });
      this.searchMode = false; this.searchResults = [];
      this.render(false);
      this._syncCacheState();
      return;
    }

    ui.notifications.info(LF('LoadingPlaylist', { name: pl.name }));
    try {
      this.tracks = await YouTubeAPI.getPlaylistItems(id);
      this.render(false);
      this._syncCacheState();
    } catch (e) { ui.notifications.error(LF('LoadFailed', { error: e.message })); }
  }

  // ── Свои плейлисты: добавление/удаление треков ────────────────────────────

  async _addTrackToCustomDialog(i) {
    const pool  = this.searchMode ? this.searchResults : this.tracks;
    const track = pool[i];
    if (!track || track.source !== 'youtube') return;

    const esc = (s) => foundry.utils.escapeHTML(String(s || ''));
    const customs = LMSettings.getCustomPlaylists();
    const options = customs.map(p => `<option value="${p.id}">${esc(p.name)} (${p.tracks.length})</option>`).join('')
      + `<option value="__new__"${customs.length ? '' : ' selected'}>${L('NewPlaylistOption')}</option>`;
    const inputStyle = 'width:100%;margin-top:4px;background:#1a1a24;border:1px solid #2a2a3e;color:#e8e0d0;padding:5px 8px;border-radius:4px;';
    const content = `<div style="padding:8px">
      <div style="margin-bottom:8px;color:#8a8270;font-size:12px;">${esc(track.displayTitle || track.title)}</div>
      <label>${L('WhichPlaylist')}</label>
      <select name="pl" style="${inputStyle}">${options}</select>
      <label style="display:block;margin-top:8px;">${L('NewPlaylistName')}</label>
      <input type="text" name="newname" placeholder="${L('NewPlaylistPlaceholder')}" style="${inputStyle}">
    </div>`;

    let result;
    if (foundry.applications?.api?.DialogV2) {
      result = await foundry.applications.api.DialogV2.prompt({
        window: { title: L('AddToCustom') },
        content,
        ok: { callback: (event) => {
          const form = event.target.closest('form') ?? event.target.form;
          return { pl: form?.querySelector('[name=pl]')?.value, newname: form?.querySelector('[name=newname]')?.value?.trim() };
        } }
      }).catch(() => null);
    } else {
      result = await Dialog.prompt({
        title: L('AddToCustom'),
        content,
        callback: h => ({ pl: h.find('[name=pl]').val(), newname: h.find('[name=newname]').val()?.trim() }),
        rejectClose: false
      }).catch(() => null);
    }
    if (!result) return;

    let plId = result.pl;
    if (plId === '__new__' || result.newname) {
      plId = LMSettings.createCustomPlaylist(result.newname).id;
    }
    if (!plId) return;

    const added = LMSettings.addTrackToCustomPlaylist(plId, track);
    const plName = LMSettings.getCustomPlaylists().find(p => p.id === plId)?.name ?? '';
    ui.notifications.info(added
      ? LF('TrackAdded', { track: track.displayTitle || track.title, playlist: plName })
      : LF('AlreadyInPlaylist', { name: plName }));
    this._refreshPlaylists();
    this.render(false);
  }

  _removeTrackFromCustom(i) {
    if (!this.playlist?.custom) return;
    const track = this.tracks[i];
    if (!track) return;
    LMSettings.removeTrackFromCustomPlaylist(this.playlist.id, track.id);
    this.tracks.splice(i, 1);
    if (this.trackIdx > i) this.trackIdx--;
    this._refreshPlaylists();
    this.render(false);
  }

  // ── Player synchronization ───────────────────────────────────────────────

  _syncEnabled() {
    return !!LMSettings.get('syncToPlayers');
  }

  _currentPlaybackPayload() {
    if (!this.track) return null;
    const position = this.relayMode
      ? (getGMAudio().currentTime || this.position || 0)
      : (getYTPlayer()?.getCurrentTime?.() || this.position || 0);
    const track = {
      ...this.track,
      videoId: this.track.id,
      position,
      title: this.track.displayTitle || this.track.title
    };
    if (this.relayMode) track.streamUrl = this._relayUrl || getGMAudio().src;
    return { track, playing: this.playing };
  }

  _emitState(targetId = null) {
    LMSocket.emit('state', {
      gmVolume: this.gmVolume,
      playback: this._currentPlaybackPayload()
    }, { targetId });
  }

  async _setSync(enabled) {
    const wasEnabled = this._syncEnabled();
    if (wasEnabled && !enabled) LMSocket.emit('stop');
    await LMSettings.set('syncToPlayers', enabled);
    if (enabled) this._emitState();
  }

  syncStateToPlayer(userId) {
    if (!this._syncEnabled() || !userId) return;
    this._emitState(userId);
  }

  // ── Playback ──────────────────────────────────────────────────────────────
  async _playIdx(i) {
    if (this._playLock) return;
    this._playLock = true;
    setTimeout(() => this._playLock = false, 300);

    const pool = this.searchMode ? this.searchResults : this.tracks;
    if (i < 0 || i >= pool.length) return;
    this.trackIdx  = i;
    this.track     = pool[i];
    this.position  = 0;
    this.duration  = 0;
    this.playing   = true;
    if (this.searchMode) this.tracks = [...this.searchResults];

    this._updateNowPlaying();

    // Сначала кэш на диске, потом ретранслятор, в последнюю очередь YT-iframe.
    this._playTrack(this.track.id);
  }

  // ── Откуда берётся звук ───────────────────────────────────────────────────
  //
  // По порядку:
  //  0. Файл уже лежит в modules/lazy-music/cache/ — играем прямо оттуда.
  //     Помощник для этого не нужен вовсе: папку раздаёт сам Foundry, а её
  //     содержимое модуль видит через FilePicker.browse (см. cache.mjs).
  //     Сюда же попадают файлы, положенные в cache/ вручную.
  //  1. Встроенный помощник (server/helper.mjs) на машине GM — скачивает
  //     недостающее в ту же папку и возвращает ОТНОСИТЕЛЬНЫЙ путь, который
  //     каждый клиент открывает со своего же адреса Foundry.
  //  2. Внешний сервер из настройки serverUrl (старый способ, P:\сайт).
  //  3. Никто не ответил — откат на YouTube-iframe, как раньше, плюс подсказка
  //     в окне модуля о том, как включить кэширование.

  static HELPER_URL = 'http://127.0.0.1:8766';

  _serverUrl() {
    const u = (LMSettings.get('serverUrl') || '').trim().replace(/\/+$/, '');
    return u || null;
  }

  _relaySources() {
    const h = LMApp.HELPER_URL;
    const sources = [{
      name:        'помощник',
      local:       true, // качает в нашу же папку cache/ — результат можно запомнить
      ping:        () => `${h}/api/ping`,
      ensure:      id => `${h}/api/yt/ensure?id=${encodeURIComponent(id)}`,
      prefetch:    id => `${h}/api/yt/prefetch?id=${encodeURIComponent(id)}`,
      cacheStatus: () => `${h}/api/cache/status`,
      cacheClear:  () => `${h}/api/cache/clear`,
      cacheClearOptions: { method: 'POST' },
      resolve:     d  => d.url
    }];
    const server = this._serverUrl();
    if (server) sources.push({
      name:        'сервер',
      local:       false,
      ping:        () => `${server}/api/cache/status`,
      ensure:      id => `${server}/api/yt/ensure?id=${encodeURIComponent(id)}`,
      prefetch:    id => `${server}/api/yt/prefetch?id=${encodeURIComponent(id)}`,
      cacheStatus: () => `${server}/api/cache/status`,
      cacheClear:  () => `${server}/api/cache/clear`,
      cacheClearOptions: {},
      resolve:     d  => server + d.url
    });
    return sources;
  }

  /** Жив ли хоть один ретранслятор. Результат оседает в this._helperAlive. */
  async _pingHelper() {
    for (const s of this._relaySources()) {
      try {
        const res = await fetch(s.ping(), { signal: AbortSignal.timeout(1500) });
        if (res.ok) return this._helperAlive = true;
      } catch { /* не отвечает — пробуем следующий */ }
    }
    return this._helperAlive = false;
  }

  async _openCacheFolder() {
    try {
      const res = await fetch(`${LMApp.HELPER_URL}/api/cache/open`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.opened) throw new Error(data.error || `HTTP ${res.status}`);
      ui.notifications.info(L('CacheOpened'));
    } catch {
      ui.notifications.warn(L('HelperDownOpen'));
    }
  }

  // ── Очистка кэша скачанной музыки (кнопка-метла в шапке) ──────────────────
  async _clearCache() {
    for (const s of this._relaySources()) {
      let st;
      try {
        const res = await fetch(s.cacheStatus());
        st = await res.json();
        if (!res.ok) continue;
      } catch { continue; } // источник не отвечает — пробуем следующий

      const mb = (st.bytes / 1048576).toFixed(0);
      if (!st.files) {
        ui.notifications.info(L('CacheEmpty'));
        return;
      }

      const msg = LF('CacheConfirm', { files: st.files, mb });
      let ok;
      if (foundry.applications?.api?.DialogV2) {
        ok = await foundry.applications.api.DialogV2.confirm({
          window: { title: L('CacheTitle') },
          content: `<p>${msg}</p>`
        }).catch(() => false);
      } else {
        ok = await Dialog.confirm({ title: L('CacheTitle'), content: `<p>${msg}</p>` }).catch(() => false);
      }
      if (!ok) return;

      try {
        const data = await (await fetch(s.cacheClear(), s.cacheClearOptions)).json();
        const freedMb = (data.freed / 1048576).toFixed(0);
        const skipped = st.files - data.cleared;
        ui.notifications.info(LF('CacheCleared', { files: data.cleared, mb: freedMb }) +
          (skipped > 0 ? LF('CacheSkipped', { n: skipped }) : ''));
        this._syncCacheState(); // точки «в кэше» должны погаснуть
      } catch (e) {
        ui.notifications.error(LF('CacheError', { error: e?.message ?? e }));
      }
      return;
    }
    ui.notifications.warn(L('HelperDownCache'));
  }

  async _playTrack(videoId) {
    // 0. Уже на диске — играем немедленно, никого не спрашивая
    const local = LMCache.get(videoId);
    if (local) {
      this._startFromFile(videoId, local);
      return;
    }

    // 1. Нет — просим ретранслятор скачать. Если дольше 1.5 сек, предупреждаем
    const notify = setTimeout(() =>
      ui.notifications.info(L('Caching')), 1500);

    // Различаем «никто не ответил» (помощник не запущен) и «ответил отказом»
    // (запущен, но конкретный трек не скачался — например, протухли cookies).
    let url = null, source = null, answered = false, failure = null;
    for (const s of this._relaySources()) {
      try {
        const res  = await fetch(s.ensure(videoId));
        answered = true;
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ready) throw new Error(data.error || `HTTP ${res.status}`);
        url = s.resolve(data);
        source = s;
        break;
      } catch (e) {
        failure = e?.message ?? String(e);
        console.warn(`Lazy Music | ретранслятор «${s.name}»:`, failure);
      }
    }
    clearTimeout(notify);
    if (this.track?.id !== videoId) return; // пока качалось — включили другой трек

    this._helperAlive = answered;

    // 2. Скачать не вышло — играем по-старому через YouTube. Если помощника
    //    вовсе нет, в окне появляется подсказка, как включить кэширование
    if (!url) {
      if (answered) {
        ui.notifications.warn(LF('CacheFailed', { error: failure ?? '' }));
      } else if (!this._relayWarned) {
        this._relayWarned = true;
        ui.notifications.warn(L('HelperFallback'));
      }
      this.render(false); // показать подсказку и пригасить нескачанные треки
      this.relayMode = false;
      this._relayUrl = null;
      _gmAudio?.pause();
      initGMYTPlayer((p) => {
        if (this.track?.id !== videoId) return;
        p.setVolume(Math.round(this._getFoundryVol() * 100));
        p.loadVideoById(videoId);
      });
      if (this._syncEnabled()) {
        LMSocket.emit('play', {
          ...this.track, videoId, position: 0,
          title: this.track.displayTitle || this.track.title
        });
      }
      return;
    }

    // Помощник качает в нашу же папку — значит трек теперь в кэше навсегда.
    // Внешний сервер держит файлы у себя, его ответ запоминать нельзя.
    if (source.local) {
      LMCache.remember(videoId, url);
      this._markCached(videoId);
    }
    this._startFromFile(videoId, url, source);
  }

  /** Играет готовый файл (из кэша или от ретранслятора) и рассылает игрокам. */
  _startFromFile(videoId, url, source = null) {
    this.relayMode = true;
    this._relayUrl = url; // в сокет шлём именно его: относительный путь у каждого клиента свой
    getYTPlayer()?.stopVideo?.(); // глушим YT-iframe, если играл

    const audio = getGMAudio();
    audio.src = url;
    audio.volume = Math.min(1, this._getFoundryVol() * this.gmVolume);
    audio.play().catch(e => console.warn('Lazy Music | GM autoplay blocked:', e?.message));

    if (this._syncEnabled()) {
      LMSocket.emit('play', {
        ...this.track, videoId, streamUrl: url, position: 0,
        title: this.track.displayTitle || this.track.title
      });
    }

    this._prefetchNext(videoId, source);
  }

  /** Греет кэш следующего трека, чтобы переход был мгновенным. */
  _prefetchNext(videoId, source = null) {
    if (this.shuffle || this.tracks.length < 2) return;
    const next = this.tracks[(this.trackIdx + 1) % this.tracks.length];
    if (!next || next.id === videoId || next.source !== 'youtube') return;
    if (LMCache.has(next.id)) return;               // уже на диске, качать нечего
    if (this._helperAlive === false) return;        // качать некому
    const s = source ?? this._relaySources()[0];
    fetch(s.prefetch(next.id)).catch(() => {});
  }

  /** Зажигает точку «в кэше» у трека, не перерисовывая весь список. */
  _markCached(videoId) {
    const el = this._el();
    const pool = this.searchMode ? this.searchResults : this.tracks;
    pool.forEach((t, i) => {
      if (t.id !== videoId) return;
      t.cached = true;
      el?.querySelector(`.lm-track[data-i="${i}"]`)?.classList.add('lm-cached');
    });
  }

  // ── События HTML5-аудио GM (зеркало _onYTState) ───────────────────────────

  _onAudioEnded() {
    if (!this.relayMode) return;
    if (this.repeat) {
      const a = getGMAudio();
      a.currentTime = 0;
      a.play().catch(() => {});
      // Перезапускаем и у игроков
      if (this._syncEnabled() && this.track) {
        LMSocket.emit('play', {
          ...this.track, videoId: this.track.id, streamUrl: this._relayUrl || a.src, position: 0,
          title: this.track.displayTitle || this.track.title
        });
      }
    } else {
      this._next();
    }
  }

  _onAudioPlaying() {
    if (!this.relayMode) return;
    this.playing  = true;
    this.duration = getGMAudio().duration || 0;
    this._skippedIds?.clear();
    this._retriedIds?.clear();
    this._errorHandling = false;
    this._startProgress();
    this._updatePlayBtn();
  }

  _onAudioPaused() {
    if (!this.relayMode) return;
    this.playing = false;
    this._stopProgress();
    this._updatePlayBtn();
  }

  _onAudioError() {
    if (!this.relayMode || !this.track) return;
    if (this._errorHandling) return;

    // Файл из кэша не открылся — значит его удалили с диска мимо нас
    // (почистили папку руками). Забываем запись и один раз качаем заново.
    const id = this.track.id;
    if (LMCache.get(id) === this._relayUrl && !this._retriedIds?.has(id)) {
      (this._retriedIds ??= new Set()).add(id);
      LMCache.forget(id);
      console.warn(`Lazy Music | ${id}: файла нет на диске, качаю заново`);
      this._playTrack(id);
      return;
    }

    this._errorHandling = true;
    const name = this.track?.displayTitle || this.track?.title || 'Unknown';
    ui.notifications.warn(LF('StreamError', { name }));
    setTimeout(() => { this._errorHandling = false; this._next(); }, 1200);
  }

  _togglePlay() {
    if (!this.track) return;
    if (this.relayMode) {
      const a = getGMAudio();
      if (this.playing) {
        a.pause();
        if (this._syncEnabled()) LMSocket.emit('pause');
      } else {
        a.play().catch(() => {});
        if (this._syncEnabled()) {
          LMSocket.emit('play', { ...this.track, videoId: this.track.id, streamUrl: this._relayUrl || a.src, position: a.currentTime || this.position });
        }
      }
    } else {
      const p = getYTPlayer();
      if (this.playing) {
        p?.pauseVideo?.();
        if (this._syncEnabled()) LMSocket.emit('pause');
      } else {
        p?.playVideo?.();
        if (this._syncEnabled()) {
          LMSocket.emit('play', { ...this.track, videoId: this.track.id, position: this.position });
        }
      }
    }
    this.playing = !this.playing;
    this._updatePlayBtn();
  }

  _stop() {
    getYTPlayer()?.stopVideo?.();
    if (_gmAudio) { _gmAudio.pause(); _gmAudio.removeAttribute('src'); _gmAudio.load(); }
    this.relayMode = false;
    this._relayUrl = null;
    this.playing = false; this.track = null; this.duration = 0;
    LMMini.stop();
    if (this._syncEnabled()) LMSocket.emit('stop');
    this._stopProgress();
    this.render(false);
  }

  _prev() {
    if (this.position > 3) { this._seekTo(0); return; }
    const i = this.shuffle ? Math.floor(Math.random() * this.tracks.length) : Math.max(0, this.trackIdx - 1);
    this._playIdx(i);
  }

  _next() {
    let i = this.shuffle ? Math.floor(Math.random() * this.tracks.length) : this.trackIdx + 1;
    if (!this.shuffle && i >= this.tracks.length) { if (this.repeat) i = 0; else return this._stop(); }
    this._playIdx(i);
  }

  _getFoundryVol() {
    try { return game.settings.get('core', 'globalPlaylistVolume') ?? 1; } catch { return 1; }
  }

  // Ползунок GM громкости для всех игроков
  _setGMVolume(vol) {
    this.gmVolume = Math.max(0, Math.min(1, vol));
    localStorage.setItem('lm-gm-vol', this.gmVolume);
    // Обновляем подпись в реальном времени без перерисовки
    const el = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    el?.querySelector('#lm-gm-vol-pct') && (el.querySelector('#lm-gm-vol-pct').textContent = Math.round(this.gmVolume * 100) + '%');
    // Транслируем игрокам
    if (this._syncEnabled()) LMSocket.emit('gmvol', { vol: this.gmVolume });
    LMMini.syncMaster(this.gmVolume);
    // Применяем к своему GM плееру тоже (умножаем на Foundry vol)
    const effective = this.gmVolume * this._getFoundryVol();
    getYTPlayer()?.setVolume?.(Math.round(effective * 100));
    if (_gmAudio) _gmAudio.volume = Math.min(1, effective);
  }

  // Вызывается из main.mjs когда GM двигает ползунок "Музыка"
  applyFoundryVolume(vol) {
    // GM плеер: Foundry vol * gmVolume
    const effective = vol * this.gmVolume;
    getYTPlayer()?.setVolume?.(Math.round(effective * 100));
    if (_gmAudio) _gmAudio.volume = Math.min(1, effective);
  }

  _seekTo(pct) {
    const dur = this.duration
      || (this.relayMode ? getGMAudio().duration : getYTPlayer()?.getDuration?.())
      || 0;
    if (!dur) return;
    const pos = Math.max(0, Math.min(1, pct)) * dur;
    this.position = pos;
    if (this.relayMode) { try { getGMAudio().currentTime = pos; } catch {} }
    else getYTPlayer()?.seekTo?.(pos, true);
    if (this._syncEnabled()) LMSocket.emit('seek', { pos });
    this._updateProgressBar();
  }

  // ── YT Events ─────────────────────────────────────────────────────────────
  _onYTState(e) {
    if (this.relayMode) return; // трек идёт через сервер — YT-плеер заглушён
    if (e.data === 0) { // ended
      if (this.repeat) {
        getYTPlayer()?.seekTo(0);
        getYTPlayer()?.playVideo();
        if (this._syncEnabled() && this.track) {
          LMSocket.emit('play', {
            ...this.track,
            videoId: this.track.id,
            position: 0,
            title: this.track.displayTitle || this.track.title
          });
        }
      }
      else this._next();
    } else if (e.data === 1) { // playing
      this.playing  = true;
      this.duration = getYTPlayer()?.getDuration?.() || 0;
      this._skippedIds?.clear(); // сбрасываем счётчик пропущенных при успехе
      this._errorHandling = false;
      this._startProgress();
      this._updatePlayBtn();
    } else if (e.data === 2) { // paused
      this.playing = false;
      this._stopProgress();
      this._updatePlayBtn();
    }
  }

  _onYTError(e) {
    if (this.relayMode) return; // трек идёт через сервер — ошибки YT не интересны
    // Защита от одновременных вызовов
    if (this._errorHandling) return;
    this._errorHandling = true;

    const name = this.track?.displayTitle || this.track?.title || 'Unknown';
    const msgs = { 150: L('ErrEmbed'), 101: L('ErrEmbed'), 100: L('ErrUnavailable') };

    // Инициализируем список пропущенных если нет
    if (!this._skippedIds) this._skippedIds = new Set();
    if (this.track?.id) this._skippedIds.add(this.track.id);

    // Если пропустили все треки — останавливаемся
    if (this._skippedIds.size >= this.tracks.length) {
      this._skippedIds.clear();
      this._errorHandling = false;
      ui.notifications.error(L('AllTracksBlocked'));
      this._stop();
      return;
    }

    ui.notifications.warn(LF('TrackSkip', { name, reason: msgs[e.data] || LF('ErrCode', { code: e.data }) }));

    // Задержка перед следующим треком — предотвращает быстрый цикл
    setTimeout(() => {
      this._errorHandling = false;
      this._next();
    }, 1200);
  }

  // ── Search ────────────────────────────────────────────────────────────────
  async _search(q) {
    if (!q?.trim()) return;
    this.searchMode = true;
    try {
      this.searchResults = await YouTubeAPI.search(q);
      this.render(false);
      this._syncCacheState();
    } catch (e) { ui.notifications.error(LF('SearchFailed', { error: e.message })); }
  }

  // ── Rename ────────────────────────────────────────────────────────────────
  async _renameTrack(i) {
    const pool  = this.searchMode ? this.searchResults : this.tracks;
    const track = pool[i];
    if (!track) return;
    const cur = LMSettings.getTrackName(track.id) || track.title;
    let name;
    if (foundry.applications?.api?.DialogV2) {
      const esc = (s) => foundry.utils.escapeHTML(String(s || ''));
      name = await foundry.applications.api.DialogV2.prompt({
        window: { title: L('RenameTrack') },
        content: `<div style="padding:8px">
          <label>${L('NewName')}</label>
          <input type="text" name="name" value="${esc(cur)}" style="width:100%;margin-top:4px;background:#1a1a24;border:1px solid #2a2a3e;color:#e8e0d0;padding:5px 8px;border-radius:4px;" autofocus>
          <div style="margin-top:6px;font-size:11px;color:#8a8270;">${L('Original')} ${esc(track.title)}</div>
        </div>`,
        ok: { callback: (event) => event.target.closest('form')?.querySelector('[name=name]')?.value?.trim() ?? event.target.form?.name?.value?.trim() ?? '' }
      }).catch(() => null);
    } else {
      name = await Dialog.prompt({
        title: L('RenameTrack'),
        content: `<div class="form-group"><label>${L('NewName')}</label><input type="text" id="rn" value="${cur}" style="width:100%"></div><p style="font-size:11px;color:#8a8270;">${L('Original')} ${track.title}</p>`,
        callback: h => h.find('#rn').val()?.trim(),
        rejectClose: false
      }).catch(() => null);
    }
    if (name === null || name === undefined) return;
    LMSettings.setTrackName(track.id, name || null);
    const hasCustom = !!LMSettings.getTrackName(track.id);
    track.displayTitle = hasCustom ? LMSettings.getTrackName(track.id) : track.title;
    track.isRenamed = hasCustom;
    // Обновить DOM напрямую
    const el = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    const nameEl = el?.querySelector(`.lm-track[data-i="${i}"] .lm-track-name`);
    if (nameEl) { nameEl.textContent = track.displayTitle; nameEl.classList.toggle('lm-renamed', hasCustom); }
  }

  // ── Progress ──────────────────────────────────────────────────────────────
  _startProgress() {
    this._stopProgress();
    this._progressInterval = setInterval(() => {
      if (this.seeking) return;
      if (this.relayMode) {
        const a = getGMAudio();
        this.position = a.currentTime || 0;
        this.duration = a.duration || this.duration;
        this._updateProgressBar();
        return;
      }
      const p = getYTPlayer();
      if (p?.getCurrentTime) {
        this.position = p.getCurrentTime();
        this.duration = p.getDuration?.() || this.duration;
        this._updateProgressBar();
      }
    }, 500);
  }

  _stopProgress() { clearInterval(this._progressInterval); this._progressInterval = null; }

  _updateProgressBar() {
    const el = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    if (!el) return;
    const pct = this.duration > 0 ? (this.position / this.duration) * 100 : 0;
    el.querySelector('#lm-progress-fill')?.style && (el.querySelector('#lm-progress-fill').style.width = pct + '%');
    el.querySelector('#lm-time-cur') && (el.querySelector('#lm-time-cur').textContent = this._fmt(this.position));
    el.querySelector('#lm-time-tot') && (el.querySelector('#lm-time-tot').textContent = this._fmt(this.duration));
  }

  _updateProgressUI(pct) {
    const el = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    if (!el) return;
    el.querySelector('#lm-progress-fill')?.style && (el.querySelector('#lm-progress-fill').style.width = (pct * 100) + '%');
    el.querySelector('#lm-time-cur') && (el.querySelector('#lm-time-cur').textContent = this._fmt(pct * this.duration));
  }

  _updatePlayBtn() {
    LMMini.setPlaying(this.playing);
    const el = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    const icon = el?.querySelector('#lm-play-pause i');
    if (icon) { icon.className = 'fas ' + (this.playing ? 'fa-pause' : 'fa-play'); }
  }

  _updateNowPlaying() {
    const t = this.track;
    if (t) LMMini.update({ title: t.displayTitle || t.title || '', playing: true });
    const el = this._el();
    if (!el) return;

    // Все части плашки есть в разметке всегда — переключаем видимость.
    // Раньше здесь только заполнялись существующие элементы, и при первом же
    // треке после открытия окна в DOM была лишь надпись «ничего не играет»:
    // заполнять было нечего, и она так и висела до следующей перерисовки.
    const show = (sel, on) => el.querySelector(sel)?.toggleAttribute('hidden', !on);
    show('.lm-no-track',  !t);
    show('.lm-np-info',   !!t);
    show('img.lm-np-art', !!t?.albumArt);
    show('.lm-np-art-ph', !!t && !t.albumArt);
    if (!t) return;

    const art = el.querySelector('img.lm-np-art');
    if (art && t.albumArt) art.src = t.albumArt;
    el.querySelector('.lm-np-title')  && (el.querySelector('.lm-np-title').textContent  = t.displayTitle || t.title || '');
    el.querySelector('.lm-np-artist') && (el.querySelector('.lm-np-artist').textContent = t.artist || '');
    el.querySelectorAll('.lm-track').forEach(row => row.classList.toggle('active', +row.dataset.i === this.trackIdx));
  }

  _fmt(s) { s = Math.floor(s || 0); return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`; }

  close(options = {}) {
    this._stopProgress();
    // НЕ обнуляем _instance — иначе next/prev перестают работать когда окно закрыто
    // Инстанс живёт всю сессию, хранит треки и состояние плеера
    return super.close(options);
  }
}

// Кнопки мини-плеера у ГМ (см. mini-player.mjs — он не импортирует app.mjs сам)
LMMini.gmControls = {
  prev:   () => LMApp._instance?._prev(),
  next:   () => LMApp._instance?._next(),
  toggle: () => LMApp._instance?._togglePlay(),
  master: (v) => LMApp._instance?._setGMVolume(v),
};
