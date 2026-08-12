/**
 * Local / one-shot station now-playing monitor (writes data/history.json on disk).
 * Production: Cloudflare Worker + KV — workers/monitor-nowplaying/
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HISTORY_PATH = join(ROOT, 'data', 'history.json');
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES_PER_STATION = 500;

const STATIONS = [
    { id: '0', name: 'Glgltz', type: 'glzCurrentSong', rootId: 1920 },
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
        // Imperva / HTML challenge pages are not usable JSON.
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
    const proxyUrl = 'https://r.jina.ai/' + url;
    const response = await fetch(proxyUrl, {
        headers: {
            Accept: 'text/plain',
            'X-Engine': engine,
            'X-Respond-With': 'text',
            'X-Timeout': engine === 'browser' ? '40' : '25',
            ...extraHeaders
        }
    });
    if (!response.ok) throw new Error(`jina HTTP ${response.status} (${engine}) for ${url}`);
    const data = extractJsonObject(await response.text());
    if (!data) throw new Error(`jina empty JSON (${engine}) for ${url}`);
    return data;
}

async function fetchJsonWithFallback(url, options = {}) {
    try {
        const data = await fetchJson(url, options);
        if (data) return data;
    } catch (err) {
        console.warn('direct fetch failed:', err.message || err);
    }

    const engines = options.jinaEngines || ['browser', 'browser', 'curl'];
    let lastError = null;
    for (const engine of engines) {
        try {
            return await fetchViaJina(url, {
                ...(options.jinaHeaders || {}),
                'X-Engine': engine
            });
        } catch (err) {
            lastError = err;
            console.warn(`jina ${engine} failed:`, err.message || err);
            if (/jina HTTP 429/.test(String(err && err.message))) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }
    }
    throw lastError || new Error(`All fetches failed for ${url}`);
}

function firestoreString(fields, key) {
    return fields && fields[key] && fields[key].stringValue
        ? fields[key].stringValue.trim()
        : '';
}

function loadHistory() {
    if (!existsSync(HISTORY_PATH)) {
        return {
            updatedAt: null,
            stations: Object.fromEntries(
                STATIONS.map(s => [s.id, { name: s.name, entries: [] }])
            )
        };
    }
    const data = JSON.parse(readFileSync(HISTORY_PATH, 'utf8'));
    for (const station of STATIONS) {
        if (!data.stations[station.id]) {
            data.stations[station.id] = { name: station.name, entries: [] };
        }
        data.stations[station.id].name = station.name;
        data.stations[station.id].entries = data.stations[station.id].entries || [];
    }
    return data;
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
    const data = await fetchJsonWithFallback(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            Referer: 'https://glz.co.il/',
            Origin: 'https://glz.co.il',
            Accept: 'application/json,text/plain,*/*'
        },
        jinaEngines: ['browser', 'browser', 'curl']
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

function shouldAppendSnapshot(existingEntries, incoming) {
    // For non-schedule feeds: only keep a new row when the song itself changed
    // (ignore minute-by-minute re-polls of the same track).
    if (!incoming.length) return [];
    const latest = existingEntries[0];
    return incoming.filter(entry => {
        if (!latest) return true;
        return songKey(latest) !== songKey(entry);
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollOnce(history) {
    let changed = false;
    const summary = [];

    for (const station of STATIONS) {
        const bucket = history.stations[station.id];
        const beforeScrub = bucket.entries.length;
        bucket.entries = pruneStationEntries(bucket.entries.filter(isKeepableHistoryEntry));
        if (bucket.entries.length !== beforeScrub) changed = true;
    }

    for (const station of STATIONS) {
        const bucket = history.stations[station.id];
        try {
            let incoming = await collectForStation(station);
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
        mkdirSync(dirname(HISTORY_PATH), { recursive: true });
        writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n', 'utf8');
        console.log('history updated');
    } else {
        console.log('history unchanged');
    }
    console.log(summary.join(' | '));
    return changed;
}

async function main() {
    // GitHub Actions won't honor cron denser than ~5 minutes. In CI we loop inside
    // one job so we still sample about once a minute between scheduled starts.
    const durationMs = Math.max(0, Number(process.env.MONITOR_DURATION_MS || 0) || 0);
    const intervalMs = Math.max(15000, Number(process.env.MONITOR_INTERVAL_MS || 60000) || 60000);
    const history = loadHistory();
    const started = Date.now();
    let pass = 0;

    do {
        pass += 1;
        console.log(`poll pass ${pass}`);
        await pollOnce(history);
        if (!durationMs) break;
        const elapsed = Date.now() - started;
        if (elapsed + intervalMs >= durationMs) break;
        await sleep(intervalMs);
    } while (Date.now() - started < durationMs);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
