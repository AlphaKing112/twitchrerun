'use client';

import { useState, useEffect } from 'react';
import { Plus, Trash2, Copy, Play, Loader2, Link as LinkIcon } from 'lucide-react';

export default function Home() {
  const [vods, setVods] = useState<any[]>([]);
  const [newUrl, setNewUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchVods();
  }, []);

  const fetchVods = async () => {
    try {
      const res = await fetch('/api/vods');
      const data = (await res.json()) as any[];
      setVods(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Failed to fetch VODs:', e);
    } finally {
      setLoading(false);
    }
  };

  const addVod = async () => {
    if (!newUrl) return;
    setAdding(true);
    try {
      // Extract VOD ID
      const match = newUrl.match(/(?:\/videos\/|v=)(\d+)/);
      const vodId = match ? match[1] : newUrl.match(/^\d+$/) ? newUrl : null;

      if (!vodId) {
        alert('Invalid Twitch URL or VOD ID');
        return;
      }

      const res = await fetch('/api/vods', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vodId, title: `VOD ${vodId}` }),
      });
      const data = (await res.json()) as any[];
      setVods(data);
      setNewUrl('');
    } catch (e) {
      console.error('Failed to add VOD:', e);
    } finally {
      setAdding(false);
    }
  };

  const deleteVod = async (id: string) => {
    try {
      const res = await fetch(`/api/vods?id=${id}`, { method: 'DELETE' });
      const data = (await res.json()) as any[];
      setVods(data);
    } catch (e) {
      console.error('Failed to delete VOD:', e);
    }
  };

  const copyPlaylistUrl = () => {
    const url = `${window.location.origin}/api/playlist`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <main className="container">
      <header>
        <h1>Twitch Rerun Manager</h1>
        <p className="subtitle">M3U Generator for OBS VLC Source</p>
      </header>

      <section className="card">
        <h2 style={{ marginBottom: '1.5rem', fontSize: '1.25rem' }}>Add New VOD</h2>
        <div className="input-group">
          <input
            type="text"
            placeholder="Paste Twitch VOD URL (e.g., https://twitch.tv/videos/12345)"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addVod()}
          />
          <button className="primary" onClick={addVod} disabled={adding}>
            {adding ? <Loader2 className="animate-spin" size={20} /> : <Plus size={20} />}
            Add
          </button>
        </div>
      </section>

      <section className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 style={{ fontSize: '1.25rem' }}>VOD Playlist</h2>
          <div style={{ color: '#71717a', fontSize: '0.9rem' }}>{vods.length} VODs</div>
        </div>

        {loading ? (
          <div className="empty-state">
            <Loader2 className="animate-spin mx-auto" size={32} />
          </div>
        ) : vods.length === 0 ? (
          <div className="empty-state">
            <Play size={48} style={{ opacity: 0.2, marginBottom: '1rem' }} />
            <p>No VODs added yet. Add some to get started!</p>
          </div>
        ) : (
          <div className="vod-list">
            {vods.map((vod) => (
              <div key={vod.id} className="vod-item animate-fade-in">
                <div className="vod-info">
                  <h3>{vod.title}</h3>
                  <p>ID: {vod.id} • Added {new Date(vod.addedAt).toLocaleDateString()}</p>
                </div>
                <button className="danger" onClick={() => deleteVod(vod.id)}>
                  <Trash2 size={18} />
                </button>
              </div>
            ))}
          </div>
        )}

        {vods.length > 0 && (
          <div style={{ marginTop: '2rem' }}>
            <p style={{ fontSize: '0.9rem', color: '#a1a1aa', marginBottom: '0.5rem' }}>OBS VLC Playlist URL:</p>
            <div className="playlist-url">
              <code>{typeof window !== 'undefined' ? `${window.location.origin}/api/playlist` : ''}</code>
              <button className="secondary copy-btn" onClick={copyPlaylistUrl}>
                {copied ? 'Copied!' : <><Copy size={16} /> Copy</>}
              </button>
            </div>
          </div>
        )}
      </section>

      <footer style={{ textAlign: 'center', marginTop: '4rem', color: '#3f3f46', fontSize: '0.8rem' }}>
        <p>Deploy to Cloudflare Pages for 24/7 uptime.</p>
      </footer>
    </main>
  );
}
