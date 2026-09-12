/**
 * Lazy Music — забор библиотеки с телефона.
 *
 * Направление одно: телефон — источник, модуль — приёмник. Человек слушает
 * и собирает плейлисты на телефоне, а здесь они появляются.
 *
 * **Почему сервер на телефоне, а не здесь.** Помощник модуля слушает только
 * `127.0.0.1` — намеренно: через него запускается yt-dlp и чистится кэш.
 * Выставлять его в Wi-Fi ради переноса плейлистов не стоит. У телефона же
 * наружу смотрит один маршрут со списком названий.
 *
 * **Слияние с заменой, а не объединением.** Список, который есть на телефоне,
 * становится здесь ровно таким же: что там удалили — исчезает и тут. Иначе
 * удаления никогда бы не доезжали. Списки, которых на телефоне нет, не
 * трогаются вовсе. Перед записью показывается, что именно изменится.
 */

import { LMSettings } from './settings.mjs';

const TOKEN_HEADER = 'X-Lazy-Token';
const PORT = 8780;
const WIRE = 1;

/** Столько ждём ответа. Телефон в той же комнате отвечает за миллисекунды. */
const TIMEOUT = 6000;

/** Сколько адресов проверяем разом при поиске телефона в сети. */
const SWEEP_BATCH = 64;

/**
 * Столько ждём отзыва при переборе адресов. Короче, чем при обычном
 * окликe: 253 адреса из 254 не ответят никогда, и ждать их по две
 * секунды — это минуты вместо секунд.
 */
const SWEEP_TIMEOUT = 1000;

const same = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();

export const LMPhone = {

  /**
   * Приводит введённое к виду `192.168.1.42:8780`. Человек вполне может
   * вписать адрес со схемой или без порта — обе вольности терпим.
   */
  normalize(input) {
    let a = String(input ?? '').trim();
    if (a.startsWith('http://')) a = a.slice(7);
    if (a.startsWith('https://')) a = a.slice(8);
    while (a.endsWith('/')) a = a.slice(0, -1);
    if (!a) return '';
    if (!a.includes(':')) a = `${a}:${PORT}`;
    return a;
  },

  // ── Сеть ──────────────────────────────────────────────────────────────────

  /** Отзывается ли по адресу наше приложение. */
  async ping(address, timeout = 2000) {
    const a = this.normalize(address);
    if (!a) return false;
    try {
      const res = await fetch(`http://${a}/ping`, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) return false;
      const data = await res.json();
      return data?.app === 'lazy-music';
    } catch {
      return false;
    }
  },

  /**
   * Снимок библиотеки телефона.
   * @throws {Error} с готовым к показу текстом
   */
  async pull(address, token) {
    const a = this.normalize(address);
    if (!a) throw new Error(game.i18n.localize('LAZYMUSIC.PhoneNoAddress'));

    let res;
    try {
      res = await fetch(`http://${a}/library`, {
        headers: { [TOKEN_HEADER]: String(token ?? '').trim() },
        signal: AbortSignal.timeout(TIMEOUT)
      });
    } catch {
      // Сюда же приходит и «телефон спит»: приложение должно быть открыто
      throw new Error(game.i18n.format('LAZYMUSIC.PhoneUnreachable', { address: a }));
    }
    if (res.status === 403) throw new Error(game.i18n.localize('LAZYMUSIC.PhoneBadToken'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json().catch(() => null);
    if (data?.app !== 'lazy-music') throw new Error(game.i18n.localize('LAZYMUSIC.PhoneStrangeAnswer'));
    if (Number(data.version) > WIRE) throw new Error(game.i18n.localize('LAZYMUSIC.PhoneTooNew'));
    return data;
  },

  /**
   * Ищет телефон в той же подсети, что и запомненный адрес.
   *
   * Нужно ровно для одного случая, зато частого: роутер выдал телефону
   * другой адрес, и записанный перестал отвечать. Без подсказки не ищем —
   * гадать, какая тут сеть, неоткуда, а адрес написан на экране телефона.
   */
  async find(hint, onProgress = null) {
    const base = this.normalize(hint);
    if (!base) return null;
    const parts = base.split(':')[0].split('.');
    if (parts.length !== 4) return null;
    const prefix = parts.slice(0, 3).join('.');

    for (let start = 1; start < 255; start += SWEEP_BATCH) {
      const batch = [];
      for (let i = start; i < start + SWEEP_BATCH && i < 255; i++) {
        batch.push(`${prefix}.${i}:${PORT}`);
      }
      onProgress?.(Math.min(100, Math.round((start / 254) * 100)));
      const found = await Promise.all(batch.map(async a => (await this.ping(a, SWEEP_TIMEOUT)) ? a : null));
      const hit = found.find(Boolean);
      if (hit) return hit;
    }
    return null;
  },

  // ── Что изменится ─────────────────────────────────────────────────────────

  /**
   * Считает разницу, ничего не записывая. Возвращаемое годится и для показа
   * человеку, и для [apply].
   */
  plan(remote, current) {
    const lists = [];
    let added = 0;
    let removed = 0;

    for (const pl of remote?.playlists ?? []) {
      const name = String(pl?.name ?? '').trim();
      if (!name) continue;

      const keep = (pl.tracks ?? [])
        .filter(t => t?.id)
        .map(t => ({
          id: t.id,
          title: t.title || t.id,
          artist: t.artist || '',
          albumArt: t.art || '',
          source: 'youtube'
        }));

      const mine = current.find(p => same(p.name, name));
      const here = new Set((mine?.tracks ?? []).map(t => t.id));
      const there = new Set(keep.map(t => t.id));
      const gain = keep.filter(t => !here.has(t.id)).length;
      const loss = (mine?.tracks ?? []).filter(t => !there.has(t.id)).length;

      added += gain;
      removed += loss;
      lists.push({ name, keep, isNew: !mine, added: gain, removed: loss });
    }

    // Переименования переносим только новые: своё название, уже стоящее
    // здесь, перезаписывать тем же значением незачем
    const renames = Object.entries(remote?.names ?? {})
      .filter(([id, name]) => id && name && LMSettings.getTrackName(id) !== name);

    return {
      device: remote?.device ?? '',
      lists,
      renames,
      added,
      removed,
      // Списки, которых на телефоне нет, остаются как были — считаем их,
      // чтобы человек видел, что их не тронули
      untouched: current.filter(p => !lists.some(l => same(l.name, p.name))).length
    };
  },

  /** Пусто — забирать нечего, окно подтверждения показывать не за чем. */
  empty(plan) {
    return plan.added === 0 && plan.removed === 0 && plan.renames.length === 0
      && !plan.lists.some(l => l.isNew);
  },

  // ── Запись ────────────────────────────────────────────────────────────────

  apply(plan) {
    // Недостающие заводим через сам модуль: идентификатор должен начинаться
    // с `custom-`, иначе кнопка удаления списка его не признает
    for (const entry of plan.lists) {
      if (entry.isNew) LMSettings.createCustomPlaylist(entry.name);
    }
    const all = LMSettings.getCustomPlaylists();
    for (const entry of plan.lists) {
      const pl = all.find(p => same(p.name, entry.name));
      if (pl) pl.tracks = entry.keep;
    }
    LMSettings.saveCustomPlaylists(all);

    for (const [id, name] of plan.renames) LMSettings.setTrackName(id, name);
  }
};
