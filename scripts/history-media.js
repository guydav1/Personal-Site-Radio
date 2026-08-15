/**
 * YouTube open + MP3 download helpers for history.html
 * (leaner than the live-page matcher; good enough for row actions).
 */
(function (global) {
    const PIPED_INSTANCES = [
        'https://api.piped.private.coffee',
        'https://pipedapi.adminforge.de',
        'https://pipedapi.kavin.rocks'
    ];

    function songQuery(song) {
        if (!song) return '';
        return song.artist ? `${song.artist} ${song.title}` : (song.title || song.raw || '');
    }

    function extractJsonObject(text) {
        const start = String(text || '').indexOf('{');
        const end = String(text || '').lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try {
            return JSON.parse(text.slice(start, end + 1));
        } catch {
            return null;
        }
    }

    function videoIdFromUrl(url) {
        const text = String(url || '');
        const match = text.match(/[?&]v=([\w-]{11})/)
            || text.match(/youtu\.be\/([\w-]{11})/)
            || text.match(/\/shorts\/([\w-]{11})/);
        return match ? match[1] : null;
    }

    function toYouTubeUrl(video) {
        const raw = video && (video.url || video.link || '');
        const id = (video && (video.id || video.videoId)) || videoIdFromUrl(raw);
        if (id) return `https://www.youtube.com/watch?v=${id}`;
        if (!raw) return null;
        if (/^https?:\/\//i.test(raw)) return raw;
        if (String(raw).includes('watch?v=')) return 'https://www.youtube.com' + raw;
        return null;
    }

    async function searchYouTube(song) {
        const query = songQuery(song);
        if (!query) throw new Error('No song query');

        const searches = [
            `${song.artist || ''} - ${song.title || ''}`.trim(),
            query,
            `${query} official audio`
        ].filter(Boolean);

        let lastError = null;
        for (const base of PIPED_INSTANCES) {
            for (const q of searches) {
                try {
                    const response = await fetch(
                        `${base}/search?q=${encodeURIComponent(q)}&filter=videos`
                    );
                    if (!response.ok) throw new Error('search failed');
                    const data = await response.json();
                    const items = data.items || data || [];
                    for (const item of items) {
                        if (!item) continue;
                        const url = toYouTubeUrl(item);
                        const id = item.id || item.videoId || videoIdFromUrl(url || item.url);
                        if (!url && !id) continue;
                        return {
                            url: url || (id ? `https://www.youtube.com/watch?v=${id}` : null),
                            id,
                            title: item.title || query
                        };
                    }
                } catch (err) {
                    lastError = err;
                }
            }
        }
        throw lastError || new Error('No YouTube match found');
    }

    const previewCache = new Map();
    const SAMPLE_SEC = 25;

    function pickAudioStream(streams) {
        const usable = (streams || []).filter(stream => stream && stream.url && !stream.videoOnly);
        if (!usable.length) return null;
        const ranked = usable.slice().sort((a, b) => (Number(a.bitrate) || 0) - (Number(b.bitrate) || 0));
        return ranked.find(stream => /mp4|m4a|mpeg|aac/i.test(`${stream.mimeType || ''} ${stream.format || ''}`))
            || ranked[0];
    }

    function sampleWindow(durationSec) {
        const duration = Number(durationSec) || 0;
        const sampleSec = SAMPLE_SEC;
        if (duration > 0 && duration <= sampleSec + 5) {
            return { startSec: 0, sampleSec: Math.max(8, duration) };
        }
        let startSec = duration >= 80 ? 40 : 20;
        if (duration > 0 && startSec + sampleSec > duration) {
            startSec = Math.max(0, duration - sampleSec);
        }
        return { startSec, sampleSec };
    }

    async function resolvePreview(song) {
        const key = songQuery(song);
        if (previewCache.has(key)) return previewCache.get(key);

        const video = await searchYouTube(song);
        const id = video.id || videoIdFromUrl(video.url);
        if (!id) throw new Error('No video id');

        let lastError = null;
        for (const base of PIPED_INSTANCES) {
            try {
                const response = await fetch(`${base}/streams/${encodeURIComponent(id)}`);
                if (!response.ok) throw new Error('streams failed');
                const data = await response.json();
                const stream = pickAudioStream(data.audioStreams);
                if (!stream) throw new Error('no audio stream');
                const window = sampleWindow(data.duration);
                const preview = {
                    url: stream.url,
                    title: data.title || video.title,
                    startSec: window.startSec,
                    sampleSec: window.sampleSec
                };
                previewCache.set(key, preview);
                return preview;
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error('Could not load preview');
    }

    function triggerUrlDownload(url) {
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        iframe.src = url;
        document.body.appendChild(iframe);
        setTimeout(() => iframe.remove(), 60000);
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function parseLoaderStart(text) {
        const data = extractJsonObject(text);
        if (data && data.progress_url) return data;
        const progressMatch = String(text || '').match(/"progress_url"\s*:\s*"((?:\\.|[^"\\])*)"/);
        if (!progressMatch) return null;
        try {
            return { progress_url: JSON.parse('"' + progressMatch[1] + '"') };
        } catch {
            return null;
        }
    }

    async function startLoaderJob(youtubeUrl) {
        const startUrl = 'https://loader.to/ajax/download.php?format=mp3&url='
            + encodeURIComponent(youtubeUrl);
        const response = await fetch('https://r.jina.ai/' + startUrl, {
            headers: {
                Accept: 'text/plain',
                'X-Engine': 'curl',
                'X-Respond-With': 'text',
                'X-Timeout': '20'
            }
        });
        if (!response.ok) throw new Error('MP3 start failed');
        const started = parseLoaderStart(await response.text());
        if (!started || !started.progress_url) {
            throw new Error('MP3 converter did not start');
        }
        return started;
    }

    async function waitForMp3Url(progressUrl, onStatus) {
        for (let i = 0; i < 90; i++) {
            if (i > 0) await sleep(1000);
            const progress = await fetch(progressUrl).then(r => r.json());
            if (progress.download_url) return progress.download_url;
            if (progress.success === 0 && /error|fail/i.test(progress.text || '')) {
                throw new Error(progress.text || 'MP3 conversion failed');
            }
            if (onStatus) {
                const pct = Number(progress.progress);
                if (Number.isFinite(pct) && pct > 0) {
                    onStatus(`Waiting on converter… ${Math.min(99, Math.round(pct))}%`);
                } else if (i === 0 || i % 3 === 0) {
                    onStatus(progress.text || 'Waiting on converter…');
                }
            }
        }
        throw new Error('MP3 conversion timed out');
    }

    async function downloadMp3(song, onStatus) {
        if (onStatus) onStatus('Searching YouTube…');
        const video = await searchYouTube(song);
        if (onStatus) onStatus(`Found: ${video.title}`);
        const started = await startLoaderJob(video.url);
        if (onStatus) onStatus('Converting to MP3…');
        const downloadUrl = await waitForMp3Url(started.progress_url, onStatus);
        if (onStatus) onStatus('Saving file…');
        triggerUrlDownload(downloadUrl);
        return video;
    }

    async function openYouTube(song) {
        try {
            const video = await searchYouTube(song);
            global.open(video.url, '_blank', 'noopener,noreferrer');
            return video;
        } catch (err) {
            const q = encodeURIComponent(songQuery(song));
            global.open('https://www.youtube.com/results?search_query=' + q, '_blank', 'noopener,noreferrer');
            return null;
        }
    }

    global.HistoryMedia = {
        songQuery,
        searchYouTube,
        openYouTube,
        downloadMp3,
        resolvePreview
    };
})(window);
