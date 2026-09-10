/**
 * Lazy Music — локальный помощник GM.
 *
 * Качает аудиодорожки YouTube (yt-dlp) в папку cache/ модуля. Сами файлы
 * игрокам раздаёт Foundry — по обычному адресу modules/lazy-music/cache/…,
 * поэтому игрокам не нужны ни порт, ни настройки: они качают с того же
 * адреса, по которому уже подключены к Foundry.
 *
 * Слушает только 127.0.0.1:8766 — снаружи помощник недоступен, к нему
 * обращается лишь модуль на клиенте GM.
 *
 * Запускается вместе с Foundry (ярлык «Foundry с музыкой») и сам
 * завершается через ~2 минуты после закрытия Foundry.
 *
 * Запуск вручную:   bin\deno.exe run -A helper.mjs
 * Флаг --stay — не следить за процессом Foundry (для отладки).
 *
 * API:
 *   GET /api/ping                  → { ok: true }
 *   GET /api/yt/ensure?id=<vid>    → { ready: true, url: "modules/lazy-music/cache/<vid>.m4a" }
 *   GET /api/yt/prefetch?id=<vid>  → { started: true }   (скачивание в фоне)
 *   GET /api/cache/status          → { files: n, bytes: n }
 *   POST /api/cache/clear          → { cleared: n, freed: bytes }
 *   POST /api/cache/open           → { opened: true }    (открывает cache/ в Проводнике)
 *   GET  /api/ytdlp/version       → { version, ageDays }
 *   POST /api/ytdlp/update        → { updated, from, to }
 */

const PORT  = 8766;
const HERE  = import.meta.dirname;            // …\modules\lazy-music\server
const BIN   = `${HERE}\\bin`;
const CACHE = `${HERE}\\..\\cache`;
const LOG   = `${HERE}\\helper.log`;
const YTDLP = `${BIN}\\yt-dlp.exe`;

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

function download(id) {
  let p = inFlight.get(id);
  if (!p) {
    p = _download(id).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
  }
  return p;
}

async function _download(id) {
  const have = cachedFile(id);
  if (have) return have;

  await Deno.mkdir(CACHE, { recursive: true });
  const args = [
    '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
    '--no-playlist', '--no-warnings', '-q',
    '-o', `${CACHE}\\%(id)s.%(ext)s`,
  ];
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
    let err = new TextDecoder('utf-8').decode(out.stderr).trim().split('\n').pop() || 'yt-dlp failed';
    if (err.includes('Sign in to confirm')) {
      err = 'YouTube требует свежие cookies («я не бот»). Переэкспортируйте cookies.txt — см. README модуля.';
    }
    log(`⛔ ${id}: ${err}`);
    throw new Error(err);
  }

  const f = cachedFile(id);
  if (!f) throw new Error('Файл не появился в кэше после скачивания');
  log(`✅ В кэше: ${f}`);
  trimCache();
  return f;
}

// ── yt-dlp: версия и обновление ──────────────────────────────────────────────

/** Версия бинарника, вида 2026.08.19. */
async function ytdlpVersion() {
  const out = await new Deno.Command(YTDLP, {
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
  }

  if (u.pathname === '/api/ping') return json({ ok: true }, 200, origin);

  if (u.pathname === '/api/yt/ensure') {
    if (!ID_RE.test(id)) return json({ ready: false, error: 'Некорректный ID видео' }, 400, origin);
    try {
      const f = await download(id);
      return json({ ready: true, url: `modules/lazy-music/cache/${f}` }, 200, origin);
    } catch (e) {
      return json({ ready: false, error: String(e.message ?? e) }, 502, origin);
    }
  }

  if (u.pathname === '/api/yt/prefetch') {
    if (!ID_RE.test(id)) return json({ started: false }, 400, origin);
    download(id).catch(() => {});
    return json({ started: true }, 200, origin);
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

// ── Слежение за Foundry: закрыли Foundry → помощник выходит сам ──────────────

async function foundryRunning() {
  try {
    const out = await new Deno.Command('tasklist', {
      args: ['/FI', 'IMAGENAME eq Foundry Virtual Tabletop.exe', '/FO', 'CSV', '/NH'],
      stdout: 'piped', stderr: 'null',
    }).output();
    return new TextDecoder().decode(out.stdout).includes('Foundry Virtual Tabletop');
  } catch {
    return true; // не смогли проверить — лучше остаться работать
  }
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
trimCache();
