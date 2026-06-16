/**
 * Lazy Music — Socket
 */

const SOCKET = 'module.lazy-music';

export class LMSocket {
  static _onStateRequest = null;

  static init({ onStateRequest = null } = {}) {
    this._onStateRequest = onStateRequest;

    game.socket.on(SOCKET, (data) => {
      if (!data || typeof data !== 'object') return;
      const sender = game.users.get(data.senderId);

      // Players may only ask the GM for the current playback state.
      if (game.user.isGM) {
        if (data.action === 'state-request' && sender && !sender.isGM) {
          this._onStateRequest?.(data.senderId);
        }
        return;
      }

      // Playback commands are accepted only when they identify an existing GM.
      if (!sender?.isGM) return;
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
