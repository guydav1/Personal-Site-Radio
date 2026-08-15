/**
 * Cloudflare Worker now-playing monitor.
 * Cron: every minute → merge station NP into KV.
 * GET /history.json → public history for the site (CORS enabled).
 * GET / or /run → manual poll.
 */

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_STATION = 500;

const STATIONS = [
    { id: '0', name: 'Glgltz', type: 'glzCurrentSong', rootId: 1920 },
    { id: '1', name: 'Eco', type: 'ecoFirestore' },
    { id: '2', name: '88FM', type: 'kanAcr', channelId: 4 },
    { id: '3', name: '106FM', type: 'ecastPlayerInfo', url: 'https://live.ecast.co.il/AudioPlayer/galimlive/playerInfo' }
];

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Max-Age': '86400'
};

function normalizeKey(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function entryKey(entry) {
    return `${normalizeKey(entry.artist)}\0${normalizeKey(entry.title)}\0${entry.playedAt || ''}`;
}

function songKey(entry) {
    return `${normalizeKey(entry.artist)}\0${normalizeKey(entry.title)}`;
}

function parseStreamTitle(raw) {
    const title = String(raw || '').trim();
    if (!title) return null;
    const parts = title.split(/\s[-–—]\s/);
    if (parts.length >= 2) {
        return {
            artist: parts[0].trim(),
            title: parts.slice(1).join(' - ').trim(),
            raw: title
        };
    }
    return { artist: '', title, raw: title };
}

function extractJsonObject(text) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

async function fetchJson(url, { headers = {}, timeoutMs = 25000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            headers: { Accept: 'application/json', ...headers },
            signal: controller.signal
        });
        const type = (response.headers.get('content-type') || '').toLowerCase();
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url}`);
        }
        if (type.includes('json') || /^[{\[]/.test(text.trim())) {
            try {
                return JSON.parse(text);
            } catch {
                return extractJsonObject(text);
            }
        }
        if (/incapsula|NOINDEX,\s*NOFOLLOW/i.test(text)) {
            throw new Error(`Blocked/HTML response for ${url}`);
        }
        return extractJsonObject(text);
    } finally {
        clearTimeout(timer);
    }
}

async function fetchViaJina(url, extraHeaders = {}) {
    const engine = extraHeaders['X-Engine'] || 'curl';
    const headers = {
        Accept: 'text/plain',
        'X-Engine': engine,
        'X-Respond-With': 'text',
        'X-Timeout': engine === 'browser' ? '40' : '25'
    };
    // Only forward non-engine overrides (avoid clobbering Accept / timeout).
    for (const [key, value] of Object.entries(extraHeaders || {})) {
        if (key === 'X-Engine') continue;
        headers[key] = value;
    }
    const proxyUrl = 'https://r.jina.ai/' + url;
    const response = await fetch(proxyUrl, { headers });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`jina HTTP ${response.status} (${engine}) for ${url}`);
    }
    if (/RateLimitTriggeredError|Per IP rate limit/i.test(text)) {
        throw new Error(`jina HTTP 429 (${engine}) for ${url}`);
    }
    const data = extractJsonObject(text);
    if (!data) throw new Error(`jina empty JSON (${engine}) for ${url}`);
    return data;
}

async function fetchViaAllOrigins(url) {
    const proxyUrl = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(url);
    const response = await fetch(proxyUrl, {
        headers: { Accept: 'application/json,text/plain,*/*' }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`allorigins HTTP ${response.status}`);
    if (/incapsula|NOINDEX,\s*NOFOLLOW/i.test(text)) {
        throw new Error('allorigins got Imperva HTML');
    }
    const data = extractJsonObject(text);
    if (!data) throw new Error('allorigins empty JSON');
    return data;
}

async function fetchJsonWithFallback(url, options = {}) {
    try {
        const data = await fetchJson(url, options);
        // Imperva sometimes returns 200 HTML; never accept non-schedule payloads.
        if (data && (Array.isArray(data.segments) || data.serverNowUtc || data.fields || data.title || data.nowplaying)) {
            return data;
        }
    } catch (err) {
        console.warn('direct fetch failed:', err.message || err);
    }

    // Cloudflare IPs are often curl-rate-limited on jina; browser works but can 429 under burst.
    const engines = options.jinaEngines || ['browser', 'browser', 'curl'];
    let lastError = null;
    const errors = [];
    for (const engine of engines) {
        try {
            return await fetchViaJina(url, {
                ...(options.jinaHeaders || {}),
                'X-Engine': engine
            });
        } catch (err) {
            lastError = err;
            errors.push(String(err && err.message ? err.message : err));
            console.warn(`jina ${engine} failed:`, err.message || err);
            if (/jina HTTP 429/.test(String(err && err.message))) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }
    }

    if (options.tryAllOrigins) {
        try {
            return await fetchViaAllOrigins(url);
        } catch (err) {
            lastError = err;
            errors.push(String(err && err.message ? err.message : err));
        }
    }

    throw lastError || new Error(`All fetches failed for ${url}: ${errors.join(' | ')}`);
}

function firestoreString(fields, key) {
    return fields && fields[key] && fields[key].stringValue
        ? fields[key].stringValue.trim()
        : '';
}

function emptyHistory() {
    return {
        updatedAt: null,
        stations: Object.fromEntries(
            STATIONS.map(s => [s.id, { name: s.name, entries: [] }])
        )
    };
}

function normalizeHistory(data) {
    const history = data && typeof data === 'object' ? data : emptyHistory();
    if (!history.stations || typeof history.stations !== 'object') {
        history.stations = {};
    }
    for (const station of STATIONS) {
        if (!history.stations[station.id]) {
            history.stations[station.id] = { name: station.name, entries: [] };
        }
        history.stations[station.id].name = station.name;
        history.stations[station.id].entries = history.stations[station.id].entries || [];
    }
    return history;
}

function pruneStationEntries(entries) {
    const cutoff = Date.now() - MAX_AGE_MS;
    return entries
        .filter(entry => {
            const t = Date.parse(entry.playedAt || '');
            return Number.isFinite(t) && t >= cutoff;
        })
        .sort((a, b) => Date.parse(b.playedAt) - Date.parse(a.playedAt))
        .slice(0, MAX_ENTRIES_PER_STATION);
}

function mergeEntries(existing, incoming) {
    const byKey = new Map();
    for (const entry of existing) {
        byKey.set(entryKey(entry), entry);
    }
    let added = 0;
    for (const entry of incoming) {
        const key = entryKey(entry);
        if (!byKey.has(key)) {
            byKey.set(key, entry);
            added += 1;
        }
    }
    return {
        entries: pruneStationEntries([...byKey.values()]),
        added
    };
}

function pickCurrentGlzSegment(data) {
    const segments = Array.isArray(data && data.segments) ? data.segments : [];
    if (!segments.length) return null;
    const now = Date.parse((data && data.serverNowUtc) || '') || Date.now();
    const current = segments.find(seg => {
        const start = Date.parse(seg.startsUtc || seg.StartsUtc || '');
        const endRaw = seg.endsUtc ?? seg.EndsUtc;
        const end = endRaw == null || endRaw === '' ? NaN : Date.parse(endRaw);
        if (!Number.isFinite(start)) return false;
        if (Number.isFinite(end)) return start <= now && now < end;
        return start <= now;
    });
    return current || segments[segments.length - 1];
}

function isGlzSongSegment(seg) {
    if (!seg || typeof seg !== 'object') return false;
    const title = String(seg.title || seg.Title || '').trim();
    const artist = String(seg.desc || seg.Desc || seg.artist || seg.Artist || '').trim();
    if (!title || !artist) return false;
    // Ads / promos / show blocks often land in the same feed.
    const blob = `${artist} ${title}`;
    if (/מקבוק|פרסומת|תשדיר|מבצע|הלוואה|ביטוח|\bKSP\b|יולי\s*\d+/i.test(blob)) {
        return false;
    }
    if (/עשורים עם|מוזיקה ברצף|לינוי וובה|שנות ה-/i.test(blob)) {
        return false;
    }
    return true;
}

async function collectGlzCurrent(rootId) {
    const url = `https://glz.co.il/umbraco/api/playerv2/LiveSchedule?rootId=${encodeURIComponent(rootId)}`;
    // Imperva blocks most datacenter IPs; jina curl is often 429'd — prefer browser engine.
    const data = await fetchJsonWithFallback(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            Referer: 'https://glz.co.il/',
            Origin: 'https://glz.co.il',
            Accept: 'application/json,text/plain,*/*'
        },
        jinaEngines: ['browser', 'browser', 'curl'],
        tryAllOrigins: true
    });
    const seg = pickCurrentGlzSegment(data);
    if (!isGlzSongSegment(seg)) return [];
    const title = String(seg.title || seg.Title || '').trim();
    const artist = String(seg.desc || seg.Desc || seg.artist || seg.Artist || '').trim();
    const playedAt = seg.startsUtc || seg.StartsUtc || new Date().toISOString();
    return [{
        artist,
        title,
        raw: `${artist} - ${title}`,
        playedAt,
        source: 'glzCurrent'
    }];
}

async function collectEcoCurrent() {
    const url = 'https://firestore.googleapis.com/v1/projects/eco-99-production/databases/(default)/documents/streamed_content/program';
    let data;
    try {
        data = await fetchJson(url);
    } catch {
        data = await fetchViaJina(url);
    }
    const fields = data && data.fields;
    const artist = firestoreString(fields, 'artist_name');
    const title = firestoreString(fields, 'song_name');
    if (!title || /^unknown$/i.test(title)) return [];
    return [{
        artist,
        title,
        raw: artist ? `${artist} - ${title}` : title,
        playedAt: new Date().toISOString(),
        source: 'ecoFirestore'
    }];
}

async function collectKanCurrent(channelId) {
    const apiUrl = `https://www.kan.org.il/api/arc-cloud/get-live-track-data?channelId=${channelId}`;
    let data = null;
    try {
        data = await fetchJson(apiUrl, {
            headers: {
                Referer: 'https://www.kan.org.il/content/kan/kan-88/'
            }
        });
    } catch {
        data = await fetchViaJina(apiUrl, { 'X-Respond-Timing': 'network-idle' });
    }
    if (!data || !data.title || data.title === 'Unknown') return [];
    const artist = Array.isArray(data.artists) ? data.artists.join(', ') : '';
    return [{
        artist,
        title: String(data.title).trim(),
        raw: artist ? `${artist} - ${data.title}` : String(data.title).trim(),
        playedAt: new Date().toISOString(),
        source: 'kanAcr'
    }];
}

async function collectEcastCurrent(url) {
    const data = await fetchJson(url);
    const parsed = parseStreamTitle((data && (data.nowplaying || data.SONGTITLE || data.songtitle)) || '');
    if (!parsed) return [];
    return [{
        artist: parsed.artist,
        title: parsed.title,
        raw: parsed.raw,
        playedAt: new Date().toISOString(),
        source: 'ecastPlayerInfo'
    }];
}

async function collectForStation(station) {
    switch (station.type) {
        case 'glzCurrentSong':
        case 'glzLiveSchedule':
            return collectGlzCurrent(station.rootId);
        case 'ecoFirestore':
            return collectEcoCurrent();
        case 'kanAcr':
            return collectKanCurrent(station.channelId);
        case 'ecastPlayerInfo':
            return collectEcastCurrent(station.url);
        default:
            return [];
    }
}

function isKeepableHistoryEntry(entry) {
    if (!entry || !entry.title) return false;
    if (!String(entry.artist || '').trim()) return false;
    const blob = `${entry.artist || ''} ${entry.title || ''} ${entry.raw || ''}`;
    if (/מקבוק|פרסומת|תשדיר|מבצע|\bKSP\b|יולי\s*\d+/i.test(blob)) return false;
    if (/עשורים עם|מוזיקה ברצף|לינוי וובה|שנות ה-/i.test(blob)) return false;
    return true;
}

function scrubHistory(history) {
    let changed = false;
    for (const station of STATIONS) {
        const bucket = history.stations[station.id];
        const before = bucket.entries.length;
        bucket.entries = pruneStationEntries(bucket.entries.filter(isKeepableHistoryEntry));
        if (bucket.entries.length !== before) changed = true;
    }
    return changed;
}

function shouldAppendSnapshot(existingEntries, incoming) {
    if (!incoming.length) return [];
    const latest = existingEntries[0];
    return incoming.filter(entry => {
        if (!latest) return true;
        return songKey(latest) !== songKey(entry);
    });
}

function historyKey(env) {
    return env.HISTORY_KEY || 'history';
}

async function seedHistoryFromUrl(env) {
    const seedUrl = env.HISTORY_SEED_URL;
    if (!seedUrl) return emptyHistory();
    try {
        const response = await fetch(seedUrl, {
            headers: { Accept: 'application/json' }
        });
        if (!response.ok) {
            console.warn('seed fetch failed:', response.status);
            return emptyHistory();
        }
        return normalizeHistory(await response.json());
    } catch (err) {
        console.warn('seed fetch error:', err.message || err);
        return emptyHistory();
    }
}

async function loadHistory(env) {
    if (!env.HISTORY) {
        throw new Error('Missing HISTORY KV binding');
    }
    const raw = await env.HISTORY.get(historyKey(env));
    if (raw) {
        try {
            return { history: normalizeHistory(JSON.parse(raw)), previousText: raw };
        } catch {
            console.warn('corrupt KV history; reseeding');
        }
    }
    const seeded = await seedHistoryFromUrl(env);
    const text = JSON.stringify(seeded, null, 2) + '\n';
    await env.HISTORY.put(historyKey(env), text);
    return { history: seeded, previousText: text };
}

async function saveHistory(env, history) {
    const text = JSON.stringify(history, null, 2) + '\n';
    await env.HISTORY.put(historyKey(env), text);
    return text;
}

async function pollOnce(history) {
    let changed = scrubHistory(history);
    const summary = [];

    for (const station of STATIONS) {
        const bucket = history.stations[station.id];
        try {
            let incoming = await collectForStation(station);
            // All stations: append only when the playing song changes.
            incoming = shouldAppendSnapshot(bucket.entries, incoming);
            const { entries, added } = mergeEntries(bucket.entries, incoming);
            if (added > 0 || entries.length !== bucket.entries.length) {
                changed = true;
            }
            bucket.entries = entries;
            summary.push(`${station.name}: +${added} (total ${entries.length})`);
        } catch (err) {
            summary.push(`${station.name}: error ${err.message || err}`);
            console.error(station.name, err);
        }
    }

    if (changed) {
        history.updatedAt = new Date().toISOString();
    }

    return { changed, summary, history };
}

async function runMonitor(env) {
    const { history, previousText } = await loadHistory(env);
    const { changed, summary, history: next } = await pollOnce(history);
    const nextText = JSON.stringify(next, null, 2) + '\n';
    const contentChanged = changed && nextText !== previousText;

    if (contentChanged) {
        await saveHistory(env, next);
        console.log('history updated');
    } else {
        console.log('history unchanged');
    }
    console.log(summary.join(' | '));

    return {
        saved: contentChanged,
        updatedAt: next.updatedAt,
        summary
    };
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...CORS_HEADERS,
            ...extraHeaders
        }
    });
}

async function serveHistory(env) {
    const { history } = await loadHistory(env);
    return new Response(JSON.stringify(history), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=30',
            ...CORS_HEADERS
        }
    });
}

const PREVIEW_SAMPLE_SEC = 25;
const PREVIEW_START_SEC = 40;

function videoIdFromText(value) {
    const text = String(value || '');
    const match = text.match(/[?&]v=([\w-]{11})/)
        || text.match(/youtu\.be\/([\w-]{11})/)
        || text.match(/\/shorts\/([\w-]{11})/)
        || text.match(/^([\w-]{11})$/);
    return match ? match[1] : null;
}

function firstSearchHit(data) {
    const items = Array.isArray(data && data.items) ? data.items
        : (Array.isArray(data) ? data : []);
    for (const item of items) {
        if (!item) continue;
        const id = item.videoId || item.id || videoIdFromText(item.url);
        if (!id) continue;
        return { id, title: item.title || '' };
    }
    return null;
}

async function searchPreviewVideo(query) {
    const searches = [query, `${query} official audio`].filter(Boolean);
    const endpoints = [
        q => `https://api.piped.private.coffee/search?q=${encodeURIComponent(q)}&filter=videos`,
        q => `https://invidious.materialio.us/api/v1/search?q=${encodeURIComponent(q)}&type=video`
    ];
    let lastError = null;
    for (const makeUrl of endpoints) {
        for (const q of searches) {
            try {
                const response = await fetch(makeUrl(q), {
                    headers: { Accept: 'application/json' }
                });
                if (!response.ok) {
                    throw new Error(`search HTTP ${response.status}`);
                }
                const hit = firstSearchHit(await response.json());
                if (hit) return hit;
            } catch (err) {
                lastError = err;
            }
        }
    }
    throw lastError || new Error('No preview match');
}

function previewPayload(hit, query) {
    const startSec = PREVIEW_START_SEC;
    const sampleSec = PREVIEW_SAMPLE_SEC;
    const endSec = startSec + sampleSec;
    return {
        videoId: hit.id,
        title: hit.title || query,
        startSec,
        sampleSec,
        embedUrl: `https://www.youtube-nocookie.com/embed/${hit.id}?autoplay=1&start=${startSec}&end=${endSec}&controls=0&rel=0&modestbranding=1&playsinline=1&disablekb=1`
    };
}

async function servePreview(requestUrl, env) {
    const query = String(requestUrl.searchParams.get('q') || '').trim();
    if (!query) {
        return jsonResponse({ ok: false, error: 'Missing q' }, 400);
    }
    const cacheKey = `preview:${normalizeKey(query)}`;
    if (env && env.HISTORY) {
        try {
            const cached = await env.HISTORY.get(cacheKey, 'json');
            if (cached && cached.videoId) {
                return jsonResponse(cached, 200, {
                    'Cache-Control': 'public, max-age=600'
                });
            }
        } catch (err) {
            console.warn('preview cache read failed:', err.message || err);
        }
    }
    const hit = await searchPreviewVideo(query);
    const payload = previewPayload(hit, query);
    if (env && env.HISTORY) {
        env.HISTORY.put(cacheKey, JSON.stringify(payload), {
            expirationTtl: 7 * 24 * 60 * 60
        }).catch(err => console.warn('preview cache write failed:', err.message || err));
    }
    return jsonResponse(payload, 200, {
        'Cache-Control': 'public, max-age=600'
    });
}

export default {
    async scheduled(controller, env) {
        await runMonitor(env);
    },

    async fetch(request, env) {
        const url = new URL(request.url);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return jsonResponse({ ok: false, error: 'Method not allowed' }, 405);
        }

        if (url.pathname === '/history.json' || url.pathname === '/history') {
            try {
                return await serveHistory(env);
            } catch (err) {
                console.error(err);
                return jsonResponse(
                    { ok: false, error: String(err && err.message ? err.message : err) },
                    500
                );
            }
        }

        if (url.pathname === '/preview') {
            try {
                return await servePreview(url, env);
            } catch (err) {
                console.error(err);
                return jsonResponse(
                    { ok: false, error: String(err && err.message ? err.message : err) },
                    502
                );
            }
        }

        if (url.pathname === '/' || url.pathname === '/run') {
            try {
                const result = await runMonitor(env);
                return jsonResponse({ ok: true, ...result });
            } catch (err) {
                console.error(err);
                return jsonResponse(
                    { ok: false, error: String(err && err.message ? err.message : err) },
                    500
                );
            }
        }

        return jsonResponse({ ok: false, error: 'Not found' }, 404);
    }
};
