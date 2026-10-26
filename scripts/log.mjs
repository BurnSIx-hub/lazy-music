/**
 * Lazy Music — журнал сессии: кому доходила музыка и почему не доходила
 * (просьба 2026-10-26: «после сессии кидать тебе и разбирать»).
 *
 * Игроки сидят за своими компьютерами, их консоль Мастеру не видна. Поэтому
 * каждый клиент сам сообщает Мастеру по сокету модуля, что у него с музыкой:
 * получил команду, заиграло (и через сколько), автоплей заблокирован,
 * ошибка файла или YouTube, подвисание, раз в минуту — где он в треке и на
 * какой громкости. Мастер складывает это вместе со своим (какой трек, откуда
 * взят, что разослано) в журнал — память плюс localStorage, переживает F5 —
 * и по кнопке в шапке окна выгружает текстовым файлом.
 *
 * Время записи — часы Мастера в момент получения: у игроков часы свои.
 * Задержки («заиграло через 800 мс») игрок меряет сам, по своим часам.
 */

import { LMSocket } from './socket.mjs';

const KEY      = 'lm-session-log';
const MAX      = 5000;                  // записей; старые уходят
const KEEP_MS  = 3 * 24 * 3600e3;       // и не старше трёх суток
const SAVE_MS  = 3000;                  // localStorage — не чаще
const BEAT_MS  = 60_000;                // «где я в треке» — раз в минуту
const QUIET_MS = 30_000;                // одинаковое подряд — не чаще (сторож плеера)

/** Что пришло от игрока, ужимаем: чужие данные, не доверяем размеру. */
function clean(data) {
  const out = {};
  for (const [k, v] of Object.entries(data ?? {}).slice(0, 16)) {
    if (k === 'k' || k === 't' || k === 'u' || v === undefined) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[k.slice(0, 16)] = v;
    else out[k.slice(0, 16)] = String(v).slice(0, 300);
  }
  return out;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const day = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clock = d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

export const LMLog = {
  _entries: null,
  _saveTimer: null,
  _quiet: new Map(),

  _list() {
    if (this._entries) return this._entries;
    try { this._entries = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { this._entries = []; }
    if (!Array.isArray(this._entries)) this._entries = [];
    return this._entries;
  },

  _save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try { localStorage.setItem(KEY, JSON.stringify(this._list())); }
      catch (e) { console.warn('Lazy Music | журнал не сохранился:', e?.message); }
    }, SAVE_MS);
  },

  /** Запись в журнал — только у Мастера: он его и выгружает. */
  add(kind, data = {}, user = game.user) {
    if (!game.user?.isGM) return;
    const list = this._list();
    list.push({ t: Date.now(), u: user?.name ?? '?', gm: !!user?.isGM, k: String(kind).slice(0, 20), ...clean(data) });
    const old = Date.now() - KEEP_MS;
    let drop = 0;
    while (drop < list.length && (list.length - drop > MAX || list[drop].t < old)) drop++;
    if (drop) list.splice(0, drop);
    this._save();
  },

  /**
   * О себе — Мастеру. Игрок и второй Мастер шлют по сокету; Мастер пишет
   * и себе (если он второй — ведущий получит то же по сокету).
   * quietKey — не повторять такое чаще раза в QUIET_MS.
   */
  report(kind, data = {}, quietKey = null) {
    if (quietKey) {
      const now = Date.now();
      if (now - (this._quiet.get(quietKey) ?? 0) < QUIET_MS) return;
      this._quiet.set(quietKey, now);
    }
    const payload = { k: kind, ...data };
    try { LMSocket.emit('log', payload); } catch {}
    if (game.user?.isGM) this.add(kind, data);
  },

  /** Пришло от игрока по сокету. */
  receive(sender, payload) {
    if (!payload?.k) return;
    this.add(payload.k, payload, sender);
  },

  /**
   * Раз в минуту каждый клиент сообщает, где он в треке. state() — что
   * играет у этого клиента или null. Ведущий Мастер пишет себе сам.
   */
  startBeat(state) {
    clearInterval(this._beat);
    this._beat = setInterval(() => {
      const s = state();
      if (s) this.report('beat', { ...s, hidden: document.hidden });
    }, BEAT_MS);
  },

  /** Текст для файла: шапка (кто, что, где) и записи по строке. */
  text() {
    const mod = game.modules?.get?.('lazy-music');
    const now = new Date();
    const users = (game.users?.contents ?? []).map(u =>
      `«${u.name}» (${u.isGM ? 'Мастер' : 'игрок'}${u.active ? ', в сети' : ''})`);
    const head = [
      `Lazy Music ${mod?.version ?? '?'} · Foundry ${game.version ?? '?'} · система ${game.system?.id ?? '?'} · мир «${game.world?.title ?? '?'}»`,
      `Выгружено: ${day(now)} ${clock(now)} · выгрузил «${game.user?.name ?? '?'}»`,
      `Участники: ${users.join(', ') || '—'}`,
      '',
    ];
    let lastDay = '';
    const lines = [];
    for (const e of this._list()) {
      const d = new Date(e.t);
      if (day(d) !== lastDay) { lastDay = day(d); lines.push(`── ${lastDay}`); }
      const { t, u, gm, k, ...rest } = e;
      const who = `${gm ? '★' : ' '}${u}`;
      const more = Object.keys(rest).length ? '  ' + JSON.stringify(rest) : '';
      lines.push(`${clock(d)}  ${who.padEnd(16)}  ${k.padEnd(9)}${more}`);
    }
    return head.concat(lines).join('\n') + '\n';
  },

  /** Скачать журнал файлом. */
  download() {
    const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
    const now = new Date();
    const name = `lazy-music-log-${day(now)}-${pad(now.getHours())}${pad(now.getMinutes())}.txt`;
    save(this.text(), 'text/plain', name);
  },
};
