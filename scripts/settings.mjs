/**
 * Lazy Music — Settings
 * Все критичные данные хранятся в localStorage
 */

const MODULE_ID = 'lazy-music';

const LS = {
  YT_KEY:       'lazy-music-youtube-api-key',
  YT_PLAYLISTS: 'lazy-music-playlists-youtube',
  SYNC:         'lazy-music-sync-to-players',
  TRACK_NAMES:  'lazy-music-track-names',
  FAB_POS:      'lazy-music-fab-pos',
  SERVER_URL:   'lazy-music-server-url',
  CUSTOM_PLS:   'lazy-music-custom-playlists',
};

export { MODULE_ID, LS };

export class LMSettings {
  static register() {
    // Foundry settings — только для отображения в UI настроек.
    // ВАЖНО: ключи API и токены — scope 'client'. World-настройки реплицируются
    // на ВСЕХ клиентов, и любой игрок мог бы прочитать секреты GM через консоль.
    const defs = [
      ['youtubeApiKey',    String,  '',    true,  'client', 'LAZYMUSIC.Settings.YouTubeApiKey',    'LAZYMUSIC.Settings.YouTubeApiKeyHint'],
      ['serverUrl',        String,  '',    true,  'client', 'LAZYMUSIC.Settings.ServerUrl',        'LAZYMUSIC.Settings.ServerUrlHint'],
      ['syncToPlayers',    Boolean, true,  true,  'world',  'LAZYMUSIC.Settings.SyncToPlayers',    'LAZYMUSIC.Settings.SyncToPlayersHint'],
    ];
    for (const [key, type, def, config, scope, name, hint] of defs) {
      game.settings.register(MODULE_ID, key, {
        name: game.i18n.localize(name),
        hint: game.i18n.localize(hint),
        scope, config, type, default: def,
        onChange: (v) => this._lsSet(key, v)
      });
    }
  }

  /**
   * Одноразовая миграция: раньше секреты лежали в world-настройках и были
   * видны всем игрокам. Переносим значения в client-хранилище GM и удаляем
   * Setting-документы из БД мира, чтобы они перестали реплицироваться.
   * Вызывается из ready-хука только на клиенте GM.
   */
  static async migrateWorldSecrets() {
    if (!game.user.isGM) return;
    const worldStorage = game.settings.storage.get('world');
    if (!worldStorage) return;
    const secretKeys = ['youtubeApiKey', 'spotifyClientId', 'spotifyRedirectUri', 'spotifyToken'];
    for (const key of secretKeys) {
      const doc = worldStorage.find(s => s.key === `${MODULE_ID}.${key}`);
      if (!doc) continue;
      try {
        const val = JSON.parse(doc.value);
        if (val && key === 'youtubeApiKey') {
          const k = this._lsKey(key);
          if (k && localStorage.getItem(k) === null) localStorage.setItem(k, val);
        }
      } catch { /* битое значение — просто удаляем */ }
      await doc.delete();
      console.log(`Lazy Music | Миграция: world-настройка "${key}" перенесена в client-scope и удалена из мира`);
    }
  }

  static _lsKey(key) {
    return { youtubeApiKey: LS.YT_KEY, syncToPlayers: LS.SYNC, serverUrl: LS.SERVER_URL }[key];
  }

  static _lsSet(key, val) {
    const k = this._lsKey(key);
    if (k) localStorage.setItem(k, typeof val === 'boolean' ? String(val) : val);
  }

  static get(key) {
    const k = this._lsKey(key);
    if (k) {
      const v = localStorage.getItem(k);
      if (v !== null) {
        if (key === 'syncToPlayers') return v === 'true';
        return v;
      }
    }
    try { return game.settings.get(MODULE_ID, key); } catch { return null; }
  }

  static async set(key, value) {
    this._lsSet(key, value);
    try { return await game.settings.set(MODULE_ID, key, value); } catch {}
  }

  // ── Плейлисты ─────────────────────────────────────────────────────────────
  static getPlaylists() {
    try { return JSON.parse(localStorage.getItem(LS.YT_PLAYLISTS) || '[]'); } catch { return []; }
  }

  static savePlaylists(list) {
    localStorage.setItem(LS.YT_PLAYLISTS, JSON.stringify(list));
  }

  static addPlaylist(playlist) {
    const list = this.getPlaylists();
    if (!list.find(p => p.id === playlist.id)) {
      list.push(playlist);
      this.savePlaylists(list);
    }
  }

  static removePlaylist(id) {
    this.savePlaylists(this.getPlaylists().filter(p => p.id !== id));
  }

  // ── Свои плейлисты (собираются вручную, например из поиска) ──────────────
  // Формат: [{ id: 'custom-…', name, tracks: [{id,title,artist,albumArt,source}] }]

  static getCustomPlaylists() {
    try { return JSON.parse(localStorage.getItem(LS.CUSTOM_PLS) || '[]'); } catch { return []; }
  }

  static saveCustomPlaylists(list) {
    localStorage.setItem(LS.CUSTOM_PLS, JSON.stringify(list));
  }

  static createCustomPlaylist(name) {
    const list = this.getCustomPlaylists();
    const pl = { id: 'custom-' + Date.now().toString(36), name: name || game.i18n.localize('LAZYMUSIC.NewCustomPlaylist'), tracks: [] };
    list.push(pl);
    this.saveCustomPlaylists(list);
    return pl;
  }

  static deleteCustomPlaylist(id) {
    this.saveCustomPlaylists(this.getCustomPlaylists().filter(p => p.id !== id));
  }

  /** Возвращает true, если трек добавлен (false — уже был в плейлисте). */
  static addTrackToCustomPlaylist(plId, track) {
    const list = this.getCustomPlaylists();
    const pl = list.find(p => p.id === plId);
    if (!pl || pl.tracks.some(t => t.id === track.id)) return false;
    pl.tracks.push({
      id: track.id, title: track.title, artist: track.artist || '',
      albumArt: track.albumArt || '', source: track.source || 'youtube'
    });
    this.saveCustomPlaylists(list);
    return true;
  }

  static removeTrackFromCustomPlaylist(plId, trackId) {
    const list = this.getCustomPlaylists();
    const pl = list.find(p => p.id === plId);
    if (!pl) return;
    pl.tracks = pl.tracks.filter(t => t.id !== trackId);
    this.saveCustomPlaylists(list);
  }

  // ── Переименования треков ─────────────────────────────────────────────────
  static getTrackNames() {
    try { return JSON.parse(localStorage.getItem(LS.TRACK_NAMES) || '{}'); } catch { return {}; }
  }

  static getTrackName(id) { return this.getTrackNames()[id] || null; }

  static setTrackName(id, name) {
    const map = this.getTrackNames();
    if (name) map[id] = name; else delete map[id];
    localStorage.setItem(LS.TRACK_NAMES, JSON.stringify(map));
  }
}
