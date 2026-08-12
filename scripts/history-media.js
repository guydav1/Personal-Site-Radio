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

    function toYouTubeUrl(video) {
        const raw = video && (video.url || video.link || '');
        if (!raw) return null;
        if (/^https?:\/\//i.test(raw)) return raw;
        if (String(raw).includes('watch?v=')) return 'https://www.youtube.com' + raw;
        const id = video.id || video.videoId;
        if (id) return `https://www.youtube.com/watch?v=${id}`;
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
                        if (!url) continue;
                        return {
                            url,
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
        downloadMp3
    };
})(window);
