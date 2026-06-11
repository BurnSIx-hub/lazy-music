/**
 * Lazy Music — GM Application (Foundry v14, ApplicationV2)
 */

import { LMSettings }   from './settings.mjs';
import { YouTubeAPI }   from './youtube-api.mjs';
import { SpotifyAPI }   from './spotify-api.mjs';
import { LMSocket }     from './socket.mjs';
import { LMMini }       from './mini-player.mjs';

const MODULE_ID = 'lazy-music';

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
    this.source       = 'youtube';
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
    this._oauthHandler = null;
    this.relayMode    = false; // true — текущий трек играет через наш сервер, не через YT-iframe
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
      this._instance.playlists = LMSettings.getPlaylists(this._instance.source);
    }
    this._instance.render(true);
    return this._instance;
  }

  // ── Template data ─────────────────────────────────────────────────────────
  async _prepareContext() { return this._getData(); }
  getData()               { return this._getData(); }

  _getData() {
    return {
      source: this.source,
      playlists: this.playlists,
      playlist: this.playlist,
      tracks: this.searchMode ? this.searchResults : this.tracks,
      searchMode: this.searchMode,
      track: this.track,
      playing: this.playing,
      volume: this._getFoundryVol(),
      shuffle: this.shuffle,
      repeat: this.repeat,
      ytApiKey: !!LMSettings.get('youtubeApiKey'),
      spLoggedIn: LMSettings.spotifyLoggedIn(),
      syncToPlayers: LMSettings.get('syncToPlayers'),
      gmVolume:    this.gmVolume,
      gmVolumePct: Math.round(this.gmVolume * 100)
    };
  }

  // ── Listeners ─────────────────────────────────────────────────────────────
  _attachListeners(html) {
    const root = html instanceof HTMLElement ? html : html[0];
    const on = (sel, ev, fn) => root.querySelectorAll(sel).forEach(el => { el.removeEventListener(ev, el['_lm_' + sel + ev]); const h = fn.bind(this); el['_lm_' + sel + ev] = h; el.addEventListener(ev, h); });

    on('[data-source]',       'click', e => this._setSource(e.currentTarget.dataset.source));
    on('#lm-add-playlist',    'click', () => this._addPlaylistDialog());
    on('.lm-pl-item',         'click', e => { if (!e.target.closest('.lm-pl-del')) this._loadPlaylist(e.currentTarget.dataset.id); });
    on('.lm-pl-del',          'click', e => { e.stopPropagation(); this._delPlaylist(e.currentTarget.closest('.lm-pl-item').dataset.id); });
    on('.lm-track',           'click', e => { if (!e.target.closest('.lm-rename-btn')) this._playIdx(+e.currentTarget.dataset.i); });
    on('.lm-rename-btn',      'click', e => { e.stopPropagation(); this._renameTrack(+e.currentTarget.closest('.lm-track').dataset.i); });
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
    on('#lm-sp-login',        'click', () => SpotifyAPI.startOAuth());
    on('#lm-sp-logout',       'click', () => this._spLogout());
    on('#lm-sync-toggle',     'change', e => LMSettings.set('syncToPlayers', e.target.checked));
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

    // OAuth callback
    if (this._oauthHandler) window.removeEventListener('message', this._oauthHandler);
    this._oauthHandler = async (e) => {
      if (e.data?.type !== 'lm-spotify-callback') return;
      try { await SpotifyAPI.exchangeCode(e.data.code); ui.notifications.info('Spotify connected!'); this.render(false); } catch (err) { ui.notifications.error('Spotify: ' + err.message); }
    };
    window.addEventListener('message', this._oauthHandler);

    // Init YT player
    initGMYTPlayer();
  }

  // ApplicationV2 hook
  _onRender(context, options) { this._attachListeners(this.element); }
  // v12/v13 hook
  activateListeners(html)     { super.activateListeners?.(html); this._attachListeners(html); }

  // ── Source ────────────────────────────────────────────────────────────────
  async _setSource(src) {
    this.source = src;
    this.playlist = null; this.tracks = []; this.searchMode = false; this.searchResults = [];
    this.playlists = LMSettings.getPlaylists(src);
    // Если есть сохранённый плейлист — восстанавливаем треки
    if (src === 'spotify' && LMSettings.spotifyLoggedIn()) {
      try { const pls = await SpotifyAPI.getUserPlaylists(); pls.forEach(p => LMSettings.addPlaylist('spotify', p)); this.playlists = LMSettings.getPlaylists('spotify'); } catch {}
    }
    this.render(false);
  }

  // ── Playlists ─────────────────────────────────────────────────────────────
  async _addPlaylistDialog() {
    const label = this.source === 'youtube' ? 'YouTube Playlist URL или ID' : 'Spotify Playlist URL или ID';
    let url;
    // v14 DialogV2
    if (foundry.applications?.api?.DialogV2) {
      url = await foundry.applications.api.DialogV2.prompt({
        window: { title: 'Добавить плейлист' },
        content: `<div style="padding:8px"><label>${label}</label><input type="text" name="url" style="width:100%;margin-top:4px;background:#1a1a24;border:1px solid #2a2a3e;color:#e8e0d0;padding:5px 8px;border-radius:4px;" autofocus></div>`,
        ok: { callback: (event) => event.target.closest('form')?.querySelector('[name=url]')?.value?.trim() ?? event.target.form?.url?.value?.trim() ?? '' }
      }).catch(() => null);
    } else {
      url = await Dialog.prompt({
        title: 'Добавить плейлист',
        content: `<div class="form-group"><label>${label}</label><input type="text" id="pl-url" style="width:100%"></div>`,
        callback: h => h.find('#pl-url').val()?.trim(),
        rejectClose: false
      }).catch(() => null);
    }
    if (!url) return;
    if (this.source === 'youtube') await this._addYTPlaylist(url);
    else await this._addSPPlaylist(url);
  }

  async _addYTPlaylist(url) {
    try {
      ui.notifications.info('Loading playlist...');
      const id   = YouTubeAPI.extractPlaylistId(url);
      const info = await YouTubeAPI.getPlaylistInfo(id);
      const pl   = { id, name: info.snippet.title, trackCount: info.contentDetails.itemCount, image: info.snippet.thumbnails?.medium?.url || '', source: 'youtube' };
      LMSettings.addPlaylist('youtube', pl);
      this.playlists = LMSettings.getPlaylists('youtube');
      this.render(false);
      ui.notifications.info(`"${pl.name}" added!`);
    } catch (e) { ui.notifications.error('YouTube: ' + e.message); }
  }

  async _addSPPlaylist(url) {
    try {
      let id = url.trim();
      if (id.includes('spotify.com'))            id = id.split('/playlist/')[1]?.split('?')[0];
      else if (id.startsWith('spotify:playlist:')) id = id.split(':')[2];
      const info = await SpotifyAPI.fetch(`/playlists/${id}?fields=id,name,images,tracks(total)`);
      const pl = { id, name: info.name, trackCount: info.tracks.total, image: info.images?.[0]?.url || '', source: 'spotify' };
      LMSettings.addPlaylist('spotify', pl);
      this.playlists = LMSettings.getPlaylists('spotify');
      this.render(false);
    } catch (e) { ui.notifications.error('Spotify: ' + e.message); }
  }

  _delPlaylist(id) {
    LMSettings.removePlaylist(this.source, id);
    this.playlists = LMSettings.getPlaylists(this.source);
    if (this.playlist?.id === id) { this.playlist = null; this.tracks = []; }
    this.render(false);
  }

  async _loadPlaylist(id) {
    const pl = this.playlists.find(p => p.id === id);
    if (!pl) return;
    this.playlist = pl;
    ui.notifications.info(`Loading "${pl.name}"...`);
    try {
      this.tracks = this.source === 'youtube' ? await YouTubeAPI.getPlaylistItems(id) : await SpotifyAPI.getPlaylistTracks(id);
      this.render(false);
    } catch (e) { ui.notifications.error('Load failed: ' + e.message); }
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

    if (this.track.source === 'youtube') {
      // Через ретранслятор (встроенный помощник / внешний сервер), с откатом на YT-iframe
      this._playViaRelay(this.track.id);
      return; // синхронизация игрокам — внутри, когда файл готов
    }

    if (LMSettings.get('syncToPlayers')) {
      const payload = { ...this.track, videoId: this.track.id, position: 0, title: this.track.displayTitle || this.track.title };
      LMSocket.emit('play', payload);
    }
  }

  // ── Воспроизведение через ретранслятор (YouTube → кэш → все) ──────────────
  //
  // Источника два, пробуем по порядку:
  //  1. Встроенный помощник (server/helper.mjs) на машине GM. Он качает аудио
  //     в modules/lazy-music/cache/, а раздаёт файл сам Foundry — поэтому
  //     игрокам уходит ОТНОСИТЕЛЬНЫЙ путь, который каждый клиент открывает
  //     со своего же адреса Foundry. Настройки не нужны вовсе.
  //  2. Внешний сервер из настройки serverUrl (старый способ, P:\сайт).
  // Если оба молчат — откат на YouTube-iframe, как раньше.

  static HELPER_URL = 'http://127.0.0.1:8766';

  _serverUrl() {
    const u = (LMSettings.get('serverUrl') || '').trim().replace(/\/+$/, '');
    return u || null;
  }

  _relaySources() {
    const h = LMApp.HELPER_URL;
    const sources = [{
      name:     'помощник',
      ensure:   id => `${h}/api/yt/ensure?id=${encodeURIComponent(id)}`,
      prefetch: id => `${h}/api/yt/prefetch?id=${encodeURIComponent(id)}`,
      resolve:  d  => d.url
    }];
    const server = this._serverUrl();
    if (server) sources.push({
      name:     'сервер',
      ensure:   id => `${server}/api/yt/ensure?id=${encodeURIComponent(id)}`,
      prefetch: id => `${server}/api/yt/prefetch?id=${encodeURIComponent(id)}`,
      resolve:  d  => server + d.url
    });
    return sources;
  }

  async _playViaRelay(videoId) {
    // Если качается дольше 1.5 сек — показываем уведомление
    const notify = setTimeout(() =>
      ui.notifications.info('⏬ Кэширую трек с YouTube…'), 1500);

    let url = null, source = null;
    for (const s of this._relaySources()) {
      try {
        const res  = await fetch(s.ensure(videoId));
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ready) throw new Error(data.error || `HTTP ${res.status}`);
        url = s.resolve(data);
        source = s;
        break;
      } catch (e) {
        console.warn(`Lazy Music | ретранслятор «${s.name}» недоступен:`, e?.message ?? e);
      }
    }
    clearTimeout(notify);
    if (this.track?.id !== videoId) return; // пока качалось — включили другой трек

    if (!url) {
      // Ни помощник, ни сервер не ответили — играем по-старому через YouTube
      if (!this._relayWarned) {
        this._relayWarned = true;
        ui.notifications.warn('Lazy Music: помощник не запущен — играю напрямую через YouTube (у игроков с VPN возможна ошибка 150). Запускайте Foundry ярлыком «Foundry VTT (с музыкой)».');
      }
      this.relayMode = false;
      this._relayUrl = null;
      _gmAudio?.pause();
      initGMYTPlayer((p) => {
        if (this.track?.id !== videoId) return;
        p.setVolume(Math.round(this._getFoundryVol() * 100));
        p.loadVideoById(videoId);
      });
      if (LMSettings.get('syncToPlayers')) {
        LMSocket.emit('play', {
          ...this.track, videoId, position: 0,
          title: this.track.displayTitle || this.track.title
        });
      }
      return;
    }

    this.relayMode = true;
    this._relayUrl = url; // в сокет шлём именно его: относительный путь у каждого клиента свой
    getYTPlayer()?.stopVideo?.(); // глушим YT-iframe, если играл

    const audio = getGMAudio();
    audio.src = url;
    audio.volume = Math.min(1, this._getFoundryVol() * this.gmVolume);
    audio.play().catch(e => console.warn('Lazy Music | GM autoplay blocked:', e?.message));

    if (LMSettings.get('syncToPlayers')) {
      LMSocket.emit('play', {
        ...this.track, videoId, streamUrl: url, position: 0,
        title: this.track.displayTitle || this.track.title
      });
    }

    // Греем кэш следующего трека, чтобы переход был мгновенным
    if (!this.shuffle && this.tracks.length > 1) {
      const next = this.tracks[(this.trackIdx + 1) % this.tracks.length];
      if (next?.source === 'youtube' && next.id !== videoId) {
        fetch(source.prefetch(next.id)).catch(() => {});
      }
    }
  }

  // ── События HTML5-аудио GM (зеркало _onYTState) ───────────────────────────

  _onAudioEnded() {
    if (!this.relayMode) return;
    if (this.repeat) {
      const a = getGMAudio();
      a.currentTime = 0;
      a.play().catch(() => {});
      // Перезапускаем и у игроков
      if (LMSettings.get('syncToPlayers') && this.track) {
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
    this._errorHandling = true;
    const name = this.track?.displayTitle || this.track?.title || 'Unknown';
    ui.notifications.warn(`⛔ "${name}" — ошибка воспроизведения с сервера. Пропускаю...`);
    setTimeout(() => { this._errorHandling = false; this._next(); }, 1200);
  }

  _togglePlay() {
    if (!this.track) return;
    if (this.relayMode) {
      const a = getGMAudio();
      if (this.playing) {
        a.pause();
        LMSocket.emit('pause');
      } else {
        a.play().catch(() => {});
        LMSocket.emit('play', { ...this.track, videoId: this.track.id, streamUrl: this._relayUrl || a.src, position: a.currentTime || this.position });
      }
    } else {
      const p = getYTPlayer();
      if (this.playing) {
        p?.pauseVideo?.();
        LMSocket.emit('pause');
      } else {
        p?.playVideo?.();
        LMSocket.emit('play', { ...this.track, videoId: this.track.id, position: this.position });
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
    LMSocket.emit('stop');
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
    LMSocket.emit('gmvol', { vol: this.gmVolume });
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
    LMSocket.emit('seek', { pos });
    this._updateProgressBar();
  }

  // ── YT Events ─────────────────────────────────────────────────────────────
  _onYTState(e) {
    if (this.relayMode) return; // трек идёт через сервер — YT-плеер заглушён
    if (e.data === 0) { // ended
      if (this.repeat) { getYTPlayer()?.seekTo(0); getYTPlayer()?.playVideo(); }
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
    const msgs = { 150: 'встраивание запрещено', 101: 'встраивание запрещено', 100: 'видео недоступно' };

    // Инициализируем список пропущенных если нет
    if (!this._skippedIds) this._skippedIds = new Set();
    if (this.track?.id) this._skippedIds.add(this.track.id);

    // Если пропустили все треки — останавливаемся
    if (this._skippedIds.size >= this.tracks.length) {
      this._skippedIds.clear();
      this._errorHandling = false;
      ui.notifications.error('⛔ Все треки в плейлисте недоступны. YouTube запрещает встраивание. Попробуйте другой плейлист.');
      this._stop();
      return;
    }

    ui.notifications.warn(`⛔ "${name}" — ${msgs[e.data] || 'ошибка ' + e.data}. Пропускаю...`);

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
      this.searchResults = this.source === 'youtube' ? await YouTubeAPI.search(q) : await SpotifyAPI.searchTracks(q);
      this.render(false);
    } catch (e) { ui.notifications.error('Search: ' + e.message); }
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
        window: { title: 'Переименовать трек' },
        content: `<div style="padding:8px">
          <label>Новое название</label>
          <input type="text" name="name" value="${esc(cur)}" style="width:100%;margin-top:4px;background:#1a1a24;border:1px solid #2a2a3e;color:#e8e0d0;padding:5px 8px;border-radius:4px;" autofocus>
          <div style="margin-top:6px;font-size:11px;color:#8a8270;">Оригинал: ${esc(track.title)}</div>
        </div>`,
        ok: { callback: (event) => event.target.closest('form')?.querySelector('[name=name]')?.value?.trim() ?? event.target.form?.name?.value?.trim() ?? '' }
      }).catch(() => null);
    } else {
      name = await Dialog.prompt({
        title: 'Переименовать трек',
        content: `<div class="form-group"><label>Новое название</label><input type="text" id="rn" value="${cur}" style="width:100%"></div><p style="font-size:11px;color:#8a8270;">Оригинал: ${track.title}</p>`,
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

  // ── Spotify logout ────────────────────────────────────────────────────────
  async _spLogout() { await LMSettings.setSpotifyToken(null); this.render(false); }

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
    if (this.track) LMMini.update({ title: this.track.displayTitle || this.track.title || '', playing: true });
    const el = this.element instanceof HTMLElement ? this.element : this.element?.[0];
    if (!el || !this.track) return;
    const t = this.track;
    el.querySelector('.lm-np-title')  && (el.querySelector('.lm-np-title').textContent  = t.displayTitle || t.title || '');
    el.querySelector('.lm-np-artist') && (el.querySelector('.lm-np-artist').textContent = t.artist || '');
    const art = el.querySelector('.lm-np-art');
    if (art && t.albumArt) { art.src = t.albumArt; art.style.display = ''; }
    el.querySelectorAll('.lm-track').forEach(row => row.classList.toggle('active', +row.dataset.i === this.trackIdx));
  }

  _fmt(s) { s = Math.floor(s || 0); return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`; }

  close(options = {}) {
    this._stopProgress();
    if (this._oauthHandler) window.removeEventListener('message', this._oauthHandler);
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
