/**
 * Lazy Music — Spotify API
 */

import { LMSettings } from './settings.mjs';

const SP_API   = 'https://api.spotify.com/v1';
const SP_AUTH  = 'https://accounts.spotify.com';
const SCOPES   = 'user-read-private playlist-read-private playlist-read-collaborative streaming user-read-playback-state user-modify-playback-state';

export class SpotifyAPI {
  static get clientId()    { return LMSettings.get('spotifyClientId'); }
  static get redirectUri() { return LMSettings.get('spotifyRedirectUri'); }

  static async getAccessToken() {
    let token = LMSettings.getSpotifyToken();
    if (!token) return null;
    if (token.expires_at < Date.now() + 60000) token = await this._refresh(token);
    return token?.access_token || null;
  }

  static async _refresh(token) {
    const body = new URLSearchParams({ client_id: this.clientId, grant_type: 'refresh_token', refresh_token: token.refresh_token });
    const res = await fetch(`${SP_AUTH}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await res.json();
    if (data.error) return null;
    const t = { access_token: data.access_token, refresh_token: data.refresh_token || token.refresh_token, expires_at: Date.now() + data.expires_in * 1000 };
    await LMSettings.setSpotifyToken(t);
    return t;
  }

  static async startOAuth() {
    if (!this.clientId) { ui.notifications.error('Set Spotify Client ID in module settings'); return; }
    const verifier = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(64)))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
    sessionStorage.setItem('lm-pkce', verifier);
    const params = new URLSearchParams({ client_id: this.clientId, response_type: 'code', redirect_uri: this.redirectUri, code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES });
    window.open(`${SP_AUTH}/authorize?${params}`, 'spotify-auth', 'width=500,height=700');
  }

  static async exchangeCode(code) {
    const verifier = sessionStorage.getItem('lm-pkce');
    if (!verifier) throw new Error('No PKCE verifier');
    const body = new URLSearchParams({ client_id: this.clientId, grant_type: 'authorization_code', code, redirect_uri: this.redirectUri, code_verifier: verifier });
    const res = await fetch(`${SP_AUTH}/api/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    const data = await res.json();
    if (data.error) throw new Error(data.error_description);
    await LMSettings.setSpotifyToken({ access_token: data.access_token, refresh_token: data.refresh_token, expires_at: Date.now() + data.expires_in * 1000 });
    sessionStorage.removeItem('lm-pkce');
  }

  static async fetch(path, opts = {}) {
    const token = await this.getAccessToken();
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(`${SP_API}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...opts.headers } });
    if (res.status === 204) return null;
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data;
  }

  static async getUserPlaylists() {
    const data = await this.fetch('/me/playlists?limit=50');
    return (data.items || []).map(p => ({ id: p.id, name: p.name, trackCount: p.tracks.total, image: p.images?.[0]?.url || '', source: 'spotify', uri: p.uri }));
  }

  static async getPlaylistTracks(id) {
    const data = await this.fetch(`/playlists/${id}/tracks?limit=100&fields=items(track(id,name,uri,duration_ms,artists,album(name,images)))`);
    return (data.items || []).filter(i => i.track?.id).map(i => {
      const t = i.track;
      const customName = LMSettings.getTrackName(t.id);
      return { id: t.id, title: t.name, displayTitle: customName || t.name, isRenamed: !!customName, artist: t.artists?.map(a => a.name).join(', ') || '', albumArt: t.album?.images?.[0]?.url || '', duration: Math.floor(t.duration_ms / 1000), source: 'spotify', uri: t.uri };
    });
  }

  static async searchTracks(query) {
    const data = await this.fetch(`/search?q=${encodeURIComponent(query)}&type=track&limit=20`);
    return (data.tracks?.items || []).map(t => {
      const customName = LMSettings.getTrackName(t.id);
      return { id: t.id, title: t.name, displayTitle: customName || t.name, isRenamed: !!customName, artist: t.artists?.map(a => a.name).join(', ') || '', albumArt: t.album?.images?.[0]?.url || '', duration: Math.floor(t.duration_ms / 1000), source: 'spotify', uri: t.uri };
    });
  }
}
