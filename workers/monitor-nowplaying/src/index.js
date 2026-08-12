/**
 * Cloudflare Worker now-playing monitor.
 * Cron: every minute. Also runs on GET / for a manual trigger.
 * Merges station NP feeds into data/history.json via the GitHub Contents API.
 */

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_STATION = 500;

const STATIONS = [
    { id: '0', name: 'Glgltz', type: 'glzLiveSchedule', rootId: 1920 },
    { id: '1', name: 'Eco', type: 'ecoFirestore' },
    { id: '2', name: '88FM', type: 'kanAcr', channelId: 4 },
    { id: '3', name: '106FM', type: 'ecastPlayerInfo', url: 'https://live.ecast.co.il/AudioPlayer/galimlive/playerInfo' }
];

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

function encodeBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function decodeBase64(b64) {
    const binary = atob(String(b64 || '').replace(/\n/g, ''));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
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
    const proxyUrl = 'https://r.jina.ai/' + url;
    const response = await fetch(proxyUrl, {
        headers: {
            Accept: 'text/plain',
            'X-Engine': 'curl',
            'X-Respond-With': 'text',
            'X-Timeout': '25',
            ...extraHeaders
        }
    });
    if (!response.ok) throw new Error(`jina HTTP ${response.status} for ${url}`);
    return extractJsonObject(await response.text());
}

async function fetchJsonWithFallback(url, options = {}) {
    try {
        const data = await fetchJson(url, options);
        if (data) return data;
    } catch (err) {
        console.warn('direct fetch failed:', err.message || err);
    }
    return fetchViaJina(url, options.jinaHeaders || {});
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

async function collectGlzSegments(rootId) {
    const url = `https://glz.co.il/umbraco/api/playerv2/LiveSchedule?rootId=${encodeURIComponent(rootId)}`;
    const data = await fetchJsonWithFallback(url);
    const segments = Array.isArray(data && data.segments) ? data.segments : [];
    const now = new Date().toISOString();
    return segments
        .map(seg => {
            const title = String(seg.title || seg.Title || '').trim();
            const artist = String(seg.desc || seg.Desc || seg.artist || seg.Artist || '').trim();
            if (!title) return null;
            const playedAt = seg.startsUtc || seg.StartsUtc || now;
            return {
                artist,
                title,
                raw: artist ? `${artist} - ${title}` : title,
                playedAt,
                source: 'liveSchedule'
            };
        })
        .filter(Boolean);
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
        case 'glzLiveSchedule':
            return collectGlzSegments(station.rootId);
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

function shouldAppendSnapshot(existingEntries, incoming) {
    if (!incoming.length) return [];
    const latest = existingEntries[0];
    return incoming.filter(entry => {
        if (!latest) return true;
        return songKey(latest) !== songKey(entry);
    });
}

function ghHeaders(token) {
    return {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'radio-monitor-nowplaying',
        'X-GitHub-Api-Version': '2022-11-28'
    };
}

async function loadHistoryFromGitHub(env) {
    const path = env.HISTORY_PATH || 'data/history.json';
    const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(env.GITHUB_BRANCH || 'main')}`;
    const response = await fetch(url, { headers: ghHeaders(env.GITHUB_TOKEN) });
    if (response.status === 404) {
        return { history: emptyHistory(), sha: null, previousText: null };
    }
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`GitHub GET ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = await response.json();
    const text = decodeBase64(payload.content);
    return {
        history: normalizeHistory(JSON.parse(text)),
        sha: payload.sha,
        previousText: text
    };
}

async function commitHistoryToGitHub(env, history, sha) {
    const path = env.HISTORY_PATH || 'data/history.json';
    const text = JSON.stringify(history, null, 2) + '\n';
    const url = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
    const body = {
        message: 'Update song history from now-playing monitor.',
        content: encodeBase64(text),
        branch: env.GITHUB_BRANCH || 'main'
    };
    if (sha) body.sha = sha;

    const response = await fetch(url, {
        method: 'PUT',
        headers: {
            ...ghHeaders(env.GITHUB_TOKEN),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    if (!response.ok) {
        const errBody = await response.text();
        throw new Error(`GitHub PUT ${response.status}: ${errBody.slice(0, 400)}`);
    }
    return text;
}

async function pollOnce(history) {
    let changed = false;
    const summary = [];

    for (const station of STATIONS) {
        const bucket = history.stations[station.id];
        try {
            let incoming = await collectForStation(station);
            if (station.type !== 'glzLiveSchedule') {
                incoming = shouldAppendSnapshot(bucket.entries, incoming);
            }
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
    if (!env.GITHUB_TOKEN) {
        throw new Error('Missing GITHUB_TOKEN secret');
    }
    if (!env.GITHUB_REPO) {
        throw new Error('Missing GITHUB_REPO var');
    }

    const { history, sha, previousText } = await loadHistoryFromGitHub(env);
    const { changed, summary, history: next } = await pollOnce(history);
    const nextText = JSON.stringify(next, null, 2) + '\n';
    const contentChanged = changed && nextText !== previousText;

    if (contentChanged) {
        await commitHistoryToGitHub(env, next, sha);
        console.log('history updated');
    } else {
        console.log('history unchanged');
    }
    console.log(summary.join(' | '));

    return {
        committed: contentChanged,
        updatedAt: next.updatedAt,
        summary
    };
}

export default {
    async scheduled(controller, env) {
        await runMonitor(env);
    },

    async fetch(request, env) {
        const url = new URL(request.url);
        if (url.pathname !== '/' && url.pathname !== '/run') {
            return new Response('Not found', { status: 404 });
        }
        try {
            const result = await runMonitor(env);
            return Response.json({
                ok: true,
                ...result
            });
        } catch (err) {
            console.error(err);
            return Response.json(
                { ok: false, error: String(err && err.message ? err.message : err) },
                { status: 500 }
            );
        }
    }
};
