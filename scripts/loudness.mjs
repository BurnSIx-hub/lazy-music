/**
 * Lazy Music — ровная громкость.
 *
 * Треки с YouTube залиты с разной громкостью, и Мастер с игроками крутили
 * ползунок на каждом. Теперь у трека один раз меряется громкость «на слух»
 * (LUFS по EBU R128 / ITU-R BS.1770: K-фильтр, блоки по 400 мс, пороги
 * −70 LUFS и −10 LU), и громкие притихают до общего уровня TARGET. Тихие не
 * трогаются: элемент <audio> громче 100% не играет, а по отзывам игроков
 * тихих, которым не хватало бы 100%, не было.
 *
 * Меряет только Мастер — по скачанному файлу из кэша. Итог хранится в
 * world-настройке `loudness` ({ videoId: { l: LUFS | null, a: поправка дБ } }),
 * а игрокам множитель громкости уходит вместе с командой «играй».
 */

import { MODULE_ID } from './settings.mjs';

/** Общий уровень, LUFS. Подобран по кэшу Мастера: громкие опускаются к тихим. */
export const TARGET = -18;
/** Ручная поправка трека — шагами по столько дБ, не дальше LIMIT. */
export const ADJ_STEP = 2;
const ADJ_LIMIT = 12;
/** Длинные файлы (часовые миксы) не меряем: декодирование съест гигабайты. */
const MAX_BYTES = 40 * 1024 * 1024;
/** Частота, к которой браузер приводит звук при замере: вдвое меньше памяти. */
const RATE = 24000;

// ── Расчёт ───────────────────────────────────────────────────────────────────

/**
 * Коэффициенты K-фильтра для любой частоты — по формулам, из которых
 * выходят эталонные коэффициенты ITU-R BS.1770 для 48 кГц.
 */
function biquad(type, fc, q, gainDb, rate) {
  const K = Math.tan(Math.PI * fc / rate);
  const a0 = 1 + K / q + K * K;
  const a1 = 2 * (K * K - 1) / a0;
  const a2 = (1 - K / q + K * K) / a0;
  if (type === 'shelf') {
    const Vh = 10 ** (gainDb / 20);
    const Vb = Vh ** 0.4996667741545416;
    return [(Vh + Vb * K / q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / q + K * K) / a0, a1, a2];
  }
  return [1, -2, 1, a1, a2];
}

/** K-фильтр канала на месте: полка +4 дБ над ~1,7 кГц и срез ниже ~38 Гц. */
function kWeight(x, rate) {
  for (const [b0, b1, b2, a1, a2] of [
    biquad('shelf', 1681.974450955533, 0.7071752369554196, 3.999843853973347, rate),
    biquad('highpass', 38.13547087602444, 0.5003270373238773, 0, rate),
  ]) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const x0 = x[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      x[i] = y0;
    }
  }
}

/**
 * Интегральная громкость, LUFS, по каналам звука (Float32Array) и частоте.
 * null — тишина или слишком коротко.
 */
export function integratedLoudness(channels, rate) {
  const block = Math.round(0.4 * rate);
  const step = Math.round(0.1 * rate);
  const n = channels[0]?.length ?? 0;
  if (n < block) return null;
  // Квадраты по 100-мс кускам: блок в 400 мс — сумма четырёх подряд
  const pieces = Math.floor(n / step);
  const power = new Float64Array(pieces);
  for (const ch of channels) {
    const x = Float32Array.from(ch);
    kWeight(x, rate);
    for (let p = 0; p < pieces; p++) {
      let s = 0;
      const end = (p + 1) * step;
      for (let i = p * step; i < end; i++) s += x[i] * x[i];
      power[p] += s;
    }
  }
  const z = [];
  for (let p = 0; p + 4 <= pieces; p++) {
    z.push((power[p] + power[p + 1] + power[p + 2] + power[p + 3]) / (4 * step));
  }
  const lufs = (v) => -0.691 + 10 * Math.log10(v);
  const loud = z.filter(v => v > 0 && lufs(v) > -70);
  if (!loud.length) return null;
  const rel = lufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const gated = loud.filter(v => lufs(v) > rel);
  if (!gated.length) return null;
  return lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
}

/** Громкость файла по адресу, LUFS; null — не вышло (большой, битый, тишина). */
export async function measureUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const size = Number(res.headers.get('content-length') || 0);
  if (size > MAX_BYTES) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return null;
  const ctx = new OfflineAudioContext(1, 1, RATE);
  const audio = await ctx.decodeAudioData(buf);
  const channels = [];
  for (let c = 0; c < Math.min(2, audio.numberOfChannels); c++) channels.push(audio.getChannelData(c));
  // Моно у BS.1770 считается одним каналом — для сравнения со стерео удваиваем
  if (channels.length === 1) channels.push(channels[0]);
  const l = integratedLoudness(channels, audio.sampleRate);
  return l === null ? null : Math.round(l * 10) / 10;
}

// ── Хранилище и множитель ────────────────────────────────────────────────────

export const LMLoudness = {
  register() {
    game.settings.register(MODULE_ID, 'loudness', {
      scope: 'world', config: false, type: Object, default: {},
    });
  },

  _all() {
    try { return game.settings.get(MODULE_ID, 'loudness') ?? {}; } catch { return {}; }
  },

  get(id) { return this._all()[id] ?? null; },

  /** Замерен ли трек (null — замерить не вышло, тоже ответ). */
  known(id) { const e = this._read(id); return !!e && 'l' in e; },

  /** Поправка трека, дБ: громкий притихает до TARGET, плюс ручная. */
  gainDb(id) {
    const e = this._read(id);
    if (!e) return 0;
    const auto = typeof e.l === 'number' ? Math.min(0, TARGET - e.l) : 0;
    return Math.min(0, auto + (e.a || 0));
  },

  /** Множитель громкости трека: 0..1. */
  gain(id) {
    return Math.round(10 ** (this.gainDb(id) / 20) * 1000) / 1000;
  },

  _pending: null,
  _timer: null,

  /** Пишем пачкой: при фоновом замере сотни треков не должны дёргать мир. */
  _save(id, entry) {
    this._pending ??= { ...this._all() };
    this._pending[id] = entry;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 3000);
  },

  async flush() {
    clearTimeout(this._timer);
    const next = this._pending;
    this._pending = null;
    if (!next || !game.user.isGM) return;
    await game.settings.set(MODULE_ID, 'loudness', next);
  },

  _read(id) { return this._pending?.[id] ?? this.get(id); },

  setLoudness(id, l) {
    const e = this._read(id) ?? {};
    this._save(id, { ...e, l });
  },

  /** Ручная поправка: ±ADJ_STEP; возвращает новую, дБ. */
  adjust(id, dir) {
    const e = this._read(id) ?? {};
    const a = Math.max(-ADJ_LIMIT, Math.min(ADJ_LIMIT, (e.a || 0) + dir * ADJ_STEP));
    this._save(id, { ...e, a });
    return a;
  },
};
