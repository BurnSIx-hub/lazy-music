/**
 * Lazy Music — мини-плеер.
 *
 * Компактная плашка поверх экрана: управление музыкой без открытия окна модуля.
 *  - ГМ: название трека, prev/play/next, личная громкость (🎧) и мастер-громкость
 *    для всех (📢).
 *  - Игрок: название трека и личная громкость (🎧 — тот же ползунок «Музыка»
 *    Foundry, изменения сохраняются).
 *
 * Сворачивается в маленький диск, перетаскивается за него же; позиция и
 * состояние запоминаются. Появляется при старте трека, исчезает по stop.
 *
 * Модуль ничего не импортирует из остальных файлов (чтобы не плодить циклы):
 * обработчики действий вешаются снаружи — gmControls в app.mjs, onPersonal
 * в main.mjs.
 */

const LS_POS  = 'lazy-music-fab-pos';
const LS_OPEN = 'lazy-music-mini-open';

export const LMMini = {
  el: null,

  // Назначается в app.mjs (только у ГМ): { prev, next, toggle, master }
  gmControls: null,
  // Назначается в main.mjs: (v, commit) => …  — личная громкость
  onPersonal: null,

  _playing: false,
  _dragged: false,

  // ── Создание ───────────────────────────────────────────────────────────────

  init() {
    if (this.el) return;
    const isGM = game.user.isGM;

    const el = document.createElement('div');
    el.id = 'lm-mini';
    el.classList.add('hidden');
    el.innerHTML = `
      <div class="lm-mini-disc" title="Lazy Music"><i class="fas fa-compact-disc"></i></div>
      <div class="lm-mini-panel">
        <div class="lm-mini-title" title=""></div>
        ${isGM ? `
        <div class="lm-mini-row lm-mini-transport">
          <button type="button" data-act="prev"   title="Предыдущий"><i class="fas fa-backward-step"></i></button>
          <button type="button" data-act="toggle" title="Пауза / играть"><i class="fas fa-pause"></i></button>
          <button type="button" data-act="next"   title="Следующий"><i class="fas fa-forward-step"></i></button>
        </div>` : ''}
        <div class="lm-mini-row" title="Моя громкость">
          <i class="fas fa-headphones"></i>
          <input type="range" class="lm-mini-vol-me" min="0" max="1" step="0.01">
        </div>
        ${isGM ? `
        <div class="lm-mini-row" title="Громкость у всех игроков">
          <i class="fas fa-tower-broadcast"></i>
          <input type="range" class="lm-mini-vol-all" min="0" max="1" step="0.01">
        </div>` : ''}
      </div>`;
    document.body.appendChild(el);
    this.el = el;

    this._restorePos();
    if (localStorage.getItem(LS_OPEN) === 'true') el.classList.add('open');

    // Диск: клик — свернуть/развернуть, зажать — перетащить
    this._initDrag(el.querySelector('.lm-mini-disc'));

    // Кнопки ГМ
    el.querySelectorAll('[data-act]').forEach(btn => btn.addEventListener('click', () => {
      this.gmControls?.[btn.dataset.act]?.();
    }));

    // Личная громкость: на input применяем сразу, на change — сохраняем
    const me = el.querySelector('.lm-mini-vol-me');
    me.addEventListener('input',  () => this.onPersonal?.(parseFloat(me.value), false));
    me.addEventListener('change', () => this.onPersonal?.(parseFloat(me.value), true));

    // Мастер-громкость ГМ
    const all = el.querySelector('.lm-mini-vol-all');
    all?.addEventListener('input', () => this.gmControls?.master?.(parseFloat(all.value)));
  },

  // ── Состояние ──────────────────────────────────────────────────────────────

  update({ title, playing } = {}) {
    if (!this.el) return;
    if (title !== undefined) {
      const t = this.el.querySelector('.lm-mini-title');
      t.textContent = title || '';
      t.title = title || '';
    }
    if (playing !== undefined) this.setPlaying(playing);
    this._syncSliders();
    this.el.classList.remove('hidden');
  },

  setPlaying(playing) {
    if (!this.el) return;
    this._playing = !!playing;
    this.el.classList.toggle('playing', this._playing);
    const i = this.el.querySelector('[data-act="toggle"] i');
    if (i) i.className = 'fas ' + (this._playing ? 'fa-pause' : 'fa-play');
  },

  stop() {
    if (!this.el) return;
    this.setPlaying(false);
    this.el.classList.add('hidden');
  },

  syncPersonal(v) {
    const s = this.el?.querySelector('.lm-mini-vol-me');
    if (s && document.activeElement !== s) s.value = String(v);
  },

  syncMaster(v) {
    const s = this.el?.querySelector('.lm-mini-vol-all');
    if (s && document.activeElement !== s) s.value = String(v);
  },

  _syncSliders() {
    let me = 1;
    try { me = game.settings.get('core', 'globalPlaylistVolume') ?? 1; } catch {}
    this.syncPersonal(me);
    this.syncMaster(parseFloat(localStorage.getItem('lm-gm-vol') ?? '1'));
  },

  // ── Перетаскивание и позиция ───────────────────────────────────────────────

  _initDrag(handle) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      this._dragged = false;
      const rect  = this.el.getBoundingClientRect();
      const offX  = e.clientX - rect.left;
      const offY  = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);

      const move = (ev) => {
        if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) < 5 && !this._dragged) return;
        this._dragged = true;
        const x = Math.max(0, Math.min(window.innerWidth  - 40, ev.clientX - offX));
        const y = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - offY));
        this.el.style.left = x + 'px';
        this.el.style.top  = y + 'px';
      };
      const up = (ev) => {
        handle.releasePointerCapture(ev.pointerId);
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        if (this._dragged) {
          localStorage.setItem(LS_POS, JSON.stringify({ left: this.el.style.left, top: this.el.style.top }));
        } else {
          // Обычный клик — свернуть/развернуть панель
          const open = this.el.classList.toggle('open');
          localStorage.setItem(LS_OPEN, String(open));
          if (open) this._syncSliders();
        }
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  },

  _restorePos() {
    try {
      const pos = JSON.parse(localStorage.getItem(LS_POS) || 'null');
      if (pos?.left && pos?.top) {
        this.el.style.left = pos.left;
        this.el.style.top  = pos.top;
        return;
      }
    } catch {}
    // По умолчанию — правый нижний угол, над хотбаром
    this.el.style.left = (window.innerWidth - 300) + 'px';
    this.el.style.top  = (window.innerHeight - 180) + 'px';
  },
};
