/**
 * Lazy Music — Socket
 */

const SOCKET = 'module.lazy-music';

export class LMSocket {
  static init() {
    game.socket.on(SOCKET, (data) => {
      if (game.user.isGM) return; // GM игнорирует свои же сообщения
      import('./player-receiver.mjs').then(({ PlayerReceiver }) => {
        const { action, payload } = data;
        switch (action) {
          case 'play':   PlayerReceiver.play(payload);             break;
          case 'pause':  PlayerReceiver.pause();                   break;
          case 'stop':   PlayerReceiver.stop();                    break;
          case 'volume': PlayerReceiver.setLocalVolume(payload.v); break;
          case 'gmvol':  PlayerReceiver.setGMVolume(payload.vol);   break;
          case 'seek':   PlayerReceiver.seek(payload.pos);         break;
        }
      });
    });
  }

  static emit(action, payload = {}) {
    game.socket.emit(SOCKET, { action, payload });
  }
}
