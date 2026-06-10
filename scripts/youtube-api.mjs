/**
 * Lazy Music — YouTube API
 */

import { LMSettings } from './settings.mjs';

const YT_BASE = 'https://www.googleapis.com/youtube/v3';

export class YouTubeAPI {
  static get key() { return LMSettings.get('youtubeApiKey'); }

  static async getPlaylistInfo(playlistId) {
    const res = await fetch(`${YT_BASE}/playlists?part=snippet,contentDetails&id=${playlistId}&key=${this.key}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    if (!data.items?.length) throw new Error('Playlist not found or not public');
    return data.items[0];
  }

  static async getPlaylistItems(playlistId) {
    const items = [];
    let pageToken = '';
    let page = 0;
    do {
      page++;
      console.log(`Lazy Music | YT page ${page}, loaded ${items.length}...`);
      const url = `${YT_BASE}/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50&key=${this.key}${pageToken ? '&pageToken=' + pageToken : ''}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      for (const item of data.items || []) {
        const s = item.snippet;
        if (!s?.resourceId?.videoId) continue;
        if (s.title === 'Private video' || s.title === 'Deleted video') continue;
        const customName = LMSettings.getTrackName(s.resourceId.videoId);
        items.push({
          id: s.resourceId.videoId,
          title: s.title,
          displayTitle: customName || s.title,
          isRenamed: !!customName,
          artist: s.videoOwnerChannelTitle || '',
          albumArt: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || '',
          source: 'youtube'
        });
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    console.log(`Lazy Music | YT playlist loaded: ${items.length} tracks`);
    return items;
  }

  static async search(query) {
    const url = `${YT_BASE}/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=20&key=${this.key}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return (data.items || []).map(item => {
      const customName = LMSettings.getTrackName(item.id.videoId);
      return {
        id: item.id.videoId,
        title: item.snippet.title,
        displayTitle: customName || item.snippet.title,
        isRenamed: !!customName,
        artist: item.snippet.channelTitle,
        albumArt: item.snippet.thumbnails?.medium?.url || '',
        source: 'youtube'
      };
    });
  }

  static extractPlaylistId(urlOrId) {
    try { return new URL(urlOrId).searchParams.get('list') || urlOrId; } catch { return urlOrId; }
  }
}
