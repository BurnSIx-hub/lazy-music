// Самопроверка модуля без Foundry: заглушки вместо game/ui/foundry,
// настоящие файлы модуля. Запуск из папки модуля: node tools/selftest.mjs
const ROOT = new URL('../scripts/', import.meta.url).href;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Заглушки ────────────────────────────────────────────────────────────────
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const notes = [];
globalThis.ui = { notifications: { info: m => notes.push(['info', m]), warn: m => notes.push(['warn', m]), error: m => notes.push(['error', m]) } };
const hooks = {};
globalThis.Hooks = {
  on: (n, f) => (hooks[n] ??= []).push(f),
  once: (n, f) => (hooks[n] ??= []).push(f),
  callAll: (n, ...a) => (hooks[n] ?? []).forEach(f => f(...a)),
};
const users = new Map([
  ['gm1', { id: 'gm1', isGM: true }],
  ['agm', { id: 'agm', isGM: true }],
  ['p1', { id: 'p1', isGM: false }],
  ['p2', { id: 'p2', isGM: false }],
]);
const emitted = [];
const socketHandlers = [];
globalThis.game = {
  user: users.get('gm1'),
  users: { get: id => users.get(id) },
  world: { title: 'Тест' },
  i18n: { localize: k => k, format: (k, d) => `${k} ${JSON.stringify(d)}` },
  settings: { get: (ns, k) => (k === 'globalPlaylistVolume' ? 1 : null), set: async () => {}, register: () => {} },
  socket: { on: (n, f) => socketHandlers.push(f), emit: (n, d) => emitted.push(d) },
};
let lastAudio = null;
const cacheFiles = [];
class FakeAudio {
  constructor() { this.src = ''; this.currentTime = 0; this.duration = 200; this.volume = 1; this.paused = true; this.l = {}; lastAudio = this; }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  load() {}
  removeAttribute(a) { if (a === 'src') this.src = ''; }
  addEventListener(e, f) { (this.l[e] ??= []).push(f); }
}
globalThis.Audio = FakeAudio;
globalThis.window = globalThis;
globalThis.HTMLElement = class {};
globalThis.location = { href: 'http://localhost:30000/game' };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, remove() {} }),
  body: { appendChild() {} }, head: { appendChild() {} },
  querySelectorAll: () => [],
};
class AppV2 {
  constructor() { this.renders = 0; }
  render() { this.renders++; return this; }
  close() {}
  get rendered() { return true; }
}
globalThis.foundry = {
  applications: { api: { ApplicationV2: AppV2, HandlebarsApplicationMixin: B => class extends B {} }, apps: { FilePicker: { browse: async () => ({ files: cacheFiles.map(id => `modules/lazy-music/cache/${id}.m4a`) }) } } },
  utils: { mergeObject: Object.assign, escapeHTML: s => s },
};
let fetchImpl = async () => { throw new Error('нет сети'); };
globalThis.fetch = (...a) => fetchImpl(...a);

// ── Модуль ──────────────────────────────────────────────────────────────────
const { LMApp } = await import(ROOT + 'app.mjs');
const { LMSettings } = await import(ROOT + 'settings.mjs');
const { LMCache } = await import(ROOT + 'cache.mjs');
const { LMSocket } = await import(ROOT + 'socket.mjs');
const { LMHub } = await import(ROOT + 'hub.mjs');
const { PlayerReceiver } = await import(ROOT + 'player-receiver.mjs');

let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'ок ' : 'ОШИБКА'} ${name}${extra ? ' — ' + extra : ''}`); };

const T = (id) => ({ id, title: id.toUpperCase(), artist: '', albumArt: '', source: 'youtube' });
const liked = ['a1', 'a2', 'a3', 'a4', 'a5'];
const battle = ['b1', 'b2', 'b3', 'b4'];
cacheFiles.push(...liked, ...battle, 's1', 's2', 's3', 'n0', 'n9', ...Array.from({ length: 30 }, (_, i) => `l${i}`));
await LMCache.refresh();
localStorage.setItem('lazy-music-sync-to-players', 'true');

const save = lists => LMSettings.quietly(() => LMSettings.saveCustomPlaylists(lists));
const fresh = () => save([
  { id: 'custom-a', name: 'Понравившаяся музыка', tracks: liked.map(T) },
  { id: 'custom-b', name: 'Бой', tracks: battle.map(T) },
]);
const mkApp = async () => {
  fresh();
  const app = new LMApp();
  LMApp._instance = app;
  app._refreshPlaylists();
  await app._loadPlaylist('custom-a');
  return app;
};
const play = async (app, i) => { await sleep(320); app._playFromView(i); };
const next = async app => { await sleep(320); app._next(); };
const syncFromPc = (app, lists) => { save(lists); app._afterLibrarySync({ added: 1, removed: 0 }); };

// 1. Поиск во время музыки
{
  const app = await mkApp();
  await play(app, 2);                    // a3
  app.searchMode = true; app.searchResults = ['s1', 's2', 's3'].map(T);
  await next(app);
  ok(app.track.id === 'a4', 'поиск во время трека не подменяет следующий', app.track.id);
  ok(app.searchMode && app.searchResults.length === 3, 'результаты поиска на месте');
  // Плейлист дальше 20-го трека: раньше музыка молча вставала
  const long = Array.from({ length: 30 }, (_, i) => `l${i}`);
  save([{ id: 'custom-l', name: 'Длинный', tracks: long.map(T) }]);
  app._refreshPlaylists(); await app._loadPlaylist('custom-l');
  await play(app, 25);
  app.searchMode = true; app.searchResults = ['s1', 's2'].map(T);
  await next(app);
  ok(app.track?.id === 'l26' && app.playing, 'длинный список + поиск: играет 27-й, а не тишина', app.track?.id);
}

// 1б. Перемешивание: следующий выбран заранее — его успевают скачать
{
  const app = await mkApp();
  app.shuffle = true;
  let ahead = 0, same = 0, notCurrent = 0;
  for (let k = 0; k < 20; k++) {
    await play(app, k % 5);
    const want = app._shuffleNext;
    if (Number.isInteger(want)) ahead++;
    if (want !== app.trackIdx) notCurrent++;
    await next(app);
    if (app.trackIdx === want) same++;
  }
  ok(ahead === 20 && same === 20, 'при перемешивании играет заранее выбранный', `${ahead}/${same}`);
  ok(notCurrent === 20, 'заранее выбранный — не тот, что играет');
}

// 2. Открыли другой плейлист
{
  const app = await mkApp();
  await play(app, 1);                    // a2
  await app._loadPlaylist('custom-b');
  await next(app);
  ok(app.track.id === 'a3', 'другой открытый плейлист не подменяет следующий', app.track.id);
  ok(app.tracks[0].id === 'b1', 'в окне при этом открыт «Бой»');
  // Нажали трек в «Бое» — очередь теперь оттуда
  await play(app, 0);
  await next(app);
  ok(app.track.id === 'b2', 'нажатый трек делает очередью открытый список', app.track.id);
}

// 3. Сводка: лайк с телефона в начало играющего списка
{
  const app = await mkApp();
  await play(app, 1);                    // a2
  syncFromPc(app, [{ id: 'custom-a', name: 'Понравившаяся музыка', tracks: ['n0', ...liked].map(T) }, { id: 'custom-b', name: 'Бой', tracks: battle.map(T) }]);
  ok(app.trackIdx === 2, 'номер играющего сдвинулся вместе с ним', String(app.trackIdx));
  await next(app);
  ok(app.track.id === 'a3', 'после лайка в начало трек не играет дважды', app.track.id);
  ok(app.tracks[0].id === 'n0', 'новый трек виден в открытом списке');
}

// 4. Сводка убрала сам играющий трек и трек перед ним
{
  const app = await mkApp();
  await play(app, 2);                    // a3
  syncFromPc(app, [{ id: 'custom-a', name: 'Понравившаяся музыка', tracks: ['a1', 'a4', 'a5'].map(T) }, { id: 'custom-b', name: 'Бой', tracks: battle.map(T) }]);
  await next(app);
  ok(app.track.id === 'a4', 'убрали играющий — дальше тот, что шёл за ним', app.track.id);
  // Убрали всё, что шло следом
  await play(app, 0);                    // a1 (очередь a1,a4,a5)
  syncFromPc(app, [{ id: 'custom-a', name: 'Понравившаяся музыка', tracks: ['a4'].map(T) }, { id: 'custom-b', name: 'Бой', tracks: battle.map(T) }]);
  await next(app);
  ok(app.track?.id === 'a4', 'убрали играющий и не все следующие — играет оставшийся', app.track?.id);
}

// 5. Играющий список переименовали на телефоне (здесь — новый id)
{
  const app = await mkApp();
  await play(app, 3);                    // a4
  syncFromPc(app, [{ id: 'custom-z', name: 'Любимое', tracks: liked.map(T) }, { id: 'custom-b', name: 'Бой', tracks: battle.map(T) }]);
  ok(app.playlist === null, 'исчезнувший список закрылся в окне');
  await next(app);
  ok(app.track?.id === 'a5' && app.playing, 'очередь доигрывает, музыка не встаёт', app.track?.id);
}

// 6. Сводка во время поиска
{
  const app = await mkApp();
  await play(app, 0);
  app.searchMode = true; app.searchResults = ['s1', 's2'].map(T);
  syncFromPc(app, [{ id: 'custom-a', name: 'Понравившаяся музыка', tracks: ['n9', ...liked].map(T) }, { id: 'custom-b', name: 'Бой', tracks: battle.map(T) }]);
  ok(app.searchMode && app.searchResults.map(t => t.id).join() === 's1,s2', 'сводка не сбрасывает поиск');
  ok(app.tracks[0].id === 'n9', 'а открытый список под поиском обновлён');
}

// 7. Удаление трека из играющего списка кнопкой здесь
{
  const app = await mkApp();
  await play(app, 3);                    // a4
  app._removeTrackFromCustom(0);         // убрали a1
  await next(app);
  ok(app.track.id === 'a5', 'удалили трек выше играющего — следующий верный', app.track.id);
}

// 8. «Назад» при закрытом окне: позиция берётся у плеера, а не из старого
//    значения. Аудио Мастера ловим через заглушку: последнее созданное
{
  const app = await mkApp();
  await play(app, 2);                    // a3
  app.position = 1;                      // окно было закрыто — значение старое
  lastAudio.currentTime = 50;            // а плеер ушёл на 50-ю секунду
  let seeked = null;
  app._seekTo = p => { seeked = p; };
  app._prev();
  ok(seeked === 0 && app.track.id === 'a3', '«назад» на 50-й секунде начинает трек заново');
  // Начало трека — «назад» уходит на прошлый
  lastAudio.currentTime = 1;
  await sleep(320);
  app._prev();
  ok(app.track.id === 'a2', '«назад» в начале трека — прошлый трек', app.track.id);
}

// 9. Сокет: второй Мастер слушает, ведущий — нет
{
  const got = [];
  PlayerReceiver.play = p => got.push(p);
  let asked = [];
  let leading = false;
  LMSocket.init({ onStateRequest: id => asked.push(id), isLeading: () => leading });
  const deliver = async data => { for (const h of socketHandlers) h(data); await sleep(30); };

  game.user = users.get('agm');
  await deliver({ action: 'play', payload: { id: 'x' }, senderId: 'gm1' });
  ok(got.length === 1, 'помощник Мастера слышит музыку Мастера');
  leading = true; game.user = users.get('gm1');
  await deliver({ action: 'play', payload: { id: 'y' }, senderId: 'agm' });
  ok(got.length === 1, 'ведущий Мастер чужих команд не слушает');
  game.user = users.get('p1');
  await deliver({ action: 'play', payload: { id: 'z' }, senderId: 'p2' });
  ok(got.length === 1, 'команда от игрока не проходит');
  await deliver({ action: 'play', payload: { id: 'w' }, senderId: 'gm1' });
  ok(got.length === 2, 'игрок слышит Мастера');
  await deliver({ action: 'play', payload: {}, senderId: 'p1' });
  ok(got.length === 2, 'своё сообщение не исполняется');
  game.user = users.get('gm1');
  await deliver({ action: 'state-request', senderId: 'p1' });
  await deliver({ action: 'state-request', senderId: 'agm' });
  ok(asked.join() === 'p1,agm', 'Мастер отвечает и игроку, и второму Мастеру', asked.join());
  game.user = users.get('p1');
  await deliver({ action: 'state-request', senderId: 'p2' });
  ok(asked.length === 2, 'игрок на вопросы не отвечает');

  // Мастер без своего трека не отвечает «ничего не играет»
  game.user = users.get('gm1');
  const app = new LMApp();
  emitted.length = 0;
  app.syncStateToPlayer('p1');
  ok(emitted.length === 0, 'Мастер с пустым окном молчит');
  app.track = T('a1');
  app.syncStateToPlayer('p1');
  ok(emitted.length === 1 && emitted[0].targetId === 'p1', 'Мастер с треком отвечает');
}

// 10. Сводка с ПК: часы, повтор после занятости, порядок названий
{
  game.user = users.get('gm1');
  fresh();
  let calls = 0;
  fetchImpl = async () => { calls++; throw new Error('отказ'); };
  await LMHub._tick('тест');
  ok(!LMHub.online && LMHub._timer?._idleTimeout === 5 * 60_000, 'нет приложения — следующий раз через 5 минут', String(LMHub._timer?._idleTimeout));

  const lib = () => ({
    playlists: LMSettings.getCustomPlaylists().map(p => ({ name: p.name, tracks: p.tracks.map(t => ({ id: t.id, title: t.title, artist: t.artist, art: '' })) })),
    names: { a1: 'Первый', b1: 'Бой-1' },
  });
  LMSettings.quietly(() => LMSettings.setTrackNames({ b1: 'Бой-1', a1: 'Первый' })); // другой порядок
  let release;
  fetchImpl = async () => {
    calls++;
    await new Promise(r => (release = r));
    return { ok: true, status: 200, json: async () => ({ app: 'lazy-music', version: 2, rev: 7, library: lib() }) };
  };
  calls = 0;
  const first = LMHub._tick('тест');
  await sleep(10);
  const second = await LMHub.sync('во время');
  ok(second === false && LMHub._again, 'вторая сводка во время первой — помечена на повтор');
  let synced = 0;
  Hooks.on('lazyMusicLibrarySynced', () => synced++);
  release(); await first;
  ok(LMHub.online && LMHub._timer?._idleTimeout === 60_000, 'приложение ответило — снова раз в минуту');
  ok(synced === 0, 'те же названия в другом порядке — не правка', String(synced));
  await sleep(2200);
  ok(calls === 2, 'повтор после занятости прошёл', String(calls));
  release?.();
  await sleep(50);
  clearTimeout(LMHub._timer); clearTimeout(LMHub._soon);
}

console.log(`\nитого: ${pass} ок, ${fail} ошибок`);
process.exit(fail ? 1 : 0);
