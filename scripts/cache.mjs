/**
 * Lazy Music — карта локального кэша.
 *
 * Странице читать диск нельзя, но у Foundry есть собственный серверный обзор
 * файлов: FilePicker.browse возвращает то, что реально лежит в cache/.
 * Поэтому скачанный трек играется прямо из папки — помощник для этого не нужен
 * вообще, а файлы, положенные в cache/ руками, подхватываются сами.
 *
 * Ключ карты — идентификатор видео (имя файла без расширения), значение —
 * путь относительно корня Foundry, пригодный и для GM, и для игроков.
 *
 * С 2.12.0 кэш лежит в Data/lazy-music-cache, вне папки модуля: обновление
 * модуля стирает его папку целиком. Старое место ещё читается — там остаются
 * файлы, пока помощник их не перенёс (и положенные руками по старой подсказке).
 */

const CACHE_DIRS = ['lazy-music-cache', 'modules/lazy-music/cache'];
const AUDIO_EXT = ['m4a', 'webm', 'opus', 'mp3', 'ogg', 'aac', 'flac', 'wav'];

// В v13 FilePicker переехал в неймспейс приложений; глобальный алиас ещё жив.
const FP = () => foundry.applications?.apps?.FilePicker ?? globalThis.FilePicker;

export const LMCache = {
  /** videoId → путь к файлу */
  _map: new Map(),

  /**
   * Перечитывает содержимое cache/. Один запрос к своему же серверу — дёшево,
   * поэтому зовётся при открытии окна и при каждой смене плейлиста.
   */
  async refresh() {
    const map = new Map();
    for (const dir of CACHE_DIRS) {
      try {
        const res = await FP()?.browse('data', dir);
        for (const raw of res?.files ?? []) {
          const name = decodeURIComponent(raw).split('/').pop();
          const dot  = name.lastIndexOf('.');
          if (dot < 1) continue;
          if (!AUDIO_EXT.includes(name.slice(dot + 1).toLowerCase())) continue;
          const id = name.slice(0, dot);
          if (!map.has(id)) map.set(id, raw); // новое место первым
        }
      } catch (e) {
        // Папки нет (ничего не качали, старое место помощник уже убрал) или
        // нет права browse — не беда: идём обычным путём через помощника.
        // Про старое место молчим: его отсутствие — норма
        if (dir === CACHE_DIRS[0]) console.log('Lazy Music | кэш не прочитан:', e?.message ?? e);
      }
    }
    this._map = map;
    console.log(`Lazy Music | в кэше треков: ${map.size}`);
    return map;
  },

  /** Путь к файлу трека или null, если его нет на диске. */
  get(id) { return this._map.get(id) ?? null; },

  has(id) { return this._map.has(id); },

  /** Помощник только что скачал трек — запоминаем без повторного обзора. */
  remember(id, url) { if (id && url) this._map.set(id, url); },

  /** Файл не открылся — забываем, чтобы в следующий раз пойти качать. */
  forget(id) { this._map.delete(id); },

  /** Проставляет трекам флаг `cached` для шаблона. */
  mark(tracks = []) {
    for (const t of tracks) t.cached = this._map.has(t.id);
    return tracks;
  },
};
