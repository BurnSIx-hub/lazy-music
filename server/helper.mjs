/**
 * Lazy Music — локальный помощник GM.
 *
 * Качает аудиодорожки YouTube (yt-dlp) в Data/lazy-music-cache. Сами файлы
 * игрокам раздаёт Foundry — по обычному адресу lazy-music-cache/…, поэтому
 * игрокам не нужны ни порт, ни настройки: они качают с того же адреса, по
 * которому уже подключены к Foundry.
 *
 * Слушает только 127.0.0.1:8766 — снаружи помощник недоступен, к нему
 * обращается лишь модуль на клиенте GM.
 *
 * Запускается вместе с Foundry (ярлык «Foundry с музыкой») и сам
 * завершается через ~2 минуты после закрытия Foundry.
 *
 * Работает из копии в %LOCALAPPDATA%\lazy-music\helper, а не из папки модуля
 * (с 2.12.0): обновляя модуль, Foundry удаляет его папку целиком, и
 * запущенный оттуда deno.exe её держал — обновление обрывалось на середине,
 * и модуль оставался полуудалённым. По той же причине кэш лежит вне модуля:
 * иначе каждое обновление стирало скачанное. Копию делает ярлык (common.vbs).
 *
 * Запуск вручную:   bin\deno.exe run -A helper.mjs [--module <папка модуля>]
 * Без --module папкой модуля считается родительская (запуск прямо из server/).
 * Флаг --stay — не следить за процессом Foundry (для отладки).
 *
 * API:
 *   GET /api/ping                  → { ok: true }
 *   GET /api/yt/ensure?id=<vid>[&a=<исполнитель>&t=<название>]
 *                                  → { ready: true, url: "lazy-music-cache/<vid>.m4a" }
 *        YouTube просит подтвердить, что не бот, — копия с SoundCloud (с 2.15.0):
 *                                  → { ready: true, url: "…/<vid>.sc.m4a", sc: true }
 *   GET /api/yt/prefetch?id=<vid>[&a=…&t=…]  → { started: true }   (скачивание в фоне)
 *   GET /api/cache/status          → { files: n, bytes: n }
 *   POST /api/cache/clear          → { cleared: n, freed: bytes }
 *   POST /api/cache/open           → { opened: true }    (открывает cache/ в Проводнике)
 *   GET  /api/ytdlp/version       → { version, ageDays }
 *   POST /api/ytdlp/update        → { updated, from, to }
 *   GET  /api/probe?u=<url>&u=…&n=<на адрес>  → { rows: [{ id, title, uploader, source }] }
 *        (лента без скачивания: микс RD<id>, ytsearch1:… — для радио, с 2.13.0)
 *   GET  /api/deezer?path=/artist/…  → ответ api.deezer.com как есть (у него нет CORS)
 */

const PORT  = 8766;
const HERE  = import.meta.dirname;            // %LOCALAPPDATA%\lazy-music\helper или …\server
const BIN   = `${HERE}\\bin`;
const LOG   = `${HERE}\\helper.log`;
const YTDLP = `${BIN}\\yt-dlp.exe`;

function argValue(name) {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] ?? null : null;
}

const MODULE    = argValue('--module') ?? `${HERE}\\..`;   // …\Data\modules\lazy-music
const DATA      = `${MODULE}\\..\\..`;                     // …\Data — её раздаёт Foundry
const CACHE_URL = 'lazy-music-cache';
const CACHE     = `${DATA}\\${CACHE_URL}`;
/** Кэш до 2.12.0 — внутри модуля; при старте переезжает в CACHE. */
const OLD_CACHE = `${MODULE}\\cache`;

const CACHE_LIMIT_BYTES = 1.5 * 1024 ** 3;    // максимум кэша; старое удаляется
const AUDIO_EXT = new Set(['.m4a', '.webm', '.opus', '.mp3', '.ogg', '.aac']);
const ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

// Где искать cookies.txt (берётся самый свежий из существующих).
// YouTube без cookies часто требует «подтвердите, что вы не бот».
const COOKIE_CANDIDATES = [
  `${Deno.env.get('LOCALAPPDATA')}\\lazy-music\\cookies.txt`,
  'P:\\сайт\\cookies.txt',
];

// ── Лог ──────────────────────────────────────────────────────────────────────

function log(msg) {
  const line = `[${new Date().toLocaleString('ru-RU')}] ${msg}`;
  console.log(line);
  try {
    try { if (Deno.statSync(LOG).size > 256 * 1024) Deno.removeSync(LOG); } catch {}
    Deno.writeTextFileSync(LOG, line + '\n', { append: true });
  } catch {}
}

// ── Кэш ──────────────────────────────────────────────────────────────────────

function cachedFile(id) {
  try {
    for (const e of Deno.readDirSync(CACHE)) {
      if (!e.isFile || e.name.endsWith('.part')) continue;
      const dot = e.name.lastIndexOf('.');
      if (dot < 1) continue;
      if (e.name.slice(0, dot) === id && AUDIO_EXT.has(e.name.slice(dot).toLowerCase())) return e.name;
    }
  } catch {}
  return null;
}

function trimCache() {
  let files = [];
  try {
    for (const e of Deno.readDirSync(CACHE)) {
      if (!e.isFile) continue;
      const p = `${CACHE}\\${e.name}`;
      const st = Deno.statSync(p);
      files.push({ p, size: st.size, mtime: st.mtime?.getTime() ?? 0 });
    }
  } catch { return; }
  let total = files.reduce((s, f) => s + f.size, 0);
  if (total <= CACHE_LIMIT_BYTES) return;
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= CACHE_LIMIT_BYTES) break;
    try { Deno.removeSync(f.p); total -= f.size; log(`🧹 Кэш переполнен, удалил: ${f.p}`); } catch {}
  }
}

function newestCookies() {
  let best = null, bestTime = -1;
  for (const c of COOKIE_CANDIDATES) {
    try {
      const t = Deno.statSync(c).mtime?.getTime() ?? 0;
      if (t > bestTime) { best = c; bestTime = t; }
    } catch {}
  }
  return best;
}

// ── Скачивание (один трек качается один раз, даже при параллельных запросах) ─

const inFlight = new Map();
/** Сверка yt-dlp при старте — до неё не качаем (см. syncYtdlp). */
let ready = Promise.resolve();

/**
 * → { file, sc }. `sc` — копия с SoundCloud: YouTube просит подтвердить, что
 * не бот, а трек нашёлся там (`who` — исполнитель и название для поиска).
 */
function download(id, who = null) {
  let p = inFlight.get(id);
  if (!p) {
    p = _download(id, who).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
  }
  return p;
}

async function _download(id, who) {
  const have = cachedFile(id);
  if (have) return { file: have, sc: false };

  await ready;
  await Deno.mkdir(CACHE, { recursive: true });
  // Проверка «не бот» ещё держится — YouTube не спрашиваем: вопрос её продлит
  if (botPaused()) return fromSoundcloud(id, who, new BotCheck());
  // Сначала быстрым путём, потом обычным — см. FAST_CLIENT
  try {
    try {
      return { file: await ytdlp(id, true), sc: false };
    } catch (e) {
      // Проверка «не бот» относится к адресу, а не к клиенту: обычный путь её не обойдёт
      if (e instanceof BotCheck) throw e;
      log(`↪️ ${id}: быстрый путь не вышел, качаю обычным`);
      return { file: await ytdlp(id, false), sc: false };
    }
  } catch (e) {
    // 18+ без входа не отдаст ни один путь — копия с SoundCloud выручит и тут
    if (e instanceof BotCheck || e instanceof AgeCheck) return fromSoundcloud(id, who, e);
    throw e;
  }
}

// ── Проверка «не бот» и копия с SoundCloud ───────────────────────────────────
//
// «Sign in to confirm you're not a bot» YouTube устраивает адресу, а не
// треку: пока она держится, не скачается ничего. Чаще всего это у тех, чей
// провайдер сажает многих абонентов на один внешний адрес (CG-NAT). Тогда:
//
//  - минуту YouTube не спрашиваем вовсе — каждый вопрос продлевает проверку;
//  - ищем тот же трек на SoundCloud (там своей проверки нет) и качаем его
//    рядом, как <id>.sc.<ext>. Звук не тот же файл, что на YouTube, поэтому
//    копия играет, только пока YouTube отказывает: заработал — снова он.
//
// Так же устроено в приложениях на ПК (stash.rs) и телефоне (Stash.kt).
// SoundCloud находит примерно половину треков: у части там только отрывок
// на 30 секунд или звук под DRM — такие не годятся.

class BotCheck extends Error {
  constructor(msg = 'YouTube просит подтвердить, что вы не бот') { super(msg); }
}

/** Ролик 18+: YouTube отдаёт его только аккаунту с подтверждённым возрастом. Паузы не ставит. */
class AgeCheck extends Error {
  constructor() { super('Ролик 18+: YouTube отдаёт его только после входа в аккаунт с подтверждённым возрастом'); }
}

const BOT_PAUSE_MS = 60_000;
let botUntil = 0;
const botPaused = () => Date.now() < botUntil;

/** Копия с SoundCloud: уже скачанная, или найти и скачать. Не вышло — исходная беда. */
async function fromSoundcloud(id, who, why) {
  const have = scFile(id);
  if (have) return { file: have, sc: true };
  const found = await soundcloud(id, who).catch(e => { log(`⛔ ${id}: SoundCloud: ${e.message ?? e}`); return null; });
  if (found) return { file: found, sc: true };
  throw why;
}

function scFile(id) {
  for (const ext of AUDIO_EXT) {
    const name = `${id}.sc${ext}`;
    try { if (Deno.statSync(`${CACHE}\\${name}`).size > 0) return name; } catch {}
  }
  return null;
}

/** Уже искали за этот запуск — второй раз тот же трек не ищем. */
const scTried = new Set();

async function soundcloud(id, who) {
  const artist = String(who?.artist ?? '').trim();
  const title = String(who?.title ?? '').trim();
  if (!artist || !title || title === id || scTried.has(id)) return null;
  scTried.add(id);
  const rows = await scSearch(`${artist} ${searchTitle(title)}`);
  for (const row of rows.filter(r => sameTrack(r, artist, title)).slice(0, 3)) {
    try {
      await runYtdlp([
        // Отрывок на 30 секунд — не трек
        '-f', 'bestaudio[format_id!*=preview]', '--no-playlist', '--no-warnings', '-q',
        '--socket-timeout', '15', '-o', `${CACHE}\\${id}.sc.%(ext)s`, row.url,
      ]);
      const f = scFile(id);
      if (f) { log(`🎧 ${id}: копия с SoundCloud — ${f}`); trimCache(); return f; }
    } catch (e) {
      log(`↪️ ${id}: копия с SoundCloud не скачалась: ${e.message ?? e}`);
    }
  }
  log(`ℹ️ ${id}: на SoundCloud не нашёлся`);
  return null;
}

async function runYtdlp(args) {
  const out = await new Deno.Command(YTDLP, {
    args: ['--encoding', 'utf-8', ...args],
    env: { PATH: `${BIN};${Deno.env.get('PATH') ?? ''}`, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    stdout: 'piped', stderr: 'piped',
  }).output();
  const dec = new TextDecoder('utf-8');
  if (!out.success) throw new Error(dec.decode(out.stderr).trim().split('\n').pop() || 'yt-dlp failed');
  return dec.decode(out.stdout);
}

const scUrlOk = u => /^https:\/\/(api\.)?soundcloud\.com\//.test(u) && u.length < 300 && !/\s/.test(u);

async function scSearch(q) {
  const text = await runYtdlp([
    '--flat-playlist', '--no-warnings', '--socket-timeout', '10', '--extractor-retries', '1',
    '--print', `%(url)s${SEP}%(title)s${SEP}%(uploader)s${SEP}%(duration)s`, `scsearch5:${q}`,
  ]);
  const field = s => (s ?? '').trim() === 'NA' ? '' : (s ?? '').trim();
  return text.split('\n').map(l => l.split(SEP)).filter(p => p.length >= 3 && scUrlOk(field(p[0])))
    .map(p => ({ url: field(p[0]), title: field(p[1]), uploader: field(p[2]), dur: Math.max(0, Math.round(Number(field(p[3])) || 0)) }));
}

// Сверка находки — как у импорта в приложении на ПК (imports.js): лучше
// пропустить трек, чем поставить чужой.

const BRACKETS = /\((?:[^)]*)\)|\[(?:[^\]]*)\]|\{(?:[^}]*)\}/g;
const ARTICLES = new Set(['the', 'a', 'an']);
const TAIL = new Set(['remaster', 'remastered', 'remix', 'version', 'edit', 'mix', 'live', 'mono', 'stereo',
  'radio', 'original', 'album', 'single', 'acoustic', 'instrumental', 'extended', 'explicit', 'clean',
  'deluxe', 'bonus', 'official', 'audio', 'video', 'lyrics', 'ремастер', 'версия']);

function words(text) {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/ё/g, 'е')
    .replace(BRACKETS, ' ').replace(/\s(?:feat|ft|featuring)\.?\s.*$/, ' ')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
const flat = text => words(text).join('');
const core = list => (list.length > 1 && ARTICLES.has(list[0]) ? list.slice(1) : list);
const symbols = text => String(text ?? '').toLowerCase().replace(BRACKETS, '').replace(/\s+/g, '');
const searchTitle = t => String(t ?? '').replace(BRACKETS, ' ').replace(/(^|\s)-+(?=\S)/g, '$1').replace(/\s+/g, ' ').trim() || String(t ?? '').trim();

function headOf(long, short) {
  if (short.length > long.length || !short.every((w, i) => long[i] === w)) return false;
  const next = long[short.length];
  return next === undefined || TAIL.has(next) || /^\d+$/.test(next);
}

function alike(found, wanted) {
  const b = core(words(wanted));
  if (!b.length) return symbols(wanted) !== '' && symbols(found) === symbols(wanted);
  const a = core(words(found));
  if (!a.length) return false;
  if (a.join('') === b.join('')) return true;
  return headOf(a, b) || headOf(b, a);
}

function sameTitle(found, wanted) {
  if (alike(found, wanted)) return true;
  const cut = String(wanted ?? '').indexOf(' - ');
  const head = cut > 0 ? wanted.slice(0, cut) : '';
  return flat(head).length >= 4 && alike(found, head);
}

const firstArtist = a => flat(String(a ?? '').split(/,|&| и | x /i)[0]);

function withoutArtist(title, artist) {
  const cut = String(title ?? '').indexOf(' - ');
  if (cut < 0) return title;
  const who = firstArtist(artist);
  return who.length >= 2 && flat(title.slice(0, cut)).includes(who) ? title.slice(cut + 3) : title;
}

function sameTrack(row, artist, title) {
  if (row.dur && row.dur < 45) return false;     // отрывок или заставка
  const who = firstArtist(artist);
  if (who.length < 2 || !(flat(row.title).includes(who) || flat(row.uploader).includes(who))) return false;
  return sameTitle(row.title, title) || sameTitle(withoutArtist(row.title, artist), title);
}

/**
 * Клиент YouTube visionos — ему не нужна JS-задачка, которую yt-dlp иначе
 * решает для клиента tv через Deno. Замерено 2026-10-17: ссылка за 2,6–2,9 с
 * вместо 4,3, формат тот же (140). Не вышло — обычный путь.
 */
const FAST_CLIENT = 'youtube:player_client=visionos';

async function ytdlp(id, fast) {
  const args = [
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
    '--no-playlist', '--no-warnings', '-q',
    // Только IPv4. Замерено 2026-10-17: по IPv6 серверы звука YouTube рвут
    // соединение ещё на рукопожатии, а yt-dlp честно повторяет десять раз —
    // полторы минуты на трек и «скачать не удалось». По IPv4 мегабайт за
    // полсекунды. Приложение на ПК и телефон ходят так же
    '--force-ipv4',
    // Если связь всё же рвётся — не держать Мастера полторы минуты
    '--retries', '3',
    '-o', `${CACHE}\\%(id)s.%(ext)s`,
  ];
  if (fast) args.push('--extractor-args', FAST_CLIENT);
  const cookies = newestCookies();
  if (cookies) args.push('--cookies', cookies);
  args.push(`https://www.youtube.com/watch?v=${id}`);

  log(`⏬ Качаю с YouTube: ${id}${cookies ? '' : ' (без cookies!)'}`);
  const out = await new Deno.Command(YTDLP, {
    args,
    // bin/ добавляем в PATH — там лежит deno.exe, нужный yt-dlp
    // для расшифровки ссылок YouTube (EJS challenge)
    env: { PATH: `${BIN};${Deno.env.get('PATH') ?? ''}` },
    stdout: 'piped', stderr: 'piped',
  }).output();

  if (!out.success) {
    const err = new TextDecoder('utf-8').decode(out.stderr).trim().split('\n').pop() || 'yt-dlp failed';
    log(`⛔ ${id}: ${err}`);
    // Только «not a bot»: «Sign in to confirm your age» — про один ролик 18+,
    // а не про адрес; до 2.15.1 он ставил паузу, и минуту не качалось ничего
    if (/not a bot/i.test(err)) {
      botUntil = Date.now() + BOT_PAUSE_MS;
      throw new BotCheck('YouTube требует подтвердить, что вы не бот. Обычно проходит само за минуту-две; помогают и свежие cookies — см. README модуля.');
    }
    if (/confirm your age|age.restricted/i.test(err)) throw new AgeCheck();
    throw new Error(err);
  }

  const f = cachedFile(id);
  if (!f) throw new Error('Файл не появился в кэше после скачивания');
  log(`✅ В кэше: ${f}`);
  // Настоящий звук пришёл — копия с SoundCloud больше не нужна
  const sc = scFile(id);
  if (sc) try { Deno.removeSync(`${CACHE}\\${sc}`); } catch {}
  trimCache();
  return f;
}

// ── Радио: лента без скачивания и каталог Deezer ─────────────────────────────
//
// Радио собирает модуль (scripts/radio.mjs) — так же, как приложение на ПК.
// Помощник даёт ему два кирпича, которых у браузера нет: yt-dlp и Deezer
// без CORS.

const SEP = '\u0001';   // разделитель полей: в названиях роликов не встречается

/** Пускаем только YouTube и поиск yt-dlp — помощник не качалка всего подряд. */
function probeUrlAllowed(u) {
  return u.startsWith('https://www.youtube.com/') || /^ytsearch\d*:/.test(u);
}

async function probe(urls, perUrl) {
  await ready;
  const args = [
    '--flat-playlist', '--playlist-end', String(perUrl),
    // Один недоступный ролик не губит весь заход; без сети не висим минутами
    '--ignore-errors', '--socket-timeout', '10', '--extractor-retries', '1',
    // Без --encoding yt-dlp печатает в кодовой странице консоли: узкий
    // пробел из названий приходил «�» (замерено 2026-11-06; на ПК так же)
    '--force-ipv4', '--no-warnings', '--encoding', 'utf-8',
    '--print', `%(id)s${SEP}%(title)s${SEP}%(uploader)s${SEP}%(playlist_title)s`,
  ];
  const cookies = newestCookies();
  if (cookies) args.push('--cookies', cookies);
  args.push(...urls);
  const out = await new Deno.Command(YTDLP, {
    args,
    env: { PATH: `${BIN};${Deno.env.get('PATH') ?? ''}`, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    stdout: 'piped', stderr: 'piped',
  }).output();
  const dec = new TextDecoder('utf-8');
  const field = s => (s ?? '').trim() === 'NA' ? '' : (s ?? '').trim();
  const rows = dec.decode(out.stdout).split('\n').map(l => l.split(SEP))
    .filter(p => p.length >= 2 && ID_RE.test(field(p[0])))
    .map(p => ({ id: field(p[0]), title: field(p[1]), uploader: field(p[2]), source: field(p[3]) }));
  if (!rows.length && !out.success) {
    const err = dec.decode(out.stderr).trim().split('\n').pop() || 'yt-dlp failed';
    throw new Error(err);
  }
  return rows;
}

const DEEZER_PATH = /^\/(search|artist)[/?][\w/?=&%.+,-]*$/;

// ── yt-dlp: версия и обновление ──────────────────────────────────────────────

/** Версия бинарника, вида 2026.08.19. */
async function ytdlpVersion(exe = YTDLP) {
  const out = await new Deno.Command(exe, {
    args: ['--version'], stdout: 'piped', stderr: 'piped',
  }).output();
  if (!out.success) throw new Error('yt-dlp не отвечает');
  return new TextDecoder('utf-8').decode(out.stdout).trim();
}

/**
 * Возраст версии в днях. Выпуски yt-dlp называются датой, поэтому дату
 * можно прочитать прямо из номера, не ходя в сеть.
 */
function versionAgeDays(version) {
  const parts = String(version ?? '').split('.');
  if (parts.length < 3) return null;
  const y = Number(parts[0]), mo = Number(parts[1]), d = Number(parts[2]);
  if (!y || !mo || !d) return null;
  return Math.floor((Date.now() - Date.UTC(y, mo - 1, d)) / 86400000);
}


// ── HTTP API ─────────────────────────────────────────────────────────────────

// Адреса этой самой машины. Foundry открывают не только по localhost, но и по
// адресу в локальной сети — это тот же компьютер, и его запросы законные.
// Список считается один раз и кэшируется: интерфейсы за сессию не меняются.
let _localHosts = null;

function localHosts() {
  if (_localHosts) return _localHosts;
  _localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  try {
    for (const ni of Deno.networkInterfaces()) _localHosts.add(ni.address);
  } catch { /* нет прав или API недоступен — остаёмся на localhost */ }
  return _localHosts;
}

function json(obj, status = 200, origin = null) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(obj), {
    status,
    headers,
  });
}

/** Исполнитель и название из запроса — для поиска на SoundCloud. */
function who(u) {
  const artist = (u.searchParams.get('a') ?? '').slice(0, 200);
  const title = (u.searchParams.get('t') ?? '').slice(0, 300);
  return artist && title ? { artist, title } : null;
}

async function handler(req) {
  const u = new URL(req.url);
  const id = u.searchParams.get('id') ?? '';
  const origin = req.headers.get('origin');

  // The helper is a local desktop companion. Do not expose its download and
  // cache-management endpoints to arbitrary websites opened in the GM browser.
  if (origin) {
    let host = '';
    // URL.hostname keeps the brackets around IPv6 literals — strip them.
    try { host = new URL(origin).hostname.replace(/^\[|\]$/g, ''); } catch {}
    if (!localHosts().has(host)) {
      return json({ error: 'origin not allowed' }, 403);
    }
    // Откуда пришла страница Foundry — по этому адресу слежение спросит,
    // жив ли сервер, если Foundry запущен без своего окна (node main.js)
    if (/^https?:/.test(origin)) {
      seenOrigins.delete(origin);
      seenOrigins.add(origin);
      if (seenOrigins.size > 3) seenOrigins.delete(seenOrigins.values().next().value);
    }
  }

  if (u.pathname === '/api/ping') return json({ ok: true }, 200, origin);

  if (u.pathname === '/api/yt/ensure') {
    if (!ID_RE.test(id)) return json({ ready: false, error: 'Некорректный ID видео' }, 400, origin);
    try {
      const { file, sc } = await download(id, who(u));
      return json({ ready: true, url: `${CACHE_URL}/${file}`, sc }, 200, origin);
    } catch (e) {
      return json({ ready: false, error: String(e.message ?? e) }, 502, origin);
    }
  }

  if (u.pathname === '/api/yt/prefetch') {
    if (!ID_RE.test(id)) return json({ started: false }, 400, origin);
    download(id, who(u)).catch(() => {});
    return json({ started: true }, 200, origin);
  }

  if (u.pathname === '/api/probe') {
    const urls = u.searchParams.getAll('u').filter(probeUrlAllowed).slice(0, 20);
    const n = Math.max(1, Math.min(60, Number(u.searchParams.get('n')) || 20));
    if (!urls.length) return json({ error: 'нет адресов' }, 400, origin);
    try {
      return json({ rows: await probe(urls, n) }, 200, origin);
    } catch (e) {
      log(`⛔ Радио: лента не собралась: ${e.message ?? e}`);
      return json({ error: String(e.message ?? e) }, 502, origin);
    }
  }

  if (u.pathname === '/api/deezer') {
    const path = u.searchParams.get('path') ?? '';
    if (!DEEZER_PATH.test(path)) return json({ error: 'path not allowed' }, 400, origin);
    try {
      const r = await fetch(`https://api.deezer.com${path}`, { signal: AbortSignal.timeout(15000) });
      return new Response(await r.text(), {
        status: r.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
        },
      });
    } catch (e) {
      return json({ error: String(e.message ?? e) }, 502, origin);
    }
  }

  if (u.pathname === '/api/cache/status') {
    let files = 0, bytes = 0;
    try {
      for (const e of Deno.readDirSync(CACHE)) {
        if (!e.isFile) continue;
        files++;
        try { bytes += Deno.statSync(`${CACHE}\\${e.name}`).size; } catch {}
      }
    } catch {}
    return json({ files, bytes }, 200, origin);
  }

  if (u.pathname === '/api/cache/clear') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
    let cleared = 0, freed = 0;
    try {
      for (const e of [...Deno.readDirSync(CACHE)]) {
        if (!e.isFile) continue;
        const p = `${CACHE}\\${e.name}`;
        try {
          const size = Deno.statSync(p).size;
          Deno.removeSync(p);
          cleared++;
          freed += size;
        } catch {} // файл занят (играет прямо сейчас) — пропускаем
      }
    } catch {}
    log(`🧹 Кэш очищен вручную: ${cleared} файлов, ${(freed / 1048576).toFixed(0)} МБ`);
    return json({ cleared, freed }, 200, origin);
  }

  if (u.pathname === '/api/cache/open') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
    try {
      await Deno.mkdir(CACHE, { recursive: true });
      new Deno.Command('explorer.exe', {
        args: [CACHE],
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn();
      return json({ opened: true }, 200, origin);
    } catch (e) {
      return json({ opened: false, error: String(e.message ?? e) }, 500, origin);
    }
  }

  if (u.pathname === '/api/ytdlp/version') {
    try {
      const version = await ytdlpVersion();
      return json({ version, ageDays: versionAgeDays(version) }, 200, origin);
    } catch (e) {
      return json({ error: String(e.message ?? e) }, 500, origin);
    }
  }

  // Обновление самого yt-dlp: он заменяет себя по -U. Помощник при этом
  // перезапускать не надо — бинарник поднимается заново на каждое скачивание.
  if (u.pathname === '/api/ytdlp/update') {
    if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
    await ready;
    const before = await ytdlpVersion().catch(() => null);
    log('⬆️ Обновляю yt-dlp…');
    const out = await new Deno.Command(YTDLP, {
      args: ['-U'], stdout: 'piped', stderr: 'piped',
    }).output();
    const dec = new TextDecoder('utf-8');
    const text = (dec.decode(out.stdout) + dec.decode(out.stderr)).trim();
    const after = await ytdlpVersion().catch(() => before);
    if (!out.success) {
      const last = text.split(String.fromCharCode(10)).pop() || 'yt-dlp -U failed';
      log(`⛔ Обновить yt-dlp не удалось: ${last}`);
      return json({ updated: false, from: before, to: after, error: last }, 502, origin);
    }
    const updated = Boolean(before) && Boolean(after) && before !== after;
    log(updated ? `✅ yt-dlp обновлён: ${before} → ${after}` : `ℹ️ yt-dlp уже свежий: ${after}`);
    return json({ updated, from: before, to: after, ageDays: versionAgeDays(after) }, 200, origin);
  }


  return json({ error: 'not found' }, 404, origin);
}

// ── Переезд из папки модуля ──────────────────────────────────────────────────

/** Кэш из папки модуля (до 2.12.0) — в Data/lazy-music-cache. */
function moveOldCache() {
  let moved = 0;
  try {
    Deno.mkdirSync(CACHE, { recursive: true });
    for (const e of [...Deno.readDirSync(OLD_CACHE)]) {
      if (!e.isFile) continue;
      try { Deno.renameSync(`${OLD_CACHE}\\${e.name}`, `${CACHE}\\${e.name}`); moved++; } catch {}
    }
    Deno.removeSync(OLD_CACHE); // удалится, только если опустела
  } catch {}
  if (moved) log(`📦 Кэш переехал из папки модуля, файлов: ${moved}`);
}

/**
 * Где модуль — для приложения Lazy Music на ПК: оно читает наш кэш. Данные
 * Foundry бывают где угодно (D:\Foundry\<мир>\Data), а в настройки Foundry,
 * где лежит ключ лицензии, приложение не заглядывает.
 */
function tellWhere() {
  try {
    const dir = `${Deno.env.get('LOCALAPPDATA')}\\lazy-music`;
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(`${dir}\\foundry.json`, JSON.stringify({ module: Deno.realPathSync(MODULE) }));
  } catch {}
}

function samePath(a, b) {
  try { return Deno.realPathSync(a).toLowerCase() === Deno.realPathSync(b).toLowerCase(); }
  catch { return false; }
}

/**
 * yt-dlp в модуле новее нашей копии (вышла новая версия модуля) — берём его.
 * Наша могла обновиться кнопкой (-U) и оказаться свежее модульной — тогда
 * остаётся своя. Версии — даты (2026.08.19), их можно сравнивать строкой.
 *
 * Модульный файл не запускаем: запущенный, он держал бы папку модуля, как
 * раньше deno.exe. Версию спрашиваем у его копии, и только когда в модуле
 * лежит не тот файл, что в прошлый раз (метка — размер и время).
 */
async function syncYtdlp() {
  const theirs = `${MODULE}\\server\\bin\\yt-dlp.exe`;
  let st;
  try { st = Deno.statSync(theirs); } catch { return; } // в модуле нет — сверять не с чем
  if (samePath(theirs, YTDLP)) return;                  // запущены прямо из модуля
  const MARK  = `${BIN}\\yt-dlp.module`;
  const mark  = `${st.size}:${st.mtime?.getTime() ?? 0}`;
  let seen = '';
  try { seen = Deno.readTextFileSync(MARK); } catch {}
  if (seen === mark) return;
  const probe = `${BIN}\\yt-dlp.probe.exe`;
  Deno.mkdirSync(BIN, { recursive: true });
  Deno.copyFileSync(theirs, probe);
  try {
    const [mine, fresh] = await Promise.all([
      ytdlpVersion().catch(() => ''),
      ytdlpVersion(probe).catch(() => ''),
    ]);
    if (fresh && fresh > mine) {
      Deno.copyFileSync(probe, YTDLP);
      log(`⬆️ yt-dlp из модуля: ${mine || 'нет'} → ${fresh}`);
    }
  } finally {
    try { Deno.removeSync(probe); } catch {}
  }
  Deno.writeTextFileSync(MARK, mark);
}

// ── Слежение за Foundry: закрыли Foundry → помощник выходит сам ──────────────

/** Адреса страниц Foundry, с которых приходили запросы, — свежие в конце. */
const seenOrigins = new Set();

/** Отвечает ли сервер Foundry по адресу (`/api/status` есть у всех версий). */
async function serverAnswers(origin) {
  try {
    const res = await fetch(`${origin}/api/status`, { signal: AbortSignal.timeout(3000) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Открыт ли Foundry: окно программы — или сервер без окна (`node main.js`,
 * так его поднимают на выделенной машине и из других запускалок). Сервер
 * ищем по адресам, откуда приходила страница, и по обычному 30000.
 */
async function foundryRunning() {
  try {
    const out = await new Deno.Command('tasklist', {
      args: ['/FI', 'IMAGENAME eq Foundry Virtual Tabletop.exe', '/FO', 'CSV', '/NH'],
      stdout: 'piped', stderr: 'null',
    }).output();
    if (new TextDecoder().decode(out.stdout).includes('Foundry Virtual Tabletop')) return true;
  } catch {
    return true; // не смогли проверить — лучше остаться работать
  }
  for (const origin of new Set([...seenOrigins, 'http://127.0.0.1:30000'])) {
    if (await serverAnswers(origin)) return true;
  }
  return false;
}

function startWatchdog() {
  let misses = 0;
  setInterval(async () => {
    if (await foundryRunning()) { misses = 0; return; }
    if (++misses >= 2) {
      log('🚪 Foundry закрыт — выхожу.');
      Deno.exit(0);
    }
  }, 60_000);
}

// ── Старт ────────────────────────────────────────────────────────────────────

try {
  Deno.serve({
    hostname: '127.0.0.1',
    port: PORT,
    onListen: () => log(`🎵 Lazy Music helper запущен на 127.0.0.1:${PORT}`),
  }, handler);
} catch (e) {
  if (e instanceof Deno.errors.AddrInUse) {
    console.log('Помощник уже запущен — выходим.');
    Deno.exit(0);
  }
  throw e;
}

if (!Deno.args.includes('--stay')) startWatchdog();
moveOldCache();
tellWhere();
ready = syncYtdlp().catch(e => log(`⚠️ yt-dlp из модуля не взят: ${e.message ?? e}`));
trimCache();
