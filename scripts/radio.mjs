/**
 * Lazy Music — радио по треку, как в приложениях на ПК и телефоне
 * (просьба 2026-11-06). Собирается двумя кругами.
 *
 * Ближний круг — микс YouTube `RD<id>`: даровой, за секунды, но почти весь
 * из того же исполнителя. С него играть начинаем сразу.
 * Дальний круг — другие исполнители, близкие по духу: каталог Deezer
 * (кого слушают вместе) и шаг в сторону по миксам соседей. Стоит десятки
 * секунд, поэтому собирается уже во время игры и вплетается в очередь.
 *
 * Ни микса, ни Deezer браузеру не достать (yt-dlp и CORS), поэтому оба
 * идут через помощника: /api/probe и /api/deezer (server/helper.mjs).
 * Вкуса (дизлайков), как в приложениях, у модуля нет — круги не просеиваются.
 */

const HELPER   = 'http://127.0.0.1:8766';
const HOPS = 2;
const HOP_DEPTH = 20;
const ARTIST_MATCH = 5;
const TITLE_MATCH = 10;
const RELATED = 5;
const TOP_EACH = 2;
const PER_ARTIST = 2;

const mixUrl = id => `https://www.youtube.com/watch?v=${id}&list=RD${id}`;
const norm = v => String(v ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const artistOf = channel => String(channel ?? '').trim().replace(/ - Topic$/, '').trim();
const artistKey = t => String(t.artist ?? '').trim().toLowerCase();
const thumbnail = id => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;

/** Ошибка помощника с кодом: 404 — помощник старый, без радио. */
class HelperError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function helper(path) {
  let r;
  try {
    r = await fetch(`${HELPER}${path}`, { signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new HelperError(e?.message ?? String(e), 0);
  }
  const body = await r.json().catch(() => null);
  if (!r.ok) throw new HelperError(body?.error || `HTTP ${r.status}`, r.status);
  return body;
}

async function probe(urls, perUrl) {
  const q = new URLSearchParams(urls.map(u => ['u', u]));
  q.set('n', String(perUrl));
  return (await helper(`/api/probe?${q}`)).rows ?? [];
}

function rowTrack(row, artist = null) {
  return {
    id: row.id,
    title: row.title || row.id,
    artist: artist?.trim() || artistOf(row.uploader),
    albumArt: thumbnail(row.id),
    source: 'youtube',
  };
}

/** Имя исполнителя прямо в заголовке — значит, это его перезаливка. */
function titleNames(title, artist) {
  const name = norm(artistOf(artist));
  return name.length >= ARTIST_MATCH && norm(title).includes(name);
}

function disguised(title, seed, nearTitles) {
  const flat = norm(title);
  if (!flat) return false;
  if (titleNames(title, seed.artist)) return true;
  for (const t of nearTitles) if (flat.includes(t)) return true;
  return false;
}

// ── Ближний круг ────────────────────────────────────────────────────────────

export async function near(seed, limit = 40) {
  const rows = await probe([mixUrl(seed.id)], limit);
  const seen = new Set();
  return rows
    .filter(r => r.id !== seed.id && !seen.has(r.id) && seen.add(r.id))
    // Перезаливки возвращаем настоящему автору — иначе сойдут за других
    .map(r => rowTrack(r, titleNames(r.title, seed.artist) ? artistOf(seed.artist) : null));
}

// ── Каталог Deezer: кто кого слушает вместе ─────────────────────────────────

async function dz(path) {
  const json = await helper(`/api/deezer?path=${encodeURIComponent(path)}`);
  if (json?.error) throw new Error(json.error.message || 'Deezer отказал');
  return json ?? {};
}

function cleanTitle(title) {
  return String(title ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]/g, ' ')
    .split('|')[0]
    .replace(/\s+/g, ' ')
    .trim();
}

const same = (a, b) => { const x = norm(a), y = norm(b); return x !== '' && x === y; };

/** Помягче, чем same: к имени канала часто прилипает «Official». */
function matches(found, asked) {
  const x = norm(found), y = norm(asked);
  if (!x || !y) return false;
  if (x === y) return true;
  return Math.min(x.length, y.length) >= 5 && (x.includes(y) || y.includes(x));
}

async function findArtist(seedArtist, seedTitle) {
  const name = artistOf(seedArtist);
  if (name) {
    try {
      const found = (await dz(`/search/artist?limit=1&q=${encodeURIComponent(name)}`)).data?.[0];
      if (found && matches(found.name, name)) return { id: found.id, name: found.name };
    } catch { /* пробуем по названию */ }
  }
  const title = cleanTitle(seedTitle);
  if (!title) return null;
  try {
    const track = (await dz(`/search?limit=1&q=${encodeURIComponent(title)}`)).data?.[0];
    const a = track?.artist;
    return a?.id > 0 ? { id: a.id, name: a.name } : null;
  } catch {
    return null;
  }
}

/** Треки других исполнителей, близких к затравке: { artist, title, query }. */
async function similar(seedArtist, seedTitle, want = 12) {
  const artist = await findArtist(seedArtist, seedTitle);
  if (!artist) return [];
  const out = new Map();
  const add = t => {
    const title = String(t?.title ?? '').trim();
    const name = String(t?.artist?.name ?? '').trim();
    if (!title || !name || same(name, artist.name)) return;
    const a = norm(name);
    if ([...out.values()].filter(s => norm(s.artist) === a).length >= PER_ARTIST) return;
    const k = `${a}|${norm(title)}`;
    if (!out.has(k)) out.set(k, { artist: name, title, query: `${name} ${title}` });
  };
  try {
    for (const t of (await dz(`/artist/${artist.id}/radio`)).data ?? []) {
      if (out.size >= want) break;
      add(t);
    }
  } catch { /* добираем похожими */ }
  if (out.size < want) {
    try {
      for (const other of ((await dz(`/artist/${artist.id}/related?limit=${RELATED}`)).data ?? [])) {
        if (out.size >= want) break;
        if (!(other?.id > 0)) continue;
        try {
          for (const t of (await dz(`/artist/${other.id}/top?limit=${TOP_EACH}`)).data ?? []) {
            if (out.size >= want) break;
            add(t);
          }
        } catch { /* следующий */ }
      }
    } catch { /* что есть, то есть */ }
  }
  return [...out.values()].slice(0, want);
}

/** Найти на YouTube то, что предложил каталог, — одним заходом yt-dlp. */
async function resolve(suggestions) {
  if (!suggestions.length) return [];
  const byQuery = new Map(suggestions.map(s => [s.query, s]));
  const rows = await probe(suggestions.map(s => `ytsearch1:${s.query}`), 1);
  return rows.map(r => rowTrack(r, byQuery.get(r.source)?.artist ?? null));
}

// ── Дальний круг ────────────────────────────────────────────────────────────

export async function wider(seed, nearList, want = 14) {
  const known = new Set([seed.id, ...nearList.map(t => t.id)]);
  const seedArtist = artistKey(seed);
  const nearTitles = new Set([...nearList.map(t => t.title), seed.title].map(norm).filter(t => t.length >= TITLE_MATCH));
  const out = [];
  const accept = t => {
    if (known.has(t.id) || artistKey(t) === seedArtist) return;
    if (disguised(t.title, seed, nearTitles)) return;
    known.add(t.id);
    out.push(t);
  };

  try {
    (await resolve(await similar(seed.artist, seed.title, want))).forEach(accept);
  } catch (e) {
    console.warn('Lazy Music | радио: каталог не помог', e);
  }

  // Каталог бессилен (саундтреки, нишевое) — шаг по миксам соседей
  if (out.length < want / 2) {
    const seenArtists = new Set();
    const hops = nearList
      .filter(t => artistKey(t) && artistKey(t) !== seedArtist && !seenArtists.has(artistKey(t)) && seenArtists.add(artistKey(t)))
      .slice(0, HOPS)
      .map(t => mixUrl(t.id));
    if (hops.length) {
      try {
        (await probe(hops, HOP_DEPTH)).forEach(r => accept(rowTrack(r)));
      } catch (e) {
        console.warn('Lazy Music | радио: обход соседей не удался', e);
      }
    }
  }
  return out;
}

/**
 * Сплетает ленты в очередь: обход по кругу, не больше `perArtist` на
 * исполнителя. Отброшенное квотой дописывается в хвост, если очередь
 * выходит короче `limit`: короткая хуже однообразной.
 */
export function mix(head, lanes, perArtist = 2, limit = 40) {
  const out = [];
  const seen = new Set();
  const used = new Map();
  const spare = [];
  const take = t => {
    out.push(t);
    const k = artistKey(t);
    if (k) used.set(k, (used.get(k) ?? 0) + 1);
  };
  if (head && !seen.has(head.id)) { seen.add(head.id); take(head); }

  const cursor = lanes.map(() => 0);
  let moved = true;
  while (out.length < limit && moved) {
    moved = false;
    for (let lane = 0; lane < lanes.length; lane++) {
      if (out.length >= limit) break;
      const list = lanes[lane];
      let i = cursor[lane];
      while (i < list.length) {
        const t = list[i++];
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const k = artistKey(t);
        if (k && (used.get(k) ?? 0) >= perArtist) { spare.push(t); continue; }
        take(t);
        moved = true;
        break;
      }
      cursor[lane] = i;
    }
  }
  lanes.forEach((list, lane) => {
    for (let i = cursor[lane]; i < list.length; i++) {
      if (!seen.has(list[i].id)) { seen.add(list[i].id); spare.push(list[i]); }
    }
  });
  for (const t of spare) {
    if (out.length >= limit) break;
    out.push(t);
  }
  return out;
}

// ── Сбор радио ──────────────────────────────────────────────────────────────

let job = 0;

/** Отменить сбор: Мастер включил своё, дальний круг очередь не тронет. */
export function cancelRadio() { job++; }

/**
 * Собрать радио вокруг трека. Плеер — это окно модуля (LMApp):
 *   player.radioQueue(queue, seed) — поставить очередь (затравка — первая),
 *   player.radioWiden(queue)       — заменить очередь, играющий остаётся,
 *   player.track                   — что играет сейчас.
 * say(key, data, kind) — сообщение Мастеру (ключ LAZYMUSIC.<key>).
 */
export async function startRadio(seed, player, say) {
  const mine = ++job;
  try {
    say('RadioGathering', {}, 'info');
    const nearList = await near(seed);
    if (mine !== job) return;
    if (!nearList.length) return say('RadioEmpty', {}, 'warn');

    const queue = mix(seed, [nearList]);
    player.radioQueue(queue, seed);
    say('RadioWidening', { n: queue.length }, 'info');

    const extra = await wider(seed, nearList);
    if (mine !== job) return;
    if (!extra.length) return say('RadioReady', { n: queue.length }, 'info');

    // За полминуты Мастер мог уйти в свой плейлист — тогда не трогаем
    const now = player.track;
    const ours = new Set(queue.map(t => t.id));
    if (!now || !ours.has(now.id)) return;
    const heard = nearList.findIndex(t => t.id === now.id);
    const rest = heard >= 0 ? nearList.slice(heard + 1) : nearList;
    player.radioWiden(mix(now, [rest, extra]));
    say('RadioWidened', { n: extra.length }, 'info');
  } catch (e) {
    if (mine !== job) return;
    if (e instanceof HelperError && e.status === 0) return say('RadioNeedHelper', {}, 'warn');
    if (e instanceof HelperError && e.status === 404) return say('RadioOldHelper', {}, 'warn');
    say('RadioFailed', { error: e?.message ?? String(e) }, 'error');
  }
}
