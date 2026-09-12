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
  PHONE_ADDR:   'lazy-music-phone-address',
  PHONE_TOKEN:  'lazy-music-phone-token',
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
      // Телефон настраивается в своём окне, а не здесь: адрес и код человек
      // переписывает с экрана телефона разом, и разносить их по двум местам
      // незачем. config: false — в общем списке настроек их не показываем
      ['phoneAddress',     String,  '',    false, 'client', 'LAZYMUSIC.Settings.PhoneAddress',     'LAZYMUSIC.Settings.PhoneAddressHint'],
      ['phoneToken',       String,  '',    false, 'client', 'LAZYMUSIC.Settings.PhoneToken',       'LAZYMUSIC.Settings.PhoneTokenHint'],
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
    return {
      youtubeApiKey: LS.YT_KEY, syncToPlayers: LS.SYNC, serverUrl: LS.SERVER_URL,
      phoneAddress: LS.PHONE_ADDR, phoneToken: LS.PHONE_TOKEN
    }[key];
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

  /**
   * Новый идентификатор списка.
   *
   * Раньше это было просто время в миллисекундах. Пока списки заводили
   * руками по одному, этого хватало; перенос с телефона заводит их в цикле,
   * и все попадают в одну миллисекунду. Списки с одинаковым идентификатором
   * выглядят по-разному, но открывается только первый — остальные ищутся по
   * тому же ключу, — а удаление сносит разом все. Отсюда случайный хвост и
   * явная проверка на совпадение.
   */
  static _freshCustomId(taken = new Set()) {
    let id;
    do {
      id = `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    } while (taken.has(id));
    return id;
  }

  static getCustomPlaylists() {
    let list;
    try { list = JSON.parse(localStorage.getItem(LS.CUSTOM_PLS) || '[]'); } catch { return []; }
    if (!Array.isArray(list)) return [];

    // Самолечение: списки, заведённые до этой починки, могли получить
    // одинаковые идентификаторы. Чинится молча и один раз — человеку
    // незачем знать, что у него внутри хранилища
    const seen = new Set();
    let fixed = false;
    for (const pl of list) {
      if (!pl) continue;
      if (!pl.id || seen.has(pl.id)) {
        pl.id = this._freshCustomId(seen);
        fixed = true;
      }
      seen.add(pl.id);
    }
    if (fixed) {
      this.saveCustomPlaylists(list);
      console.log('Lazy Music | одинаковые идентификаторы своих списков починены');
    }
    return list;
  }

  static saveCustomPlaylists(list) {
    localStorage.setItem(LS.CUSTOM_PLS, JSON.stringify(list));
  }

  static createCustomPlaylist(name) {
    const list = this.getCustomPlaylists();
    const pl = {
      id: this._freshCustomId(new Set(list.map(p => p.id))),
      name: name || game.i18n.localize('LAZYMUSIC.NewCustomPlaylist'),
      tracks: []
    };
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
