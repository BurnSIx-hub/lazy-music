/**
 * Lazy Music — Socket
 */

import { LMLog } from './log.mjs';

const SOCKET = 'module.lazy-music';

/** Что Мастер разослал — в журнал; громкость не пишем: ползунок шлёт её на каждый сдвиг. */
function logSend(action, payload, targetId) {
  if (!game.user?.isGM || action === 'log' || action === 'gmvol' || action === 'state-request') return;
  const track = action === 'state' ? payload?.playback?.track : payload;
  LMLog.add('send', {
    a: action,
    to: targetId ? (game.users.get(targetId)?.name ?? targetId) : 'всем',
    id: track?.videoId ?? track?.id,
    mode: track ? (track.streamUrl ? 'stream' : 'yt') : undefined,
    pos: typeof (track?.position ?? payload?.pos) === 'number' ? Math.round(track?.position ?? payload?.pos) : undefined,
    playing: action === 'state' ? !!payload?.playback?.playing : undefined,
  });
}

export class LMSocket {
  static _onStateRequest = null;
  static _isLeading = null;

  /**
   * @param onStateRequest — кто-то подключился посреди трека и спрашивает,
   *   что играет (отвечает Мастер, у которого играет)
   * @param isLeading — этот Мастер сам ведёт музыку
   */
  static init({ onStateRequest = null, isLeading = null } = {}) {
    this._onStateRequest = onStateRequest;
    this._isLeading = isLeading;

    game.socket.on(SOCKET, (data) => {
      if (!data || typeof data !== 'object') return;
      const sender = game.users.get(data.senderId);
      if (!sender || sender.id === game.user.id) return;

      // Спросить, что играет, может любой; отвечает только Мастер
      if (data.action === 'state-request') {
        if (game.user.isGM) {
          LMLog.add('asks', {}, sender);
          this._onStateRequest?.(data.senderId);
        }
        return;
      }

      // Отчёт клиента о своей музыке — в журнал Мастера (log.mjs)
      if (data.action === 'log') {
        if (game.user.isGM) LMLog.receive(sender, data.payload);
        return;
      }

      // Команды — только от Мастера. Мастер, который сам ведёт музыку,
      // чужих не слушает; второй Мастер (и «Помощник Мастера») слушает их,
      // как игрок, — иначе он сидит без музыки
      if (!sender.isGM) return;
      if (game.user.isGM && this._isLeading?.()) return;
      if (data.targetId && data.targetId !== game.user.id) return;

      import('./player-receiver.mjs').then(({ PlayerReceiver }) => {
        const { action, payload = {} } = data;
        switch (action) {
          case 'play':   PlayerReceiver.play(payload);             break;
          case 'pause':  PlayerReceiver.pause();                   break;
          case 'stop':   PlayerReceiver.stop();                    break;
          case 'gmvol':  PlayerReceiver.setGMVolume(payload.vol);   break;
          case 'seek':   PlayerReceiver.seek(payload.pos);         break;
          case 'state':  PlayerReceiver.restoreState(payload);      break;
        }
      });
    });
  }

  static emit(action, payload = {}, { targetId = null } = {}) {
    logSend(action, payload, targetId);
    game.socket.emit(SOCKET, {
      action,
      payload,
      senderId: game.user.id,
      targetId
    });
  }

  static requestState() {
    this.emit('state-request');
  }
}
