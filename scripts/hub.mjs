/**
 * Lazy Music — сводка с приложением Lazy Music на этом же компьютере.
 *
 * Приложение на ПК — центр библиотеки: с ним сводится и телефон. Модуль
 * присылает свои списки, получает сведённые и заменяет ими свои. Сводит
 * центр трёхсторонне — по тому, какой библиотека была при прошлой сводке
 * с модулем, — поэтому удаление здесь доезжает до телефона, а добавленное
 * на телефоне — сюда, и ничьи правки не теряются.
 *
 * Сводятся только свои списки (`custom-…`) и свои названия треков.
 * Плейлисты YouTube по ссылке живут только здесь.
 *
 * Приложение слушает `127.0.0.1:8781`. Не запущено — сводка молча
 * пропускается: модуль работает и без него, как раньше.
 */

import { LMSettings } from './settings.mjs';

const BASE = 'http://127.0.0.1:8781';
const WIRE = 2;
const PEER_KEY = 'lazy-music-hub-peer';
const APPLIED_KEY = 'lazy-music-hub-applied';
const LAST_KEY = 'lazy-music-hub-last';

/** Раз в минуту — чтобы лайк с телефона доехал, пока идёт игра. */
const PERIOD = 60_000;
/** Пауза после правки: пачка правок — одна сводка. */
const DEBOUNCE = 2_000;
const TIMEOUT = 5_000;

const norm = n => String(n ?? '').trim().toLowerCase();
const isYouTube = t => !t.source || t.source === 'youtube';

export const LMHub = {
  online: false,
  busy: false,
  _timer: null,
  _soon: null,

  get lastSync() { return Number(localStorage.getItem(LAST_KEY) || 0); },

  /** Имя этого модуля для центра. Живёт рядом со списками, в том же хранилище. */
  peer() {
    let id = localStorage.getItem(PEER_KEY);
    if (!id) {
      id = `foundry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(PEER_KEY, id);
    }
    return id;
  },

  start() {
    if (!game.user.isGM) return;
    LMSettings.onLibraryChange = () => this.soon();
    this.sync('запуск');
    clearInterval(this._timer);
    this._timer = setInterval(() => this.sync('по часам'), PERIOD);
  },

  soon() {
    clearTimeout(this._soon);
    this._soon = setTimeout(() => this.sync('после правки'), DEBOUNCE);
  },

  /** Свои списки в формате центра. Треки не с YouTube в сводку не идут. */
  snapshot() {
    return {
      playlists: LMSettings.getCustomPlaylists().map(p => ({
        name: p.name,
        tracks: (p.tracks ?? []).filter(isYouTube).map(t => ({
          id: t.id, title: t.title || t.id, artist: t.artist || '', art: t.albumArt || ''
        }))
      })),
      names: LMSettings.getTrackNames()
    };
  },

  async sync(reason) {
    if (this.busy) return false;
    this.busy = true;
    try {
      const library = this.snapshot();
      const before = JSON.stringify(library);
      let res;
      try {
        res = await fetch(`${BASE}/api/sync`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            peer: this.peer(),
            device: `Foundry: ${game.world?.title ?? ''}`.trim(),
            applied: Number(localStorage.getItem(APPLIED_KEY) || 0),
            library
          }),
          signal: AbortSignal.timeout(TIMEOUT)
        });
      } catch {
        // Приложение не запущено — это обычное дело, не ошибка
        this.online = false;
        return false;
      }
      if (!res.ok) {
        this.online = false;
        console.warn(`Lazy Music | сводка с ПК: ответ ${res.status}`);
        return false;
      }
      const data = await res.json().catch(() => null);
      if (data?.app !== 'lazy-music' || Number(data.version) > WIRE || !data.library) return false;
      this.online = true;

      // Пока ждали ответа, здесь что-то поправили. Применять нельзя — затрём
      // правку; сводим ещё раз, и она уедет с новой сводкой
      if (JSON.stringify(this.snapshot()) !== before) {
        this.soon();
        return false;
      }
      const change = this.apply(data.library);
      localStorage.setItem(APPLIED_KEY, String(data.rev));
      localStorage.setItem(LAST_KEY, String(Date.now()));
      if (change) {
        console.log(`Lazy Music | сводка с ПК (${reason}): +${change.added} −${change.removed}`);
        Hooks.callAll('lazyMusicLibrarySynced', change);
      }
      return true;
    } finally {
      this.busy = false;
    }
  },

  /**
   * Заменяет свои списки сведёнными. Идентификаторы списков с тем же именем
   * сохраняются — на них держится открытый список и кнопка удаления. Треки
   * не с YouTube, если были, остаются в конце своего списка.
   *
   * @returns {{added:number, removed:number}|null} null — ничего не поменялось
   */
  apply(lib) {
    const current = LMSettings.getCustomPlaylists();
    const byName = new Map(current.map(p => [norm(p.name), p]));
    const taken = new Set(current.map(p => p.id));

    const next = (lib.playlists ?? []).map(p => {
      const old = byName.get(norm(p.name));
      const oldArt = new Map((old?.tracks ?? []).map(t => [t.id, t.albumArt]));
      let id = old?.id;
      if (!id) {
        id = LMSettings._freshCustomId(taken);
        taken.add(id);
      }
      return {
        id,
        name: p.name,
        tracks: [
          ...(p.tracks ?? []).map(t => ({
            id: t.id,
            title: t.title || t.id,
            artist: t.artist || '',
            albumArt: t.art || oldArt.get(t.id) || '',
            source: 'youtube'
          })),
          ...(old?.tracks ?? []).filter(t => !isYouTube(t))
        ]
      };
    });

    const names = lib.names ?? {};
    const sameLists = JSON.stringify(next) === JSON.stringify(current);
    const sameNames = JSON.stringify(names) === JSON.stringify(LMSettings.getTrackNames());
    if (sameLists && sameNames) return null;

    const pairs = lists => new Set(lists.flatMap(p => p.tracks.map(t => `${norm(p.name)}\u0001${t.id}`)));
    const was = pairs(current);
    const now = pairs(next);
    const added = [...now].filter(x => !was.has(x)).length;
    const removed = [...was].filter(x => !now.has(x)).length;

    LMSettings.quietly(() => {
      LMSettings.saveCustomPlaylists(next);
      LMSettings.setTrackNames(names);
    });
    return { added, removed };
  }
};
