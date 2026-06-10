/**
 * Lazy Music — Settings
 * Все критичные данные хранятся в localStorage
 */

const MODULE_ID = 'lazy-music';

const LS = {
  YT_KEY:       'lazy-music-youtube-api-key',
  YT_PLAYLISTS: 'lazy-music-playlists-youtube',
  SP_PLAYLISTS: 'lazy-music-playlists-spotify',
  SP_CLIENT_ID: 'lazy-music-spotify-client-id',
  SP_REDIRECT:  'lazy-music-spotify-redirect',
  SYNC:         'lazy-music-sync-to-players',
  TRACK_NAMES:  'lazy-music-track-names',
  FAB_POS:      'lazy-music-fab-pos',
  SERVER_URL:   'lazy-music-server-url',
};

export { MODULE_ID, LS };

export class LMSettings {
  static register() {
    // Foundry settings — только для отображения в UI настроек.
    // ВАЖНО: ключи API и токены — scope 'client'. World-настройки реплицируются
    // на ВСЕХ клиентов, и любой игрок мог бы прочитать секреты GM через консоль.
    const defs = [
      ['youtubeApiKey',    String,  '',    true,  'client', 'LAZYMUSIC.Settings.YouTubeApiKey',    'LAZYMUSIC.Settings.YouTubeApiKeyHint'],
      ['spotifyClientId',  String,  '',    true,  'client', 'LAZYMUSIC.Settings.SpotifyClientId',  'LAZYMUSIC.Settings.SpotifyClientIdHint'],
      ['spotifyRedirectUri', String, 'http://localhost:30000/modules/lazy-music/spotify-callback.html', true, 'client', 'LAZYMUSIC.Settings.SpotifyRedirectUri', 'LAZYMUSIC.Settings.SpotifyRedirectUriHint'],
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
    // Скрытые
    game.settings.register(MODULE_ID, 'spotifyToken', { scope: 'client', config: false, type: Object, default: null });
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
        if (val) {
          if (key === 'spotifyToken') {
            if (!game.settings.get(MODULE_ID, 'spotifyToken')) {
              await game.settings.set(MODULE_ID, 'spotifyToken', val);
            }
          } else {
            const k = this._lsKey(key);
            if (k && localStorage.getItem(k) === null) localStorage.setItem(k, val);
          }
        }
      } catch { /* битое значение — просто удаляем */ }
      await doc.delete();
      console.log(`Lazy Music | Миграция: world-настройка "${key}" перенесена в client-scope и удалена из мира`);
    }
  }

  static _lsKey(key) {
    return { youtubeApiKey: LS.YT_KEY, spotifyClientId: LS.SP_CLIENT_ID, spotifyRedirectUri: LS.SP_REDIRECT, syncToPlayers: LS.SYNC, serverUrl: LS.SERVER_URL }[key];
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
  static getPlaylists(source) {
    try { return JSON.parse(localStorage.getItem(source === 'youtube' ? LS.YT_PLAYLISTS : LS.SP_PLAYLISTS) || '[]'); } catch { return []; }
  }

  static savePlaylists(source, list) {
    localStorage.setItem(source === 'youtube' ? LS.YT_PLAYLISTS : LS.SP_PLAYLISTS, JSON.stringify(list));
  }

  static addPlaylist(source, playlist) {
    const list = this.getPlaylists(source);
    if (!list.find(p => p.id === playlist.id)) {
      list.push(playlist);
      this.savePlaylists(source, list);
    }
  }

  static removePlaylist(source, id) {
    this.savePlaylists(source, this.getPlaylists(source).filter(p => p.id !== id));
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

  // ── Spotify Token ─────────────────────────────────────────────────────────
  static getSpotifyToken() {
    try { return game.settings.get(MODULE_ID, 'spotifyToken'); } catch { return null; }
  }

  static async setSpotifyToken(token) {
    try { await game.settings.set(MODULE_ID, 'spotifyToken', token); } catch {}
  }

  static spotifyLoggedIn() {
    const t = this.getSpotifyToken();
    return t && t.expires_at > Date.now();
  }
}
