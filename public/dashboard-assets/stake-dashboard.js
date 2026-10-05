document.addEventListener('DOMContentLoaded', function () {
    // ============================================
    // CONSTANTS AND CONFIGURATION
    // ============================================
    // Dashboard release version, shown in the info line. The wrapper page
    // (src/pages/index.astro) parses this exact
    // line at build time for the JSON-LD softwareVersion: keep the format.
    const DASHBOARD_VERSION = '3.0.0';
    const FALLBACK_JSON_URL = 'https://raw.githubusercontent.com/SOFZP/Solana-Stake-Pools-Research/main/stakepool-data/mainnet-beta/820/mainnet-beta-4.json';
    const MANIFEST_URL = 'https://raw.githubusercontent.com/SOFZP/Solana-Stake-Pools-Research/main/stakepool-data/mainnet-beta/manifest.json';
    // Phase 3: R2 live data endpoints. The manifest may carry live_data_url and
    // status_url fields; these constants are the fallback when it does not
    // (older manifest, or R2 publishing disabled on the backend).
    const LIVE_DATA_URL_DEFAULT = 'https://data.stakemap.info/v1/mainnet-beta/live.json';
    const STATUS_URL_DEFAULT = 'https://data.stakemap.info/v1/mainnet-beta/status.json';
    // The data API answers on two hosts with the same files. A link that
    // still names the earlier host (an older manifest) is read from the
    // current one.
    const DATA_API_HOST = 'https://data.stakemap.info/';
    const DATA_API_HOST_EARLIER = 'https://data.cryptovik.info/';
    function dataApiUrl(url) {
        return (typeof url === 'string' && url.indexOf(DATA_API_HOST_EARLIER) === 0)
            ? DATA_API_HOST + url.slice(DATA_API_HOST_EARLIER.length)
            : url;
    }
    // Aggressive timeout for the live endpoint only: if R2 hangs, we want to
    // fall back to GitHub quickly instead of waiting the full 30s budget.
    const LIVE_FETCH_TIMEOUT_MS = 8000;
    const MIN_ACTIVE_STAKE = 100_000_000;
    const VALIDATORS_PER_PAGE = 100;
    const KEY_VISIBILITY_THRESHOLD = 5;
    const DESC_LINES = 4;
    const FETCH_TIMEOUT_MS = 30000;
    
    // Wrap fetch with explicit timeout via AbortController. Some user environments
    // (antivirus SSL inspection, corporate firewalls, restrictive ad-blockers) can
    // leave fetch in a pending state indefinitely instead of returning an error,
    // which leaves the dashboard stuck on "Loading data... 0%". A timeout converts
    // those hangs into proper rejections so the error path can run and show users
    // a meaningful message.
    function fetchWithTimeout(url, options, timeoutMs) {
        options = options || {};
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs || FETCH_TIMEOUT_MS);
        return fetch(url, Object.assign({}, options, { signal: controller.signal }))
            .finally(() => clearTimeout(timeoutId));
    }

    // Data files on GitHub raw have a copy on the public data API under the
    // same relative path. When GitHub cannot be reached, the copy is used and
    // the rest of the session asks the copy first.
    const MANIFEST_TIMEOUT_MS = 10000;
    let preferDataMirror = false;
    function dataMirrorUrl(url) {
        const githubBase = MANIFEST_URL.replace(/[^/]*$/, '');
        const mirrorBase = LIVE_DATA_URL_DEFAULT.replace(/[^/]*$/, '');
        return (typeof url === 'string' && url.indexOf(githubBase) === 0)
            ? mirrorBase + url.slice(githubBase.length) : null;
    }
    async function fetchWithMirror(url, options, timeoutMs) {
        const mirror = dataMirrorUrl(url);
        if (!mirror) return fetchWithTimeout(url, options, timeoutMs);
        if (preferDataMirror) {
            try {
                const viaMirror = await fetchWithTimeout(mirror, options, timeoutMs);
                if (viaMirror.ok) return viaMirror;
            } catch (_) {
                /* the copy failed too: fall through to GitHub */
            }
            return fetchWithTimeout(url, options, timeoutMs);
        }
        try {
            const resp = await fetchWithTimeout(url, options, timeoutMs);
            if (resp.ok) return resp;
            throw new Error('status ' + resp.status);
        } catch (err) {
            console.warn('[stake-dashboard] GitHub raw unavailable (' + (err && err.message) + '), using the data API copy');
            preferDataMirror = true;
            return fetchWithTimeout(mirror, options, timeoutMs);
        }
    }

    // sessionStorage cache for the small, hot URLs of the data pipeline:
    // the manifest, the aggregated history, and the latest snapshot.
    // Cache TTL is 90 seconds, which is well below the typical interval at
    // which Block E pre-aggregation runs, so a cached read should always
    // reflect a recent cluster scan. On cache miss or stale, behaves like
    // a normal fetch + json() and writes the result into the cache on success.
    //
    // Why sessionStorage and not localStorage: per-tab is appropriate here,
    // we do not want a multi-day-old payload from a tab opened last week to
    // override a fresh load. Browser will also evict on tab close which is
    // exactly the lifetime we want.
    const CACHE_TTL_MS = 90 * 1000;
    const CACHE_PREFIX = 'cv:cache:';

    async function fetchJsonWithCache(url, label, timeoutMs) {
        const cacheKey = CACHE_PREFIX + url;
        // Try cache first.
        try {
            const raw = safeStorage.getItem(cacheKey, 'session');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && parsed.ts && (Date.now() - parsed.ts) < CACHE_TTL_MS) {
                    console.log('[stake-dashboard] cache hit for ' + (label || url));
                    return parsed.data;
                }
            }
        } catch (_) {
            /* corrupt cache entry, ignore and fall through to network */
        }
        // Cache miss or stale - fetch fresh.
        const resp = await fetchWithMirror(url, { cache: 'default' }, timeoutMs);
        if (!resp.ok) {
            // Surface real status to caller so it can decide on fallback.
            const err = new Error('Fetch failed with status ' + resp.status);
            err.status = resp.status;
            throw err;
        }
        const data = await resp.json();
        // Best-effort cache write. Failures (quota exceeded, storage blocked)
        // are swallowed by safeStorage, so this never breaks the data flow.
        try {
            safeStorage.setItem(
                cacheKey,
                JSON.stringify({ ts: Date.now(), data: data }),
                'session'
            );
        } catch (_) {
            /* payload too big for sessionStorage quota - skip caching */
        }
        return data;
    }
    
    // Safe storage wrapper. Edge with Tracking Prevention enabled and Firefox
    // with strict mode can throw SecurityError on storage access, which would
    // crash the entire init script if uncaught. This wrapper degrades gracefully:
    // reads return null, writes are silently dropped. Theme defaults to "light"
    // and other persisted prefs simply don't persist.
    const safeStorage = {
        getItem(key, type) {
            try {
                const store = type === 'session' ? sessionStorage : localStorage;
                return store.getItem(key);
            } catch (e) {
                console.warn('[stake-dashboard] storage blocked, using default for', key);
                return null;
            }
        },
        setItem(key, value, type) {
            try {
                const store = type === 'session' ? sessionStorage : localStorage;
                store.setItem(key, value);
            } catch (e) {
                if (e && (e.name === 'QuotaExceededError' || e.code === 22)) {
                    // Common case: latest snapshot JSON exceeds the ~5MB
                    // sessionStorage quota. Cache that key is skipped, the
                    // dashboard still works (will fetch fresh next time).
                    console.warn('[stake-dashboard] storage quota exceeded, skip cache for', key);
                }
                /* otherwise silently ignore - storage blocked by browser */
            }
        }
    };
    
    const OTHER_GROUP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>`;

    // ============================================
    // GLOBAL STATE
    // ============================================
    let latestPoolDefinitions = [];
    let nameRemap = new Map();
    let chartsToRedraw = [];
    // Pools open sorted by category (Viktor); ?sort= in the URL overrides.
    let currentSortMode = 'category';
    let categoryOrder = [];
    let allEpochData = [];
    let epochMap = new Map();
    let latestEpochNumber = null;
    
    // Змінні для валідаторів
    let validatorsData = [];
    // pool_definitions of the snapshot validatorsData came from. Needed to map
    // by_pool short names onto current group names for search, sort and badges.
    let validatorsPoolDefs = [];
    // script_info of the same snapshot (Jito metadata status for the MEV chip).
    let validatorsScriptInfo = null;
    let filteredValidators = [];
    let validatorsSortMode = 'active-stake';
    let searchQuery = '';
    let validatorsVisibleCount = VALIDATORS_PER_PAGE;
    let isPoolSearchMode = false;
	let poolSortOrder = [];
    
    // Змінні для детального виду пулу  
    let currentPoolGroup = null;
    let poolValidators = [];
    let poolDetailSortMode = 'pool-stake';
    let poolDetailSortOrder = 'desc'; // 'desc' = від більшого до меншого, 'asc' = навпаки
    let poolSearchQuery = '';
    let poolHistoryData = null;
    // script_info of the snapshot shown on the pool page (same use as above).
    let poolScriptInfo = null;
    
    // Epoch Dynamics - режим масштабу (unified = однаковий, separate = окремий)
    let epochDynamicsScaleMode = safeStorage.getItem('epochDynamicsScaleMode') || 'unified';
    
    // Кеш для зображень
    const imageCache = new Map();
    const brokenImages = new Set();

    // ============================================
    // HELPERS
    // ============================================
    const formatNumber = (num, digits = 0) => 
        new Intl.NumberFormat('en-US', { 
            minimumFractionDigits: digits, 
            maximumFractionDigits: digits 
        }).format(num);
    
    const lamportsToSol = (lamports) => lamports / 1_000_000_000;
    
    const cleanText = (text) => (text === '<fill>' || !text) ? '' : text;
    
    // Thresholds sit where rounding would print "1000.0K" or "1000":
    // 999,950 becomes "1.0M", 999.5 becomes "1.0K".
    const formatCompact = (num) => {
        if (num >= 999_950) return `${(num/1_000_000).toFixed(1)}M`;
        if (num >= 999.5) return `${(num/1_000).toFixed(1)}K`;
        return num.toFixed(0);
    };
    
    const shortenPubkey = (pubkey) => {
        if (!pubkey) return '';
        if (pubkey.length <= 12) return pubkey;
        return `${pubkey.slice(0, 5)}...${pubkey.slice(-4)}`;
    };
    
    const debounce = (func, timeout = 250) => {
        let timer;
        return (...args) => { 
            clearTimeout(timer); 
            timer = setTimeout(() => func.apply(this, args), timeout); 
        };
    };
    
    const toTitleCaseKey = (key) => {
        return (key || '').replace(/_/g,' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
    };
    
    // Перевірка валідності HTTP/HTTPS URL
    const isValidHttpUrl = (string) => {
        if (!string) return false;
        let url;
        try {
            url = new URL(string);
        } catch (_) {
            return false;
        }
        return url.protocol === "http:" || url.protocol === "https:";
    };

    // ============================================
    // SAFE HTML, STAKE THRESHOLD, VALIDATOR META (v2.3.0)
    // ============================================
    // Strings from the chain (validator name, icon URL, details, website) and
    // from the page URL (search query) are untrusted: anyone can publish
    // validator info and anyone can craft a link. Everything of that kind is
    // escaped before it reaches innerHTML or an attribute.
    const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    const escapeHtml = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);

    // One rule for "this stake counts", shared by pool cards, the network
    // summary, validator pool badges, search and pool pages: active OR
    // activating stake reaches MIN_ACTIVE_STAKE. The aggregator applies the
    // same rule to pool_stats.validator_count, so live and history agree.
    const meetsStakeThreshold = (active, activating) =>
        (active || 0) >= MIN_ACTIVE_STAKE || (activating || 0) >= MIN_ACTIVE_STAKE;

    // A published name counts as a name unless it is just a pubkey.
    const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    const hasRealName = (name) => {
        const n = typeof name === 'string' ? name.trim() : '';
        return !!(n && !PUBKEY_RE.test(n));
    };

    // Basis points -> percent label: 500 -> "5%", 450 -> "4.5%", 425 -> "4.25%".
    function formatBpsPercent(bps) {
        if (typeof bps !== 'number' || !isFinite(bps)) return null;
        const pct = bps / 100;
        const text = Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
        return text + '%';
    }

    // Inflation commission in bps: commission_bps (checker 6.1+) first, then the
    // percent field, which may be fractional.
    function metaCommissionBps(meta) {
        if (!meta) return null;
        if (typeof meta.commission_bps === 'number') return meta.commission_bps;
        if (typeof meta.commission === 'number') return Math.round(meta.commission * 100);
        return null;
    }

    // MEV commission in bps plus the reason when it is missing. meta.jito is
    // null when the validator is not in Jito's list or when the Jito API failed
    // with no cache; script_info.jito_metadata.status tells the two apart.
    // A Jito validator without a value has produced no blocks yet this epoch.
    function metaMevInfo(meta, scriptInfo) {
        const jm = scriptInfo && scriptInfo.jito_metadata ? scriptInfo.jito_metadata : null;
        const status = jm ? jm.status : null;
        const jito = meta ? meta.jito : null;
        let bps = null;
        let note = '';
        if (!jito) {
            if (status === 'unavailable') note = 'Jito data unavailable right now';
            else if (status === 'ok' || status === 'cached') note = 'not running Jito';
            else note = 'not running Jito or no Jito data';
        } else if (typeof jito.mev_commission_bps === 'number') {
            bps = jito.mev_commission_bps;
        } else {
            note = 'not reported yet, no blocks produced this epoch';
        }
        let cachedNote = '';
        if (status === 'cached' && jm && typeof jm.cache_age_seconds === 'number') {
            cachedNote = 'Jito data as of ' + Math.max(1, Math.round(jm.cache_age_seconds / 60)) + ' min ago';
        }
        return { bps, note, cachedNote };
    }

    // Client version string from the CLI; "unknown" = not reported at scan time.
    function metaVersion(meta) {
        const v = meta && typeof meta.version === 'string' ? meta.version.trim() : '';
        return v && v.toLowerCase() !== 'unknown' ? v : null;
    }

    // ============================================
    // CLIENT LOGOS (official marks, served from /dashboard-assets/clients/)
    // ============================================
    // Marks sit directly in the chip, no plates. Monochrome marks flip with
    // the theme (invert: 'dark' = inverted on the dark theme, 'light' = on the
    // light theme); colour marks stay as they are. Hybrids and BAM builds show
    // two marks side by side (base + component).
    const CLIENT_ASSET_BASE = '/dashboard-assets/clients/';
    const CLIENT_LOGOS = {
        jito:       { src: 'jito.svg',       shape: 'word', invert: 'light' },
        bam:        { src: 'bam.svg',        invert: 'dark' },
        firedancer: { src: 'firedancer.svg' },
        agave:      { src: 'anza.png',       invert: 'light' },
        harmonic:   { src: 'harmonic.svg',   shape: 'wide', invert: 'dark' },
        rakurai:    { src: 'rakurai.png' },
        raiku:      { src: 'raiku.png',      invert: 'light' },
        syndica:    { src: 'syndica.png' },
        paladin:    { src: 'paladin.png',    invert: 'dark' },
        overclock:  { src: 'overclock.png' }
    };
    // CLI clientId, normalized (lower case, letters and digits) -> display.
    // AgaveBam is shown as "Jito BAM": validators install Jito and connect it
    // to BAM; when the connection drops the CLI reports JitoLabs again.
    const CLIENTS = {
        agave:              { name: 'Agave', logos: ['agave'] },
        agavebam:           { name: 'Jito BAM', logos: ['jito', 'bam'], note: 'Jito client connected to BAM' },
        jitobam:            { name: 'Jito BAM', logos: ['jito', 'bam'], note: 'Jito client connected to BAM' },
        jitolabs:           { name: 'Jito', logos: ['jito'] },
        jito:               { name: 'Jito', logos: ['jito'] },
        harmonicagave:      { name: 'Harmonic Agave', logos: ['harmonic', 'agave'], note: 'Harmonic build on Agave' },
        harmonicfiredancer: { name: 'Harmonic Firedancer', logos: ['harmonic', 'firedancer'], note: 'Harmonic build on Firedancer' },
        firedancer:         { name: 'Firedancer', logos: ['firedancer'] },
        firebam:            { name: 'Firedancer BAM', logos: ['firedancer', 'bam'], note: 'Firedancer connected to BAM' },
        frankendancer:      { name: 'Frankendancer', logos: ['firedancer', 'agave'], note: 'Firedancer + Agave hybrid' },
        rakurai:            { name: 'Rakurai', logos: ['rakurai'] },
        raiku:              { name: 'Raiku', logos: ['raiku'] },
        sig:                { name: 'Sig', logos: ['syndica'], note: 'Sig client by Syndica' },
        paladin:            { name: 'Paladin', logos: ['paladin'] },
        agavepaladin:       { name: 'Paladin', logos: ['paladin'] },
        mithril:            { name: 'Mithril', logos: ['overclock'], note: 'Mithril client by Overclock' }
    };

    // meta.client -> { name, logos, note, kind } or null when the snapshot has
    // no client field. "Unknown" and "Unknown(NNNN)" are one unknown client (the
    // number differs between RPC nodes and is never shown); any other new
    // string is shown as it is, with a generic mark, until it gets a logo.
    function resolveClient(raw) {
        if (typeof raw !== 'string' || !raw.trim()) return null;
        const s = raw.trim();
        if (/^unknown/i.test(s)) return { name: 'Unknown client', logos: [], kind: 'unknown', note: 'The CLI does not recognize this client' };
        const c = CLIENTS[s.toLowerCase().replace(/[^a-z0-9]/g, '')];
        if (c) return { name: c.name, logos: c.logos, note: c.note || '', kind: 'known' };
        return { name: s, logos: [], kind: 'new', note: 'No logo yet' };
    }

    function clientMarksHtml(client) {
        if (client.kind !== 'known') {
            const icon = client.kind === 'unknown' ? 'fa-question' : 'fa-cube';
            return '<span class="cv-client-logos"><span class="cv-client-mark is-generic"><i class="fas ' + icon +
                '" aria-hidden="true"></i></span></span>';
        }
        return '<span class="cv-client-logos">' + client.logos.map(k => {
            const l = CLIENT_LOGOS[k];
            if (!l) return '';
            const cls = 'cv-client-mark' + (l.shape ? ' is-' + l.shape : '') + (l.invert ? ' inv-' + l.invert : '');
            return '<span class="' + cls + '"><img src="' + CLIENT_ASSET_BASE + l.src + '?v=' + DASHBOARD_VERSION +
                '" alt="" loading="lazy" decoding="async"></span>';
        }).join('') + '</span>';
    }

    // ============================================
    // SEARCH HELPERS (validators list and pool page table share them)
    // ============================================
    // Names and keys are Latin, so Cyrillic in a query means the keyboard
    // layout was not switched: each Ukrainian or Russian key maps back to the
    // Latin character on the same key.
    const LAYOUT_CYR = '\u0439\u0446\u0443\u043a\u0435\u043d\u0433\u0448\u0449\u0437\u0445\u0457\u044a' +
        '\u0444\u0456\u044b\u0432\u0430\u043f\u0440\u043e\u043b\u0434\u0436\u0454\u044d' +
        '\u044f\u0447\u0441\u043c\u0438\u0442\u044c\u0431\u044e\u0451\u0491';
    const LAYOUT_LAT = "qwertyuiop[]]assdfghjkl;''zxcvbnm,.``";
    function fixKeyboardLayout(text) {
        if (!/[\u0400-\u04ff]/.test(text)) return text;
        let out = '';
        for (const ch of text) {
            const lower = ch.toLowerCase();
            const i = LAYOUT_CYR.indexOf(lower);
            if (i < 0) { out += ch; continue; }
            out += ch === lower ? LAYOUT_LAT[i] : LAYOUT_LAT[i].toUpperCase();
        }
        return out;
    }

    function splitSearchTerms(query) {
        return fixKeyboardLayout(query || '').toLowerCase().split('+').map(t => t.trim()).filter(t => t.length > 0);
    }

    // Text a validator is matched against: base = name and keys; full adds the
    // client (display name and CLI id), the version and the word "delinquent".
    function validatorSearchText(v) {
        const info = v.info || {};
        const meta = v.meta || {};
        // Former names (validators index, once it has loaded) match as well.
        const former = cvNamesFor(info.vote_pubkey);
        const base = [info.name || '', info.identity_pubkey || '', info.vote_pubkey || ''].concat(former).join(' ').toLowerCase();
        const extra = [];
        const client = resolveClient(meta.client);
        if (client) extra.push(client.name);
        if (typeof meta.client === 'string') extra.push(meta.client);
        if (typeof meta.version === 'string') extra.push(meta.version);
        if (meta.delinquent === true) extra.push('delinquent');
        return { base, full: (base + ' ' + extra.join(' ')).toLowerCase() };
    }

    // One-letter labels of the commission chip: C = commission (inflation
    // rewards), M = MEV commission; B = block revenue commission joins when
    // validators start setting it. Change the letters here only.
    const COMMISSION_LABELS = { inflation: 'C', mev: 'M', block: 'B' };

    // Compact meta line under the validator keys: [delinquent] [I | M] [client].
    // Missing values show "-" with the reason in the tooltip, never "null".
    // Snapshots without metadata (before epoch 1042) show no line at all.
    // The client chip takes the client tile once the pipeline publishes the
    // client name; until then it shows the version alone.
    function buildMetaChipsHtml(meta, scriptInfo) {
        if (!meta) return '';
        const chips = [];
        const delinquent = meta.delinquent === true;
        if (delinquent) {
            chips.push('<span class="cv-chip cv-chip-delinquent" data-cv-tip="Delinquent: not voting at the time of this snapshot">' +
                '<span class="cv-seg"><i class="fas fa-plug-circle-xmark" aria-hidden="true"></i>Delinquent</span></span>');
        }

        const L = COMMISSION_LABELS;
        const cText = formatBpsPercent(metaCommissionBps(meta));
        const mev = metaMevInfo(meta, scriptInfo);
        const mText = formatBpsPercent(mev.bps);
        const tip = [L.inflation + ' - Commission: ' + (cText || 'not reported'),
                     L.mev + ' - MEV commission: ' + (mText || mev.note)];
        if (mev.cachedNote) tip.push(mev.cachedNote);
        const seg = (label, text) => '<span class="cv-seg' + (text ? '' : ' is-missing') + '">' +
            '<span class="cv-seg-label">' + label + '</span>' + escapeHtml(text || '-') + '</span>';
        chips.push('<span class="cv-chip cv-chip-fees" data-cv-tip="' + escapeHtml(tip.join('\n')) + '">' +
            seg(L.inflation, cText) + seg(L.mev, mText) + '</span>');

        const ver = metaVersion(meta);
        const client = resolveClient(meta.client);
        const namedClient = client && client.kind !== 'unknown';
        if (ver || namedClient || !delinquent) {
            const tip = [client ? client.name + (ver ? ' ' + ver : '') : (ver ? 'Client version ' + ver : 'Client version not reported')];
            if (client && client.note) tip.push(client.note);
            chips.push('<span class="cv-chip cv-chip-client' + (ver || client ? '' : ' is-missing') + '" data-cv-tip="' +
                escapeHtml(tip.join('\n')) + '"><span class="cv-seg">' + (client ? clientMarksHtml(client) : '') +
                (ver || !client ? '<span class="cv-client-ver">' + escapeHtml(ver || '-') + '</span>' : '') + '</span></span>');
        }
        return '<div class="cv-meta">' + chips.join('') + '</div>';
    }

    // Copy controls. Keys show the short form and copy the full key; names get
    // an icon button. Clicks are handled in one capture listener further down.
    const COPY_ICONS = '<i class="fas fa-copy cv-copy-icon" aria-hidden="true"></i>' +
        '<i class="fas fa-check cv-copied-icon" aria-hidden="true"></i>';

    function copyButtonHtml(text, label) {
        const l = escapeHtml(label);
        return '<button type="button" class="cv-copy-btn" data-cv-copy="' + escapeHtml(text) + '" title="' + l +
            '" aria-label="' + l + '">' + COPY_ICONS + '</button>';
    }

    function keyTokenHtml(label, key) {
        const k = escapeHtml(key);
        return '<button type="button" class="cv-key" data-cv-copy="' + k + '" title="' + k + '" aria-label="Copy ' +
            escapeHtml(label) + ' key"><span class="cv-key-label">' + escapeHtml(label) + '</span>' +
            '<span class="cv-key-val">' + escapeHtml(shortenPubkey(key)) + '</span>' + COPY_ICONS + '</button>';
    }

    // ============================================
    // BLOCK B: LOGO THEME-VARIANT SYSTEM
    // ============================================
    // Looks for {basename}_light.{ext} on light theme and {basename}_dark.{ext}
    // on dark theme, falls back to the default URL when a variant is missing.
    // Only checks the same extension as the default logo (1 HEAD per pool).
    // Results cached in sessionStorage, so a theme switch re-running the scan
    // stays instant after the first pass.
    
    const LOGO_VARIANT_CACHE_KEY = 'logoVariantCache:v1';
    
    // In-memory mirror of sessionStorage for synchronous access during rendering
    let logoVariantCache = (() => {
        try {
            const raw = sessionStorage.getItem(LOGO_VARIANT_CACHE_KEY);
            return raw ? JSON.parse(raw) : {};
        } catch (_) {
            return {};
        }
    })();
    
    function persistLogoVariantCache() {
        try {
            // Persist ONLY positive results (variants confirmed to exist).
            // Negative results stay in memory for the rest of this session
            // (avoids re-probing the same URL on every theme change), but on
            // reload or next tab open we retry from scratch. This is critical
            // because a transient probe failure (CDN rate limit, slow connection,
            // GitHub raw 429) would otherwise be cached forever as "_light does
            // not exist" - making the dashboard show the wrong default logo
            // even after the underlying issue is fixed.
            const positives = {};
            for (const key in logoVariantCache) {
                if (logoVariantCache[key] === true) {
                    positives[key] = true;
                }
            }
            sessionStorage.setItem(LOGO_VARIANT_CACHE_KEY, JSON.stringify(positives));
        } catch (_) {
            // Quota exceeded or storage unavailable - keep in-memory only
        }
    }
    
    // Split URL into base and extension. Returns null if not a valid image URL.
    function splitLogoUrl(url) {
        if (!isValidHttpUrl(url)) return null;
        const match = url.match(/^(.+)\.([a-zA-Z0-9]+)(\?.*)?$/);
        if (!match) return null;
        return { base: match[1], ext: match[2], query: match[3] || '' };
    }
    
    // Build variant URL: replace "xxx.png" with "xxx_light.png" (or _dark)
    function buildVariantUrl(defaultUrl, suffix) {
        const parts = splitLogoUrl(defaultUrl);
        if (!parts) return null;
        return `${parts.base}_${suffix}.${parts.ext}${parts.query}`;
    }
    
    // Probe a URL by attempting to load it as an image. Works without CORS
    // (images are no-cors by default for cross-origin reads) and results are
    // cached by the browser's image cache, so a found variant can be swapped
    // into <img src> instantly without a second network trip.
    //
    // Timeout (5s) protects against a single hung load blocking the entire
    // Promise.all in scanLogoVariants. On timeout we resolve as "not found"
    // for this session - persistLogoVariantCache will not save the negative,
    // so next page load retries.
    function checkImageExists(url) {
        if (!url) return Promise.resolve(false);
        if (Object.prototype.hasOwnProperty.call(logoVariantCache, url)) {
            return Promise.resolve(logoVariantCache[url]);
        }
        return new Promise(resolve => {
            const img = new Image();
            let settled = false;
            const done = (exists) => {
                if (settled) return;
                settled = true;
                logoVariantCache[url] = exists;
                resolve(exists);
            };
            const timer = setTimeout(() => done(false), 5000);
            img.onload = () => { clearTimeout(timer); done(true); };
            img.onerror = () => { clearTimeout(timer); done(false); };
            img.src = url;
        });
    }
    
    // Synchronous resolver: returns the variant URL if we already know it exists,
    // otherwise returns the default URL. Used during rendering where we cannot await.
    function resolveLogoUrlSync(defaultUrl, isDark, isoSize) {
        if (!isValidHttpUrl(defaultUrl)) return defaultUrl;
        // A place that has room for the isometric sprite passes its size.
        if (isoSize) {
            const iso = isoLogoUrl(defaultUrl, isDark, isoSize);
            if (iso) return iso;
        }
        const suffix = isDark ? 'dark' : 'light';
        const variantUrl = buildVariantUrl(defaultUrl, suffix);
        if (!variantUrl) return defaultUrl;
        if (logoVariantCache[variantUrl] === true) return variantUrl;
        return defaultUrl;
    }
    
    // Scan all pool definitions for theme-variant existence. Runs in parallel.
    // After the scan completes, calls onUpdate so renderers can swap img.src.
    function scanLogoVariants(isDark, onUpdate) {
        if (!Array.isArray(latestPoolDefinitions) || latestPoolDefinitions.length === 0) return;
        const suffix = isDark ? 'dark' : 'light';
        
        // Clear negative cache entries before scan so URLs that failed earlier
        // in this session get re-probed. Positive entries stay - a variant
        // that exists at start of session does not disappear mid-session.
        // This pairs with persistLogoVariantCache only saving positives:
        // negatives never persist beyond a tab close, and never persist past
        // a theme switch within a single tab.
        for (const key in logoVariantCache) {
            if (logoVariantCache[key] === false) {
                delete logoVariantCache[key];
            }
        }
        
        // Deduplicate variant URLs across all pool defs
        const variantUrls = new Set();
        latestPoolDefinitions.forEach(def => {
            const url = buildVariantUrl(def.image, suffix);
            if (url && !(url in logoVariantCache)) {
                variantUrls.add(url);
            }
        });
        
        if (variantUrls.size === 0) {
            // Everything cached already - just refresh DOM
            if (typeof onUpdate === 'function') onUpdate();
            return;
        }
        
        Promise.all(Array.from(variantUrls).map(u => checkImageExists(u)))
            .then(() => {
                persistLogoVariantCache();
                if (typeof onUpdate === 'function') onUpdate();
            });
    }
    
    // Swap src on every rendered pool logo img based on current theme cache.
    // Each logo img must carry data-logo-default with the original URL so we
    // know what to resolve from on subsequent theme switches.
    function refreshAllPoolLogos(isDark) {
        document.querySelectorAll('img[data-logo-default]').forEach(img => {
            const defaultUrl = img.dataset.logoDefault;
            const resolved = resolveLogoUrlSync(defaultUrl, isDark, img.dataset.logoIso);
            // Compare with the attribute: img.src is always absolute, a
            // sprite path is not.
            if (img.getAttribute('src') !== resolved && img.src !== resolved) img.src = resolved;
        });
        document.querySelectorAll('img[data-logo-stem]').forEach(img => {
            const url = isoStemUrl(img.dataset.logoStem, isDark, img.dataset.logoIso);
            if (url && img.getAttribute('src') !== url) img.src = url;
        });
    }

    // ============================================
    // ISOMETRIC POOL SPRITES
    // ============================================
    // The wrapper page lists the sprites it ships in window.CV_ISO_LOGOS
    // ({ base, v, stems }). A sprite is keyed by the stem of the registry
    // image file: imgs/jpool.svg -> jpool.webp. Theme variants follow the
    // flat logos: <stem>_light on the light theme, <stem>_dark on the dark
    // one. Sprites are drawn only where a logo has room (about 36 px and
    // up): the 3D detail is unreadable below that, and there the flat logo
    // stays. A pool without a sprite, or a sprite that fails to load, shows
    // the flat logo with its plate.
    const ISO_LOGOS = (() => {
        const cfg = window.CV_ISO_LOGOS;
        if (!cfg || !cfg.base || !Array.isArray(cfg.stems) || cfg.stems.length === 0) return null;
        return { base: String(cfg.base), v: String(cfg.v || ''), stems: new Set(cfg.stems) };
    })();
    const isoLogoFailed = new Set();

    function isoStemUrl(stem, isDark, size) {
        if (!ISO_LOGOS || !size || !stem) return null;
        const variant = stem + (isDark ? '_dark' : '_light');
        const pick = ISO_LOGOS.stems.has(variant) ? variant : (ISO_LOGOS.stems.has(stem) ? stem : null);
        if (!pick) return null;
        const path = ISO_LOGOS.base + (Number(size) > 96 ? '256' : '96') + '/' + encodeURIComponent(pick) + '.webp';
        if (isoLogoFailed.has(path)) return null;
        return path + (ISO_LOGOS.v ? '?v=' + ISO_LOGOS.v : '');
    }
    function isoLogoUrl(defaultUrl, isDark, size) {
        if (!ISO_LOGOS || !size) return null;
        const parts = splitLogoUrl(defaultUrl);
        if (!parts) return null;
        let stem = parts.base.substring(parts.base.lastIndexOf('/') + 1);
        try { stem = decodeURIComponent(stem); } catch (_) { /* keep the raw stem */ }
        return isoStemUrl(stem, isDark, size);
    }
    // "Other Stakes" has no image in the registry; its sprite is the one
    // named "other". The image goes in front of the group glyph, which stays
    // in the markup as the fallback.
    function otherIsoImg(size) {
        const url = isoStemUrl('other', document.body.classList.contains('dark-theme-body'), size);
        return url ? '<img src="' + url + '" data-logo-stem="other" data-logo-iso="' + Number(size) + '" alt="">' : '';
    }

    // A sprite that fails to load gives its place back to the flat logo.
    document.addEventListener('error', (e) => {
        const img = e.target;
        if (!ISO_LOGOS || !img || img.tagName !== 'IMG' || !img.dataset || !img.dataset.logoIso) return;
        const src = img.getAttribute('src') || '';
        if (src.indexOf(ISO_LOGOS.base) !== 0) return;
        isoLogoFailed.add(src.split('?')[0]);
        // The sprite of a group without an image: the glyph behind it shows.
        if (img.dataset.logoStem) { img.remove(); return; }
        img.dataset.isoFallback = '1';
        if (img.dataset.logoDefault) {
            img.setAttribute('src', resolveLogoUrlSync(img.dataset.logoDefault,
                document.body.classList.contains('dark-theme-body'), img.dataset.logoIso));
        }
    }, true);

    // ============================================
    // IMAGE / LOGO HELPERS
    // ============================================
    function getInitials(name, fallbackKey = '') {
        if (name && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(name)) {
            const words = name.split(' ').filter(Boolean);
            if (words.length > 1) {
                return (words[0][0] + words[1][0]).toUpperCase();
            }
            return name.substring(0, 2).toUpperCase();
        }
        const key = name || fallbackKey;
        return key ? key.substring(0, 2).toUpperCase() : '??';
    }
    
    // Створення fallback елемента для зображення
    function createFallbackImage(validatorName, fallbackKey) {
        return `<div class="validator-image fallback">${escapeHtml(getInitials(validatorName, fallbackKey))}</div>`;
    }
    
    // Глобальна функція обробки зображень валідаторів
    window.handleValidatorImage = function(img, validatorName, fallbackKey) {
        if (!img || typeof img !== 'object') return;
        
        const imageUrl = img.src;
        const wrapper = img.parentNode;
        
        // Якщо зображення вже в кеші як бите, одразу заміняємось
        if (brokenImages.has(imageUrl)) {
            if (wrapper) {
                wrapper.innerHTML = createFallbackImage(validatorName, fallbackKey);
            }
            return;
        }
        
        // Якщо є результат в кеші
        if (imageCache.has(imageUrl)) {
            if (!imageCache.get(imageUrl) && wrapper) {
                wrapper.innerHTML = createFallbackImage(validatorName, fallbackKey);
            }
            return;
        }
        
        // Перевіряємо зображення
        const testImg = new Image();
        
        testImg.onload = () => {
            imageCache.set(imageUrl, true);
        };
        
        testImg.onerror = () => {
            imageCache.set(imageUrl, false);
            brokenImages.add(imageUrl);
            if (wrapper) {
                wrapper.innerHTML = createFallbackImage(validatorName, fallbackKey);
            }
        };
        
        testImg.src = imageUrl;
    };

    // Avatar load errors are handled here instead of inline onerror attributes,
    // so validator names never travel through inline JavaScript.
    document.addEventListener('error', (e) => {
        const img = e.target;
        if (!img || img.tagName !== 'IMG' || !img.classList.contains('validator-image')) return;
        if (img.dataset.fbKey === undefined) return;
        window.handleValidatorImage(img, img.dataset.fbName || '', img.dataset.fbKey || '');
    }, true);

    // ============================================
    // VALIDATOR HELPERS
    // ============================================
	function filterValidators() {
		const searchTerms = splitSearchTerms(searchQuery);
		if (searchTerms.length === 0) {
			filteredValidators = [...validatorsData];
			return;
		}
		const poolKeys = latestPoolDefinitions.map(def => (def.group || '').toLowerCase()).filter(Boolean);
		const isPoolTerm = term => term.length >= 3 && poolKeys.some(key => key.startsWith(term));

		// Every term names a pool ("pool1+pool2"): keep validators present in
		// all of them (or whose name or key holds the term), as before.
		if (searchTerms.every(isPoolTerm)) {
			filteredValidators = validatorsData.filter(v => {
				const text = validatorSearchText(v);
				const groups = getResolvedGroups(v, validatorsPoolDefs);
				return searchTerms.every(term => text.base.includes(term) || groups.some(pool =>
					pool.name.toLowerCase().startsWith(term) &&
					meetsStakeThreshold(pool.active_lamports, pool.activating_lamports)));
			});
			return;
		}
		// Otherwise every term is a lookup and "+" joins them: any match is
		// enough, so "name1+name2+key3" works as a watchlist. Lookups cover the
		// name, keys, client, version and the word "delinquent".
		filteredValidators = validatorsData.filter(v => {
			const text = validatorSearchText(v).full;
			return searchTerms.some(term => text.includes(term));
		});
	}
    
	function sortValidators() {
		// Helper function to get stake for a specific pool
		const getStakeForPool = (validator, poolName) => {
			const pool = getResolvedGroups(validator, validatorsPoolDefs)
				.find(p => p.name === poolName);
			return pool ? (pool.active_lamports + pool.activating_lamports) : 0;
		};
	
		switch (validatorsSortMode) {
			case 'active-stake':
				filteredValidators.sort((a, b) => 
					(b.totals?.total_active_lamports || 0) - (a.totals?.total_active_lamports || 0));
				break;
			case 'activating':
				filteredValidators.sort((a, b) => 
					(b.totals?.total_activating_lamports || 0) - (a.totals?.total_activating_lamports || 0) ||
					(b.totals?.total_active_lamports || 0) - (a.totals?.total_active_lamports || 0));
				break;
			case 'deactivating':
				filteredValidators.sort((a, b) => 
					(b.totals?.total_deactivating_lamports || 0) - (a.totals?.total_deactivating_lamports || 0) ||
					(b.totals?.total_active_lamports || 0) - (a.totals?.total_active_lamports || 0));
				break;
			// ⭐ НОВИЙ РЕЖИМ СОРТУВАННЯ
			case 'age':
				// Oldest vote accounts first; a second click on the button flips the order.
				filteredValidators.sort((a, b) => {
					const x = cvListAge(a);
					const y = cvListAge(b);
					const d = (y ? y.value : -1) - (x ? x.value : -1);
					return (validatorsAgeAsc ? -d : d) || ((b.totals?.total_active_lamports || 0) - (a.totals?.total_active_lamports || 0));
				});
				break;
			case 'pool-specific':
				if (poolSortOrder.length > 0) {
					filteredValidators.sort((a, b) => {
						for (const poolName of poolSortOrder) {
							const stakeA = getStakeForPool(a, poolName);
							const stakeB = getStakeForPool(b, poolName);
							if (stakeA !== stakeB) {
								return stakeB - stakeA;
							}
						}
						// Fallback to total active stake if all pool stakes are equal
						return (b.totals?.total_active_lamports || 0) - (a.totals?.total_active_lamports || 0);
					});
				}
				break;
		}
	}
    
    function updateValidatorStats(isStale = false, epochNum = null) {
        const container = document.getElementById('validators-stats-summary');
        if (!container) return;
        
        const totalCount = validatorsData.length;
        const visibleCount = filteredValidators.length;
        const epochNote = isStale ? `<span class="epoch-inline-note">in epoch ${epochNum}</span>` : '';

        const totalActiveStake = filteredValidators.reduce((sum, v) => 
            sum + (v?.totals?.total_active_lamports || 0), 0);
        const totalActivatingStake = filteredValidators.reduce((sum, v) => 
            sum + (v?.totals?.total_activating_lamports || 0), 0);
        const totalDeactivatingStake = filteredValidators.reduce((sum, v) => 
            sum + (v?.totals?.total_deactivating_lamports || 0), 0);

        container.innerHTML = `
            <div class="validators-stat-card">
                <i class="fas fa-users"></i>
                <div class="stat-info">
                    <div class="stat-value">${visibleCount}</div>
                    <div class="stat-label">Validators shown${searchQuery ? ` (of ${totalCount})` : ''}${epochNote}</div>
                </div>
            </div>
            <div class="validators-stat-card">
                <i class="fas fa-chart-pie"></i>
                <div class="stat-info">
                    <div class="stat-value">${formatNumber(lamportsToSol(totalActiveStake), 1)}</div>
                    <div class="stat-label">Total Active SOL${epochNote}</div>
                </div>
            </div>
            <div class="validators-stat-card">
                <i class="fas fa-arrow-trend-up" style="color: #28a745;"></i>
                <div class="stat-info">
                    <div class="stat-value">${formatNumber(lamportsToSol(totalActivatingStake), 1)}</div>
                    <div class="stat-label">Total Activating SOL${epochNote}</div>
                </div>
            </div>
            <div class="validators-stat-card">
                <i class="fas fa-arrow-trend-down" style="color: #dc3545;"></i>
                <div class="stat-info">
                    <div class="stat-value">${formatNumber(lamportsToSol(totalDeactivatingStake), 1)}</div>
                    <div class="stat-label">Total Deactivating SOL${epochNote}</div>
                </div>
            </div>
        `;
    }

    // ============================================
    // POOL TOOLTIP HELPERS
    // ============================================
	window.showPoolTooltip = function(element) {
		// Видаляємо старий тултіп, якщо він є
		const existingTooltip = document.getElementById('dynamic-pool-tooltip');
		if (existingTooltip) {
			existingTooltip.remove();
		}
	
		// Створюємо новий тултіп
		const tooltip = document.createElement('div');
		tooltip.id = 'dynamic-pool-tooltip';
		tooltip.className = 'pool-tooltip';
		tooltip.innerHTML = element.querySelector('.pool-tooltip-content').innerHTML;
		document.body.appendChild(tooltip);
	
		// Позиціонування
		const rect = element.getBoundingClientRect();
		const tooltipRect = tooltip.getBoundingClientRect();
		const PADDING = 10;
	
		let top = rect.top - tooltipRect.height - 12;
		let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
	
		if (left < PADDING) left = PADDING;
		if (left + tooltipRect.width > window.innerWidth - PADDING) {
			left = window.innerWidth - tooltipRect.width - PADDING;
		}
		if (top < PADDING) top = rect.bottom + 12;
	
		tooltip.style.top = `${top}px`;
		tooltip.style.left = `${left}px`;
		tooltip.classList.add('visible');
	};
	
	window.hidePoolTooltip = function() {
		const tooltip = document.getElementById('dynamic-pool-tooltip');
		if (tooltip) {
			tooltip.classList.remove('visible');
			// Даємо час на анімацію зникнення перед видаленням
			setTimeout(() => {
				tooltip.remove();
			}, 200);
		}
	};

    // Tooltips for elements with data-cv-tip (lines separated by newlines).
    // Same glass look and element id as the pool badge tooltips, so the
    // existing scroll handler hides both kinds.
    let cvTipTarget = null;
    function showCvTip(el) {
        const text = el.getAttribute('data-cv-tip');
        if (!text) return;
        const old = document.getElementById('dynamic-pool-tooltip');
        if (old) old.remove();
        const tip = document.createElement('div');
        tip.id = 'dynamic-pool-tooltip';
        tip.className = 'pool-tooltip cv-tip';
        text.split('\n').forEach((line, i) => {
            const row = document.createElement('div');
            row.className = i === 0 ? 'cv-tip-line cv-tip-first' : 'cv-tip-line';
            row.textContent = line;
            tip.appendChild(row);
        });
        document.body.appendChild(tip);
        const rect = el.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        const PAD = 10;
        let top = rect.top - tr.height - 10;
        let left = rect.left + rect.width / 2 - tr.width / 2;
        if (left < PAD) left = PAD;
        if (left + tr.width > window.innerWidth - PAD) left = window.innerWidth - tr.width - PAD;
        if (top < PAD) top = rect.bottom + 10;
        tip.style.top = top + 'px';
        tip.style.left = left + 'px';
        tip.classList.add('visible');
    }
    // ============================================
    // STICKY SUB-HEADER (every dashboard view)
    // ============================================
    // Always-visible bar right under the site header: what is on screen
    // (Pools, Validators, Docs, or a pool with its logo) and epoch steps
    // (older, newer, latest) wherever an epoch applies. It lives in the page
    // flow after the header (sticky, like the staleness banner), so it never
    // covers content; only its up button scrolls the page.
    let subheaderEl = null;
    let subheaderEpochSelect = null;
    let subheaderImgObserver = null;
    const SUBHEADER_TABS = {
        pools: { title: 'Pools', icon: 'fa-layer-group', kit: ['nav-pools'], epochSelectId: 'epoch-select' },
        validators: { title: 'Validators', icon: 'fa-users', kit: ['building-day', 'building-night'], epochSelectId: 'epoch-select' },
        docs: { title: 'Docs', icon: 'fa-book', kit: ['nav-docs'], epochSelectId: null }
    };
    // The pieces of the map kit that stand for the tabs (the same ones as on
    // the navigation bar). A piece with two files has a day and a night look.
    const KIT_BASE = '/brand/decor/';
    function kitLogoHtml(files) {
        const img = (name, cls) => '<img src="' + KIT_BASE + name + '.webp"' + (cls ? ' class="' + cls + '"' : '') + ' alt="">';
        return '<span class="cv-flow-logo is-kit">' +
            (files.length > 1 ? img(files[0], 'cv-only-light') + img(files[1], 'cv-only-dark') : img(files[0], '')) + '</span>';
    }

    // Sticky offset: under the site header, and under the staleness banner
    // while it is shown (the banner sits between the header and the bar).
    function subheaderPlace() {
        if (!subheaderEl) return;
        const header = document.querySelector('header');
        let top = header ? Math.max(0, Math.round(header.getBoundingClientRect().bottom)) : 0;
        const banner = document.getElementById('cv-staleness-banner');
        if (banner && banner.style.display !== 'none') top += Math.round(banner.getBoundingClientRect().height);
        subheaderEl.style.top = top + 'px';
        // Side margins follow the site header: its logo on the left, its buttons on the right.
        const headerInner = header ? (header.querySelector('.header-inner') || header.firstElementChild) : null;
        const barInner = subheaderEl.querySelector('.cv-subheader-inner');
        if (headerInner && barInner) {
            const hr = headerInner.getBoundingClientRect();
            const hs = getComputedStyle(headerInner);
            const br = subheaderEl.getBoundingClientRect();
            if (hr.width > 0 && br.width > 0) {
                barInner.style.maxWidth = 'none';
                barInner.style.paddingLeft = Math.max(8, Math.round(hr.left + (parseFloat(hs.paddingLeft) || 0) - br.left)) + 'px';
                barInner.style.paddingRight = Math.max(8, Math.round(br.right - hr.right + (parseFloat(hs.paddingRight) || 0))) + 'px';
            }
        }
    }

    function subheaderSyncEpoch() {
        if (!subheaderEl) return;
        const box = subheaderEl.querySelector('.cv-subheader-epochs');
        const sel = subheaderEpochSelect;
        if (!sel || !sel.options.length) { box.hidden = true; return; }
        box.hidden = false;
        const num = box.querySelector('.cv-ep-num');
        const epoch = Number(sel.value);
        num.textContent = isFinite(epoch) ? String(epoch) : sel.value;
        // Green for the latest epoch, yellow for a historical one.
        const isLatest = epoch === Number(latestEpochNumber);
        num.classList.toggle('is-latest', isLatest);
        num.classList.toggle('is-past', !isLatest);
        num.title = isLatest ? 'Latest epoch' : 'Historical epoch';
        box.querySelector('[data-ep="older"]').disabled = sel.selectedIndex >= sel.options.length - 1;
        box.querySelector('[data-ep="newer"]').disabled = sel.selectedIndex <= 0;
        box.querySelector('[data-ep="latest"]').disabled = sel.selectedIndex <= 0;
    }

    function subheaderBindSelect(sel) {
        if (!sel || sel.__cvSubheaderBound) return;
        sel.__cvSubheaderBound = true;
        sel.addEventListener('change', () => { if (sel === subheaderEpochSelect) subheaderSyncEpoch(); });
        // Options are rebuilt on first load and on every pool page.
        new MutationObserver(() => { if (sel === subheaderEpochSelect) subheaderSyncEpoch(); })
            .observe(sel, { childList: true });
    }

    function subheaderEnsure() {
        if (subheaderEl) return subheaderEl;
        subheaderEl = document.createElement('div');
        subheaderEl.id = 'cv-subheader';
        subheaderEl.className = 'cv-subheader';
        subheaderEl.innerHTML = '<div class="cv-subheader-inner"><span class="cv-subheader-logo"></span>' +
            '<span class="cv-subheader-text"><span class="cv-subheader-kind"></span><span class="cv-subheader-title"></span></span>' +
            '<span class="cv-subheader-epochs" hidden>' +
            '<button type="button" class="cv-ep-btn" data-ep="older" aria-label="Previous epoch" title="Previous epoch"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>' +
            '<span class="cv-ep-num"></span>' +
            '<button type="button" class="cv-ep-btn" data-ep="newer" aria-label="Next epoch" title="Next epoch"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>' +
            '<button type="button" class="cv-ep-btn" data-ep="latest" aria-label="Latest epoch" title="Latest epoch"><i class="fas fa-angles-right" aria-hidden="true"></i></button>' +
            '</span>' +
            '<button type="button" class="cv-ep-btn cv-subheader-top" aria-label="Back to the top" title="Back to the top"><i class="fas fa-arrow-up" aria-hidden="true"></i></button></div>';
        subheaderEl.querySelector('.cv-subheader-top').addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        // Epoch steps drive the view's own epoch selector (options run from
        // the newest epoch to the oldest), so all loading logic stays there.
        subheaderEl.querySelectorAll('.cv-subheader-epochs .cv-ep-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const sel = subheaderEpochSelect;
                if (!sel || btn.disabled || !sel.options.length) return;
                const step = btn.getAttribute('data-ep');
                const i = step === 'latest' ? 0 : sel.selectedIndex + (step === 'older' ? 1 : -1);
                if (i < 0 || i >= sel.options.length || i === sel.selectedIndex) return;
                sel.selectedIndex = i;
                sel.dispatchEvent(new Event('change'));
                subheaderSyncEpoch();
            });
        });
        const anchor = document.getElementById('cv-staleness-banner') || document.querySelector('header');
        if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', subheaderEl);
        else document.body.insertBefore(subheaderEl, document.body.firstChild);
        window.addEventListener('resize', subheaderPlace);
        requestAnimationFrame(subheaderPlace);
        return subheaderEl;
    }

    // kind: small label ("Pool", later "Validator"; empty for tabs), title,
    // logoHtml: a logo circle, syncImg: an on-page logo whose resolved src the
    // bar mirrors (light/dark variants are resolved there), epochSelect: the
    // view's epoch <select>, or null for no epoch steps.
    function subheaderSet(kind, title, logoHtml, syncImg, epochSelect) {
        const el = subheaderEnsure();
        const kindEl = el.querySelector('.cv-subheader-kind');
        kindEl.textContent = kind || '';
        kindEl.hidden = !kind;
        el.querySelector('.cv-subheader-title').textContent = title;
        el.querySelector('.cv-subheader-logo').innerHTML = logoHtml || '';
        if (subheaderImgObserver) { subheaderImgObserver.disconnect(); subheaderImgObserver = null; }
        if (syncImg) {
            const copy = () => {
                const img = el.querySelector('.cv-subheader-logo img');
                if (!img || !syncImg.getAttribute('src')) return;
                // The small circle keeps the flat logo, also when the image
                // it follows shows the isometric sprite.
                const flat = syncImg.dataset.logoDefault
                    ? resolveLogoUrlSync(syncImg.dataset.logoDefault, document.body.classList.contains('dark-theme-body'))
                    : syncImg.src;
                // data-logo-default puts this image into the theme-variant
                // refresh, so it also gets the _light / _dark flat logo.
                if (syncImg.dataset.logoDefault) img.dataset.logoDefault = syncImg.dataset.logoDefault;
                if (img.src !== flat) img.src = flat;
            };
            copy();
            subheaderImgObserver = new MutationObserver(copy);
            subheaderImgObserver.observe(syncImg, { attributes: true, attributeFilter: ['src'] });
        }
        subheaderEpochSelect = epochSelect || null;
        subheaderBindSelect(subheaderEpochSelect);
        subheaderSyncEpoch();
        subheaderPlace();
    }

    function subheaderShowTab(tab) {
        const poolView = document.getElementById('pool-detail-view');
        if (poolView && poolView.style.display !== 'none') return; // the pool page owns the bar
        const validatorView = document.getElementById('validator-detail-view');
        if (validatorView && validatorView.style.display !== 'none') return; // so does the validator page
        const t = SUBHEADER_TABS[tab] || SUBHEADER_TABS.pools;
        subheaderSet('', t.title, t.kit ? kitLogoHtml(t.kit)
                : '<span class="cv-flow-logo is-icon"><i class="fas ' + t.icon + '" aria-hidden="true"></i></span>',
            null, t.epochSelectId ? document.getElementById(t.epochSelectId) : null);
    }

    function subheaderShowCurrentTab() {
        const active = document.querySelector('.sp-tab-link.active');
        subheaderShowTab(active ? active.getAttribute('data-tab') : 'pools');
    }

    function poolSubheaderSet(poolDef) {
        if (!poolDef) return;
        const name = cleanText(poolDef.long_name) || poolDef.short_name || poolDef.group;
        subheaderSet('Pool', name, poolLogoMiniHtml(poolDef.group, poolDef),
            document.getElementById('pool-detail-image'), document.getElementById('pool-epoch-select'));
    }

    // Tooltip on the activating / deactivating numbers of a validator row:
    // which pools the stake moves in, with their logos. Built on demand from
    // the row's data, in the same glass box as the other tooltips.
    function poolLogoMiniHtml(groupName, def) {
        const raw = def && def.image ? String(def.image) : '';
        if (raw && isValidHttpUrl(raw)) {
            let url = raw;
            try {
                while (url.includes('%')) {
                    const decoded = decodeURIComponent(url);
                    if (decoded === url) break;
                    url = decoded;
                }
            } catch (_) {
                url = raw;
            }
            const isDark = document.body.classList.contains('dark-theme-body');
            // Wrapper pattern (REFERENCE 6): the span is the circle, the logo
            // sits inside it with object-fit: contain and pixel padding - a
            // logo is never cropped into a circle.
            return '<span class="cv-flow-logo"><img src="' + escapeHtml(resolveLogoUrlSync(url, isDark)) + '" alt=""></span>';
        }
        if (String(groupName).toLowerCase() === 'other') {
            return '<span class="cv-flow-logo is-other">' + OTHER_GROUP_SVG + '</span>';
        }
        return '<span class="cv-flow-logo is-initials">' + escapeHtml(getInitials(groupName)) + '</span>';
    }

    function positionTip(el, tip) {
        const rect = el.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        const PAD = 10;
        let top = rect.top - tr.height - 10;
        let left = rect.left + rect.width / 2 - tr.width / 2;
        if (left < PAD) left = PAD;
        if (left + tr.width > window.innerWidth - PAD) left = window.innerWidth - tr.width - PAD;
        if (top < PAD) top = rect.bottom + 10;
        tip.style.top = top + 'px';
        tip.style.left = left + 'px';
    }

    function showFlowTip(el) {
        const up = el.getAttribute('data-cv-flow') !== 'deactivating';
        const vote = el.getAttribute('data-vote') || '';
        const v = validatorsData.find(x => x.info && x.info.vote_pubkey === vote);
        if (!v) return;
        if (el.getAttribute('data-cv-flow') === 'active') { showListStakeTip(el, v); return; }
        const field = up ? 'activating_lamports' : 'deactivating_lamports';
        const groups = getResolvedGroups(v, validatorsPoolDefs)
            .filter(g => (g[field] || 0) >= MIN_ACTIVE_STAKE)
            .sort((a, b) => (b[field] || 0) - (a[field] || 0));
        if (!groups.length) return;
        const LIMIT = 12;
        const icon = up ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down';
        let html = '<div class="pool-tooltip-title">' + (up ? 'Activating' : 'Deactivating') + ' by pool</div>' + cvListEpochLine();
        groups.slice(0, LIMIT).forEach(g => {
            const def = latestPoolDefinitions.find(d => d.group === g.name);
            const label = String(g.name).toLowerCase() === 'other' ? 'Other stake' : (cleanText(def && def.long_name) || g.name);
            html += '<div class="cv-flow-row">' + poolLogoMiniHtml(g.name, def) +
                '<span class="cv-flow-name">' + escapeHtml(label) + '</span>' +
                '<span class="cv-flow-val ' + (up ? 'is-up' : 'is-down') + '"><i class="fas ' + icon + '" aria-hidden="true"></i>' +
                formatCompact(lamportsToSol(g[field])) + '</span></div>';
        });
        if (groups.length > LIMIT) html += '<div class="cv-flow-more">and ' + (groups.length - LIMIT) + ' more</div>';
        const old = document.getElementById('dynamic-pool-tooltip');
        if (old) old.remove();
        const tip = document.createElement('div');
        tip.id = 'dynamic-pool-tooltip';
        tip.className = 'pool-tooltip cv-flow-tip';
        tip.innerHTML = html;
        document.body.appendChild(tip);
        positionTip(el, tip);
        tip.classList.add('visible');
    }

    document.addEventListener('mouseover', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[data-cv-tip],[data-cv-flow],[data-cv-vdtip],[data-cv-rich]') : null;
        if (!el || el === cvTipTarget) return;
        cvTipTarget = el;
        if (el.hasAttribute('data-cv-rich')) showCvRichTip(el);
        else if (el.hasAttribute('data-cv-vdtip')) showCvVdTip(el);
        else if (el.hasAttribute('data-cv-flow')) showFlowTip(el);
        else showCvTip(el);
    });
    document.addEventListener('mouseout', (e) => {
        if (!cvTipTarget) return;
        const from = e.target && e.target.closest ? e.target.closest('[data-cv-tip],[data-cv-flow],[data-cv-vdtip],[data-cv-rich]') : null;
        if (from !== cvTipTarget) return;
        if (e.relatedTarget && cvTipTarget.contains(e.relatedTarget)) return;
        cvTipTarget = null;
        window.hidePoolTooltip();
    });
    window.addEventListener('scroll', () => { cvTipTarget = null; }, { passive: true });

    // Copy-on-click for [data-cv-copy]. Capture phase + stopPropagation keeps
    // the click away from row handlers (the row will open the validator view).
    function legacyCopy(text) {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.setAttribute('readonly', '');
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch (_) {
            return false;
        }
    }
    function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
        }
        return Promise.resolve(legacyCopy(text));
    }
    document.addEventListener('click', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[data-cv-copy]') : null;
        if (!el) return;
        e.preventDefault();
        e.stopPropagation();
        copyText(el.getAttribute('data-cv-copy') || '').then((ok) => {
            el.classList.remove('is-copied', 'is-copy-failed');
            void el.offsetWidth;
            el.classList.add(ok ? 'is-copied' : 'is-copy-failed');
            clearTimeout(el._cvCopyTimer);
            el._cvCopyTimer = setTimeout(() => el.classList.remove('is-copied', 'is-copy-failed'), 1400);
        });
    }, true);

    // ============================================
    // POOL BADGE HTML BUILDERS
    // ============================================
    function createPoolBadgeHtml(pool, validatorId, poolDef, isStale, epochNum) {
        const poolImage = poolDef?.image || '';
        let imageUrl = poolImage;
		if (imageUrl) {
			try {
				// Keep decoding until it's clean or no changes are made
				while (imageUrl.includes('%')) {
					const newUrl = decodeURIComponent(imageUrl);
					if (newUrl === imageUrl) break;
					imageUrl = newUrl;
				}
			} catch (e) {
				console.warn('Failed to decode image URL:', poolImage, e);
				imageUrl = poolImage; // Use original if decoding fails
			}
		}
        
        const poolTitle = escapeHtml(cleanText(poolDef?.long_name) || pool.name);
        
		let badgeContentHtml = '';
		if (imageUrl) {
			// Block B: theme-variant resolution for pool badge in validators table
			const isDarkBadge = document.body.classList.contains('dark-theme-body');
			const resolvedBadge = resolveLogoUrlSync(imageUrl, isDarkBadge);
			badgeContentHtml = `<img class="pool-badge-image" src="${resolvedBadge}" data-logo-default="${imageUrl}" alt="${poolTitle}">`;
		} else if (pool.name.toLowerCase() === 'other') { // Changed this line
			badgeContentHtml = OTHER_GROUP_SVG;
		} else {
			badgeContentHtml = `<span class="pool-badge-initials">${getInitials(pool.name)}</span>`;
		}

        const tooltipId = `pool-tooltip-${validatorId}-${pool.name.replace(/\s+/g, '-')}`;
        const epochNote = isStale ? ` (epoch ${epochNum})` : '';
        // Stake movement rings (D7 + Viktor 26.09): green = activating, red =
        // deactivating, split = both at once, dashed = the whole relationship
        // is arriving (activating only, label "+amount") or leaving (all
        // active stake deactivating, label in red). Same 0.1 SOL threshold.
        const pActive = pool.active_lamports || 0;
        const pAct = pool.activating_lamports || 0;
        const pDeact = pool.deactivating_lamports || 0;
        const activatingOnly = pActive < MIN_ACTIVE_STAKE && pAct >= MIN_ACTIVE_STAKE;
        const hasAct = pAct >= MIN_ACTIVE_STAKE;
        const hasDeact = pDeact >= MIN_ACTIVE_STAKE;
        let movementClass = '';
        if (activatingOnly) movementClass = ' is-activating-only';
        else if (hasAct && hasDeact) movementClass = ' is-activating is-deactivating';
        else if (hasAct) movementClass = ' is-activating';
        else if (hasDeact && pDeact >= pActive) movementClass = ' is-exiting';
        else if (hasDeact) movementClass = ' is-deactivating';
        const movementStyle = (hasAct && hasDeact)
            ? ' style="--act-share:' + Math.round(Math.min(92, Math.max(8, pAct / (pAct + pDeact) * 100))) + '%"'
            : '';
        const activeStakeFormatted = activatingOnly
            ? '+' + formatCompact(lamportsToSol(pAct))
            : formatCompact(lamportsToSol(pActive));
        
		return `
			<div class="pool-badge-wrapper${movementClass}"${movementStyle}
				 onmouseenter="window.showPoolTooltip(this)"
				 onmouseleave="window.hidePoolTooltip()">
				<div class="pool-badge">
					${badgeContentHtml}
				</div>
				<div class="pool-badge-stake">${activeStakeFormatted}</div>
		
				<div class="pool-tooltip-content" style="display: none;">
					<div class="pool-tooltip-title">${poolTitle}</div>
					${isStale ? `<div class="pool-tooltip-epoch">Epoch ${epochNum}</div>` : ''}
					<div class="pool-tooltip-stats-container">
						<div class="pool-tooltip-stat active">
							<span class="label"><i class="fas fa-coins"></i>Active</span>
							<span class="value">${formatNumber(lamportsToSol(pool.active_lamports), 2)} SOL</span>
						</div>
						${pool.activating_lamports > 0 ? `
						<div class="pool-tooltip-stat activating">
							<span class="label"><i class="fas fa-arrow-trend-up"></i>Activating</span>
							<span class="value">${formatNumber(lamportsToSol(pool.activating_lamports), 2)} SOL</span>
						</div>` : ''}
						${pool.deactivating_lamports > 0 ? `
						<div class="pool-tooltip-stat deactivating">
							<span class="label"><i class="fas fa-arrow-trend-down"></i>Deactivating</span>
							<span class="value">${formatNumber(lamportsToSol(pool.deactivating_lamports), 2)} SOL</span>
						</div>` : ''}
						${pool.count > 0 ? `
						<div class="pool-tooltip-stat accounts">
							<span class="label"><i class="fas fa-wallet"></i>Stake accounts</span>
							<span class="value">${formatNumber(pool.count)}</span>
						</div>` : ''}
					</div>
				</div>
			</div>
		`;
    }

    // ============================================
    // VALIDATORS LIST RENDERING
    // ============================================
	function renderValidatorsListItems() {
		const listContainer = document.getElementById('validators-list-items-container');
		if (!listContainer) return;
	
		let html = '';
		const validatorsToRender = filteredValidators.slice(0, validatorsVisibleCount);
	
		const inactiveHtml = cvInactiveMatchesHtml();
		if (validatorsToRender.length === 0) {
			listContainer.innerHTML = (inactiveHtml
				? '<div class="validators-no-results cv-no-active"><p>No active validator matches in this epoch.</p></div>'
				: '<div class="validators-no-results"><i class="fas fa-search"></i><p>No validators found matching your search criteria.</p></div>') + inactiveHtml;
			cvFillInactiveChips();
			return;
		}
	
		const isStaleView = document.getElementById('epoch-stale-pill')?.style.display !== 'none';
		const selectedEpochValue = document.getElementById('epoch-select')?.value;
	
		validatorsToRender.forEach((validator, index) => {
			const rank = index + 1;
			const votePubkey = validator.info?.vote_pubkey || '';
			const identityPubkey = validator.info?.identity_pubkey || '';
			const validatorId = votePubkey.replace(/[^a-zA-Z0-9]/g, '') || `validator-${index}`;
	
			// Only http(s) icon URLs are used; anything else falls back to initials.
			const rawImageUrl = validator.info?.icon_url || '';
			const imageUrl = isValidHttpUrl(rawImageUrl) ? rawImageUrl : '';
	
			const rawName = (validator.info?.name || '').trim();
			const realName = hasRealName(rawName);
			const validatorName = realName ? rawName : shortenPubkey(rawName || votePubkey);
			const nameHtml = escapeHtml(validatorName);
			const vHref = escapeHtml(validatorHref(votePubkey, isStaleView ? selectedEpochValue : null));
			const nameHit = cvNameHit(votePubkey, rawName, !isStaleView);
	
			// Pool badges (D7): a relationship counts when active OR activating
			// stake reaches the threshold; activating-only ones go last.
			const pools = getResolvedGroups(validator, validatorsPoolDefs)
				.filter(p => meetsStakeThreshold(p.active_lamports, p.activating_lamports))
				.sort((a, b) => (b.active_lamports - a.active_lamports) || (b.activating_lamports - a.activating_lamports));
	
			const poolsHtml = pools.map(pool => {
				const poolDef = latestPoolDefinitions.find(d => d.group === pool.name);
				return createPoolBadgeHtml(pool, validatorId, poolDef, isStaleView, selectedEpochValue);
			}).join('');
	
			const isDelinquent = !!(validator.meta && validator.meta.delinquent === true);
			const avatarHtml = imageUrl
				? `<img class="validator-image" src="${escapeHtml(imageUrl)}" alt="${nameHtml}" loading="lazy"
						data-fb-name="${nameHtml}" data-fb-key="${escapeHtml(identityPubkey)}">`
				: createFallbackImage(validatorName, identityPubkey);
	
			html += `
				<div class="validator-item${isDelinquent ? ' is-delinquent' : ''}">
					<div class="validator-main-info">
						<div class="validator-rank">#${rank}</div>
						<a class="cv-vlink cv-vlink-avatar" data-cv-nav href="${vHref}" tabindex="-1" aria-hidden="true"><div class="validator-image-wrapper">${avatarHtml}</div></a>
						<div class="validator-info">
							<div class="validator-name cv-name-line" title="${nameHtml}">
								<a class="cv-name-text cv-vlink" data-cv-nav href="${vHref}">${nameHtml}${CV_GO_SVG}</a>
								${realName ? copyButtonHtml(rawName, 'Copy name') : ''}
							</div>
							${isStaleView ? cvGoneBadgeHtml(votePubkey) : ''}${nameHit ? `<div class="cv-formerly">${nameHit.label} <b>${escapeHtml(nameHit.name)}</b></div>` : ''}
							<div class="validator-pubkeys cv-keys">
								${identityPubkey ? keyTokenHtml('ID', identityPubkey) : ''}
								${votePubkey ? keyTokenHtml('Vote', votePubkey) : ''}
							</div>
							${cvListMetaHtml(validator)}
						</div>
					</div>
					<div class="validator-stake-stats">
						<div class="stake-stat active" data-cv-flow="active" data-vote="${escapeHtml(votePubkey)}">
							<i class="fas fa-coins"></i>
							<span class="value">${formatCompact(lamportsToSol(validator.totals?.total_active_lamports || 0))}</span>
						</div>
						${(validator.totals?.total_activating_lamports || 0) > 0 ? `
						<div class="stake-stat activating" data-cv-flow="activating" data-vote="${escapeHtml(votePubkey)}">
							<i class="fas fa-arrow-trend-up"></i>
							<span class="value">${formatCompact(lamportsToSol(validator.totals.total_activating_lamports))}</span>
						</div>` : ''}
						${(validator.totals?.total_deactivating_lamports || 0) > 0 ? `
						<div class="stake-stat deactivating" data-cv-flow="deactivating" data-vote="${escapeHtml(votePubkey)}">
							<i class="fas fa-arrow-trend-down"></i>
							<span class="value">${formatCompact(lamportsToSol(validator.totals.total_deactivating_lamports))}</span>
						</div>` : ''}
					</div>
					<div class="validator-pools">${poolsHtml}</div>
				</div>
			`;
		});
	
		if (filteredValidators.length > validatorsVisibleCount) {
			html += `
				<div class="validators-load-more-container">
					<button class="validators-load-more-btn" onclick="window.handleShowMoreValidators()">
						<i class="fas fa-plus-circle"></i> 
						Show More (${filteredValidators.length - validatorsVisibleCount} remaining)
					</button>
				</div>
			`;
		}
	
		listContainer.innerHTML = html + inactiveHtml;
		cvFillInactiveChips();
	
		// Images that failed before the error listener could see them.
		listContainer.querySelectorAll('img.validator-image').forEach(img => {
			if (img.complete && img.naturalHeight === 0) {
				window.handleValidatorImage(img, img.dataset.fbName || '', img.dataset.fbKey || '');
			}
		});
	}

    // ============================================
    // VALIDATORS TAB ENTRY POINT
    // ============================================
	function populateValidatorsTab(isStale = false, epochNum = null) {
		const container = document.getElementById('validators-table-container');
		if (!container) return;
		
		container.innerHTML = `
			<div class="validators-search-container ${searchQuery ? 'has-value' : ''}">
				<i class="fas fa-search validators-search-icon"></i>
				<input type="text" 
					   class="validators-search-input" 
					   placeholder="Search name, key, client or pool, join several with +" 
					   value="${escapeHtml(searchQuery)}" 
					   oninput="window.handleValidatorSearch(this.value)">
				<button class="validators-search-clear" onclick="window.clearValidatorSearch()">
					<i class="fas fa-times"></i>
				</button>
			</div>
			<div id="validators-stats-summary"></div>
			<div class="validators-sort-bar"></div> 
			<div id="validators-list-items-container"></div>
		`;
		
		// ⭐ ВИКЛИКАЄМО НОВІ ФУНКЦІЇ
		updateSortButtons(isStale, epochNum);
		updateValidatorStats(isStale, epochNum);
		renderValidatorsListItems();
	}
// ⭐ НОВА ФУНКЦІЯ ДЛЯ ОНОВЛЕННЯ КНОПОК СОРТУВАННЯ
    function updateSortButtons(isStale = false, epochNum = null) {
        const sortBar = document.querySelector('.validators-sort-bar');
        if (!sortBar) return;

        const pastEpochBadge = isStale ? `
        <span class="validators-sort-badge">
            <i class="fas fa-hourglass-half"></i> Past Epoch: ${epochNum}
        </span>` : '';

        let byPoolsButtonHtml;
        if (isPoolSearchMode && poolSortOrder.length > 0) {
            const isDarkSortBtn = document.body.classList.contains('dark-theme-body');
            const poolIconsHtml = poolSortOrder.map(poolName => {
                const poolDef = latestPoolDefinitions.find(d => d.group === poolName);
                if (poolDef && poolDef.image) {
                    const resolvedSortBtn = resolveLogoUrlSync(poolDef.image, isDarkSortBtn);
                    return `<img src="${resolvedSortBtn}" data-logo-default="${poolDef.image}" class="sort-pool-icon" title="${poolName}">`;
                }
                return `<span class="sort-pool-icon-initials" title="${poolName}">${getInitials(poolName)}</span>`;
            }).join('');

            byPoolsButtonHtml = `
                <button class="validators-sort-btn ${validatorsSortMode === 'pool-specific' ? 'active' : ''}" 
                        onclick="window.changeValidatorSort('pool-specific')">
                    <i class="fas fa-layer-group"></i> By Pools (beta) ${poolIconsHtml}
                </button>
            `;
        } else {
            byPoolsButtonHtml = `
                <button class="validators-sort-btn coming-soon" disabled>
                    <i class="fas fa-layer-group"></i> By Pools (soon)
                </button>
            `;
        }

        // Ages come from the snapshot (epoch 1043 and later) or, for older epochs, from the validators index.
        validatorsListEpoch = Number((document.getElementById('epoch-select') || {}).value);
        validatorsHasAge = validatorsData.some(v => v.meta && typeof v.meta.validator_age === 'number') || !!cvIndexByVote;
        if (isStale) cvEnsureIndexForList();
        const ageButtonHtml = `<button class="validators-sort-btn ${validatorsSortMode === 'age' ? 'active' : ''}" onclick="window.changeValidatorSort('age')"><i class="fas fa-hourglass-half"></i> Age${validatorsSortMode === 'age' ? ` <i class="fas ${validatorsAgeAsc ? 'fa-caret-up' : 'fa-caret-down'}"></i>` : ''}</button>`;
        sortBar.innerHTML = `
            <span class="label">Sort by:</span>
            <button class="validators-sort-btn ${validatorsSortMode === 'active-stake' ? 'active' : ''}" 
                    onclick="window.changeValidatorSort('active-stake')">
                <i class="fas fa-coins"></i> Active Stake
            </button>
            <button class="validators-sort-btn ${validatorsSortMode === 'activating' ? 'active' : ''}" 
                    onclick="window.changeValidatorSort('activating')">
                <i class="fas fa-arrow-trend-up"></i> Activating
            </button>
             <button class="validators-sort-btn ${validatorsSortMode === 'deactivating' ? 'active' : ''}" 
                     onclick="window.changeValidatorSort('deactivating')">
                 <i class="fas fa-arrow-trend-down"></i> Deactivating
             </button>
             ${ageButtonHtml}
             ${byPoolsButtonHtml}
             ${pastEpochBadge}
        `;
    }
    
    // Ініціалізація даних валідаторів
	function initValidatorsData(validators, isStale, epochNum, poolDefs, scriptInfo) {
		validatorsData = validators || [];
		validatorsPoolDefs = poolDefs || latestPoolDefinitions;
		validatorsScriptInfo = scriptInfo || null;
		validatorsVisibleCount = VALIDATORS_PER_PAGE;
		filterValidators();
        sortValidators(); // ⭐ Додаємо явний виклик сортування
		populateValidatorsTab(isStale, epochNum);
	}

    // ============================================
    // VALIDATORS GLOBAL EVENT HANDLERS
    // ============================================
    window.handleShowMoreValidators = function() {
        validatorsVisibleCount += VALIDATORS_PER_PAGE;
        renderValidatorsListItems();
    };
    
// ⭐ НОВА ФУНКЦІЯ ДЛЯ АНАЛІЗУ ПОШУКОВОГО ЗАПИТУ
    function analyzeSearchQuery(value) {
        const poolNamesMap = new Map();
        latestPoolDefinitions.forEach(def => {
            if (def.group) poolNamesMap.set(def.group.toLowerCase(), def.group);
        });

        const searchTerms = splitSearchTerms(value);
        
        isPoolSearchMode = false;
        poolSortOrder = [];
        
        if (searchTerms.length > 0) {
            const matchedPools = [];
            const allTermsArePools = searchTerms.every(term => {
                if (term.length < 3) return false;
                
                const exactMatch = poolNamesMap.get(term);
                if (exactMatch) {
                    if (!matchedPools.includes(exactMatch)) matchedPools.push(exactMatch);
                    return true;
                }
                
                const partialMatches = Array.from(poolNamesMap.keys()).filter(poolKey => poolKey.startsWith(term));
                if (partialMatches.length === 1) {
                    const matchedPool = poolNamesMap.get(partialMatches[0]);
                    if (!matchedPools.includes(matchedPool)) matchedPools.push(matchedPool);
                    return true;
                }
                
                return false;
            });
            
            if (allTermsArePools) {
                isPoolSearchMode = true;
                poolSortOrder = matchedPools;
                if (validatorsSortMode !== 'pool-specific') {
                    validatorsSortMode = 'pool-specific';
                }
            }
        }
        
        if (!isPoolSearchMode && validatorsSortMode === 'pool-specific') {
            validatorsSortMode = 'active-stake';
        }
    }
    
	// Debounced version to avoid re-rendering on every keystroke
	const debouncedSearch = debounce((value) => {
        searchQuery = value;
        
        // Виносимо логіку аналізу запиту в окрему функцію
        analyzeSearchQuery(value);
        
        // Оновлюємо інтерфейс
        const container = document.querySelector('.validators-search-container');
        if (container) {
            container.classList.toggle('has-value', value.length > 0);
        }
        
        validatorsVisibleCount = VALIDATORS_PER_PAGE;
        
        // ⭐ ВИКЛИКАЄМО НОВІ ФУНКЦІЇ ЗАМІСТЬ populateValidatorsTab
        updateSortButtons(
            document.getElementById('epoch-stale-pill')?.style.display !== 'none', 
            document.getElementById('epoch-select')?.value
        );
        filterValidators();
        sortValidators();
        updateValidatorStats(
            document.getElementById('epoch-stale-pill')?.style.display !== 'none', 
            document.getElementById('epoch-select')?.value
        );
        renderValidatorsListItems();
        
        const epochSel = document.getElementById('epoch-select');
        let epochForUrl = null;
        if (epochSel && epochSel.value) {
            epochForUrl = (Number(epochSel.value) === Number(latestEpochNumber)) ? 'latest' : epochSel.value;
        }
        setUrlState({ 
            tab: 'validators', 
            epoch: epochForUrl,
            search: searchQuery || null
        });
    }, 300);
	
	window.handleValidatorSearch = function(value) {
		cvEnsureIndexForSearch(value);
		debouncedSearch(value);
	};
    
    window.clearValidatorSearch = function() {
        searchQuery = '';
        const input = document.querySelector('.validators-search-input');
        if (input) input.value = '';
        window.handleValidatorSearch('');
    };
    
    window.changeValidatorSort = function(mode) {
        // A second click on Age flips oldest-first and youngest-first.
        validatorsAgeAsc = (mode === 'age' && validatorsSortMode === 'age') ? !validatorsAgeAsc : false;
        if (mode === 'age' && !cvIndexData) cvEnsureIndexForList();
        validatorsSortMode = mode;
        sortValidators();
        
		document.querySelectorAll('.validators-sort-btn').forEach(btn => {
			const onclickAttr = btn.getAttribute('onclick');
			if (onclickAttr) { // Додаємо перевірку, чи існує атрибут
				btn.classList.toggle('active', onclickAttr.includes(`'${mode}'`));
			}
		});
        
        updateValidatorStats(
            document.getElementById('epoch-stale-pill')?.style.display !== 'none', 
            document.getElementById('epoch-select')?.value
        );
        renderValidatorsListItems();
        updateSortButtons(
            document.getElementById('epoch-stale-pill')?.style.display !== 'none',
            document.getElementById('epoch-select')?.value
        );
    };

    // ============================================
    // CHART FUNCTIONS
    // ============================================
    function renderInteractiveChart(container, data, title = 'Active Stake', highlightEpoch = null) {
        if (!container || !data || data.length === 0) {
            if (container) container.style.display = 'none';
            return;
        }
        
        container.style.display = 'block';
        const formatValue = (val) => {
            if (val >= 1_000_000) return `${(val/1_000_000).toFixed(2)}M`;
            if (val >= 1_000) return `${(val/1_000).toFixed(1)}K`;
            return val.toFixed(0);
        };

        const width = container.clientWidth;
        if (width === 0) {
            // Якщо контейнер ще не має ширини, чекаємо
            if ('ResizeObserver' in window) {
                const ro = new ResizeObserver((entries) => {
                    if (entries[0]?.contentRect.width > 0) {
                        ro.disconnect();
                        renderInteractiveChart(container, data, title, highlightEpoch);
                    }
                });
                ro.observe(container);
            } else {
                let tries = 0;
                const t = setInterval(() => {
                    if (container.clientWidth > 0 || tries++ > 10) {
                        clearInterval(t);
                        renderInteractiveChart(container, data, title, highlightEpoch);
                    }
                }, 120);
            }
            return;
        }
        
        const height = 60, PADDING = 5;

        if (data.length === 1) {
            // Особливий випадок для однієї точки даних
            const pointX = width / 2;
            const pointY = height / 2;
            container.innerHTML = `
                ${title ? `<div class="chart-title">${title}</div>` : ''}
                <div class="chart-tooltip"></div>
                <svg viewBox="0 0 ${width} ${height}" style="overflow: visible; cursor: pointer;">
                    <line class="chart-baseline" x1="0" y1="${pointY}" x2="${width}" y2="${pointY}"></line>
                    ${highlightEpoch !== null ? `<line class="selected-epoch-line" x1="${pointX}" x2="${pointX}" y1="0" y2="${height}"></line>` : ''}
                    ${highlightEpoch !== null ? `<circle class="selected-epoch-dot" cx="${pointX}" cy="${pointY}" r="4.5"></circle>`: ''}
                    <line class="tracker-line-svg" x1="${pointX}" x2="${pointX}" y1="0" y2="${height}"></line>
                    <circle class="tracker-dot-svg" r="4.5" cx="${pointX}" cy="${pointY}"></circle>
                </svg>
                <div class="chart-range-labels">
                    <span>${data[0].epoch}: <span class="value">${formatValue(data[0].value)}</span></span>
                    <span>First epoch for this pool</span>
                </div>`;
            
            const tooltip = container.querySelector('.chart-tooltip');
            container.addEventListener('mouseenter', () => { 
                tooltip.style.opacity = '1'; 
            });
            container.addEventListener('mouseleave', () => { 
                tooltip.style.opacity = '0'; 
            });
            tooltip.style.left = `${pointX}px`;
            tooltip.style.top = `${pointY}px`;
            tooltip.innerHTML = `<span class="epoch">Epoch ${data[0].epoch}:</span> ${new Intl.NumberFormat('en-US').format(data[0].value)} SOL`;
        } else {
            // Звичайний графік для багатьох точок
            const values = data.map(d => d.value);
            const minVal = Math.min(...values);
            const maxVal = Math.max(...values);
            const range = maxVal - minVal === 0 ? 1 : maxVal - minVal;
        
            const points = data.map((d, i) => {
                const x = (i / (data.length - 1 || 1)) * width;
                const y = height - PADDING - ((d.value - minVal) / range) * (height - 2 * PADDING);
                return { x, y, epoch: d.epoch, value: d.value };
            });
        
            let marker = null;
            if (highlightEpoch !== null) {
                let idx = data.findIndex(d => Number(d.epoch) === Number(highlightEpoch));
                if (idx === -1) {
                    let best = 0, bestDiff = Infinity;
                    data.forEach((d, i) => { 
                        const diff = Math.abs(Number(d.epoch) - Number(highlightEpoch)); 
                        if (diff < bestDiff) { 
                            bestDiff = diff; 
                            best = i; 
                        }
                    });
                    idx = best;
                }
                marker = points[idx];
            }
        
            const pathLineData = points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L ');
            const pathFillData = `M ${points[0].x.toFixed(2)},${height} L ${pathLineData} L ${points[points.length-1].x.toFixed(2)},${height} Z`;
        
            container.innerHTML = `
                ${title ? `<div class="chart-title">${title}</div>` : ''}
                <div class="chart-tooltip"></div>
                <svg viewBox="0 0 ${width} ${height}" style="overflow: visible; cursor: pointer;">
                    <defs>
                        <linearGradient id="sparkline-gradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="var(--sparkline-gradient-start)" />
                            <stop offset="100%" stop-color="var(--sparkline-gradient-end)" />
                        </linearGradient>
                    </defs>
                    <path d="${pathFillData}" class="chart-path-fill" />
                    <path d="M ${pathLineData}" class="chart-path-line" />
                    ${marker ? `<line class="selected-epoch-line" x1="${marker.x}" x2="${marker.x}" y1="0" y2="${height}"></line>` : ''}
                    ${marker ? `<circle class="selected-epoch-dot" cx="${marker.x}" cy="${marker.y}" r="4.5"></circle>`: ''}
                    <line class="tracker-line-svg" y1="0" y2="${height}"></line>
                    <circle class="tracker-dot-svg" r="4.5"></circle>
                </svg>
                <div class="chart-range-labels">
                    <span>${data[0].epoch}: <span class="value">${formatValue(data[0].value)}</span></span>
                    <span>${data[data.length - 1].epoch}: <span class="value">${formatValue(data[data.length - 1].value)}</span></span>
                </div>`;
        
            if (marker) {
                const badge = document.createElement('div');
                badge.className = 'selected-epoch-badge';
                badge.innerHTML = `<span class="ep">Epoch ${marker.epoch}</span><span class="sub">selected</span>`;
                badge.style.visibility = 'hidden';
                container.appendChild(badge);
                
                const badgeHeight = badge.offsetHeight;
                const titleEl = container.querySelector('.chart-title');
                const titleHeight = titleEl ? titleEl.offsetHeight + 4 : 4;

                let topPosition;
                const offsetAbove = 7;
                const offsetBelow = 38;
                
                if (marker.y < height / 2) {
                    topPosition = titleHeight + marker.y + offsetBelow;
                } else {
                    topPosition = titleHeight + marker.y - badgeHeight - offsetAbove;
                }
                
                badge.style.top = `${topPosition}px`;
                badge.style.left = `${marker.x}px`;
                
                const chartCenter = width / 2;
                const maxOffset = 12;
                const distanceFromCenter = marker.x - chartCenter;
                const offsetRatio = distanceFromCenter / chartCenter;
                const finalOffset = -offsetRatio * maxOffset;
                badge.style.transform = `translateX(calc(-50% + ${finalOffset.toFixed(2)}px))`;
                
                badge.style.visibility = 'visible';
            }
        
            const line = container.querySelector('.chart-path-line');
            if (line) { 
                const length = line.getTotalLength(); 
                line.style.strokeDasharray = length; 
                line.style.strokeDashoffset = length; 
            }
        }

        // Додаємо інтерактивність
        const svg = container.querySelector('svg');
        if (!svg) return;
        
        const points = data.map((d, i) => {
            const values = data.map(d => d.value);
            const minVal = Math.min(...values);
            const maxVal = Math.max(...values);
            const range = maxVal - minVal === 0 ? 1 : maxVal - minVal;
            const x = (i / (data.length - 1 || 1)) * width;
            const y = height - PADDING - ((d.value - minVal) / range) * (height - 2 * PADDING);
            return { x, y, epoch: d.epoch, value: d.value };
        });

        const tooltip = container.querySelector('.chart-tooltip');
        const trackerLine = container.querySelector('.tracker-line-svg');
        const trackerDot = container.querySelector('.tracker-dot-svg');

        svg.addEventListener('mousemove', (e) => {
            const rect = svg.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            let closestIndex = 0, minDistance = Infinity;
            points.forEach((p, i) => { 
                const d = Math.abs(p.x - mouseX); 
                if (d < minDistance) { 
                    minDistance = d; 
                    closestIndex = i; 
                } 
            });
            const point = points[closestIndex];
            if (point) {
                tooltip.style.left = `${point.x}px`;
                tooltip.style.top = `${point.y}px`;
                tooltip.innerHTML = `<span class="epoch">Epoch ${point.epoch}:</span> ${new Intl.NumberFormat('en-US').format(point.value)} SOL`;
                trackerLine.setAttribute('x1', point.x);
                trackerLine.setAttribute('x2', point.x);
                trackerDot.setAttribute('cx', point.x);
                trackerDot.setAttribute('cy', point.y);
            }
        });

        svg.addEventListener('click', (e) => {
            const rect = svg.getBoundingClientRect();
            const mouseX = e.clientX - rect.left;
            let closestIndex = 0, minDistance = Infinity;
            points.forEach((p, i) => {
                const d = Math.abs(p.x - mouseX);
                if (d < minDistance) { 
                    minDistance = d; 
                    closestIndex = i; 
                }
            });
            const point = points[closestIndex];
            if (point) {
                const epochSelect = document.getElementById('epoch-select');
                if (epochSelect && epochSelect.value !== String(point.epoch)) {
                    epochSelect.value = point.epoch;
                    epochSelect.dispatchEvent(new Event('change'));
                }
            }
        });
    }

    // ============================================
    // URL STATE
    // ============================================
    function getUrlState() {
        const sp = new URLSearchParams(window.location.search);
        return { 
            tab: sp.get('tab') || null, 
            sort: sp.get('sort') || null, 
            epoch: sp.get('epoch') || null,
            validator: sp.get('validator') || null,
        	search: sp.get('search') || null 
        };
    }
    
    function setUrlState({tab, sort, epoch, search}) {
        const url = new URL(window.location);
        if (tab) url.searchParams.set('tab', tab); 
        else url.searchParams.delete('tab');
        if (sort) url.searchParams.set('sort', sort); 
        else url.searchParams.delete('sort');
        if (epoch) url.searchParams.set('epoch', epoch); 
        else url.searchParams.delete('epoch');
		if (search) url.searchParams.set('search', search);
		else url.searchParams.delete('search');
        history.replaceState(null, '', url);
    }

    // ============================================
    // THEME HANDLING
    // ============================================
    function applyTheme(theme) {
        const isDark = theme === 'dark';

        // Застосовуємо клас до контейнера дашборда
        document.querySelectorAll('.sofzp-dashboard-section').forEach(c => 
            isDark ? c.classList.add('dark-theme') : c.classList.remove('dark-theme')
        );
        
        // ⭐ НОВЕ І ГОЛОВНЕ: Застосовуємо спеціальний клас до <body>
        isDark ? document.body.classList.add('dark-theme-body') : document.body.classList.remove('dark-theme-body');

        // Sync with site-wide theme system: data-theme attribute on <html>
        // is what the Astro Layout and CSS variables read. Setting it here
        // keeps the site Header toggle and the dashboard breadcrumb toggle
        // in lockstep, regardless of which one the user clicks.
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

        // Оновлюємо стан перемикача в breadcrumbs
        const breadcrumbToggle = document.getElementById('theme-toggle-breadcrumb');
        if (breadcrumbToggle) breadcrumbToggle.checked = isDark;
        
        // Block B: refresh pool logos for the new theme.
        // Two-pass strategy: first sync refresh uses current cache (instant fallback
        // to defaults for any URL we do not yet know about). Then an async scan
        // populates the cache for this theme and triggers another refresh when
        // results arrive, swapping in _light/_dark variants that do exist.
        refreshAllPoolLogos(isDark);
        scanLogoVariants(isDark, () => refreshAllPoolLogos(isDark));
    }

    // ============================================
    // DATA HELPERS
    // ============================================
    function formatLocalSnapshot(iso) {
        const d = new Date(iso);
        const dt = new Intl.DateTimeFormat('en-GB', { 
            dateStyle: 'medium', 
            timeStyle: 'short' 
        }).format(d);
        const tzShort = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'short' })
            .formatToParts(d)
            .find(p => p.type === 'timeZoneName')?.value 
            || Intl.DateTimeFormat().resolvedOptions().timeZone;
        return { dt, tzShort };
    }
    
    // ============================================
    // GROUP RESOLUTION
    // ============================================
    // A registry row is identified by its public_key. The short_name is the
    // label a given snapshot used, and the group is a view that the current
    // registry defines. Snapshots keep per-key numbers in aggregations.by_pool
    // (keyed by short_name), so a later regrouping - splitting one group into
    // two, or merging two into one - can be applied to the whole history
    // without re-scanning the cluster.
    //
    // canonicalKeyGroup: public_key -> group name from the latest snapshot's
    // pool_definitions, which mirror the current stakepools_list.csv.
    let canonicalKeyGroup = new Map();

    // Bumped whenever canonicalKeyGroup or nameRemap changes. The per-snapshot
    // short_name cache below stores this number alongside its map and rebuilds
    // when it no longer matches, because the same pool_definitions array is
    // resolved again after nameRemap is populated later in the init path.
    let resolutionVersion = 0;

    function invalidateGroupResolution() {
        resolutionVersion++;
    }

    function buildCanonicalKeyGroup(latestDefs) {
        canonicalKeyGroup = new Map();
        (latestDefs || []).forEach(def => {
            if (def && def.public_key && def.group) {
                canonicalKeyGroup.set(def.public_key, def.group);
            }
        });
        invalidateGroupResolution();
    }

    // Resolve one historical pool definition to its current group name.
    // Falls back to nameRemap, then to the definition's own group, for keys
    // that are no longer present in the registry.
    function canonicalGroupForDef(def) {
        if (!def) return null;
        if (def.public_key && canonicalKeyGroup.has(def.public_key)) {
            return canonicalKeyGroup.get(def.public_key);
        }
        if (def.group && nameRemap.has(def.group)) {
            return nameRemap.get(def.group);
        }
        return def.group || null;
    }

    // Per-snapshot map short_name -> current group name. Cached on the
    // pool_definitions array itself, so it is built once per snapshot rather
    // than once per validator.
    const shortNameGroupCache = new WeakMap();

    function getShortNameGroupMap(snapshotDefs) {
        if (!Array.isArray(snapshotDefs)) return new Map();

        const cached = shortNameGroupCache.get(snapshotDefs);
        if (cached && cached.version === resolutionVersion) return cached.map;

        const map = new Map();
        snapshotDefs.forEach(def => {
            if (!def || !def.short_name) return;
            const group = canonicalGroupForDef(def);
            if (group) map.set(def.short_name, group);
        });
        shortNameGroupCache.set(snapshotDefs, { version: resolutionVersion, map });
        return map;
    }

    // Return one validator's stake grouped by current group names.
    // Real snapshots carry aggregations.by_pool, which is what makes
    // retroactive regrouping possible. Pseudo-snapshots built from
    // aggregated-history.json carry only by_group, and those names are already
    // canonical, so that path keeps the previous behaviour.
    function getResolvedGroups(validator, snapshotDefs) {
        const aggs = validator && validator.aggregations;
        if (!aggs) return [];

        if (!Array.isArray(aggs.by_pool) || aggs.by_pool.length === 0) {
            return (aggs.by_group || [])
                .filter(g => g && g.name)
                .map(g => ({
                    name: nameRemap.get(g.name) || g.name,
                    active_lamports: g.active_lamports || 0,
                    activating_lamports: g.activating_lamports || 0,
                    deactivating_lamports: g.deactivating_lamports || 0,
                    count: g.count || 0
                }));
        }

        const shortToGroup = getShortNameGroupMap(snapshotDefs);
        const byGroup = new Map();

        aggs.by_pool.forEach(entry => {
            if (!entry || !entry.name) return;

            const group = shortToGroup.get(entry.name) || nameRemap.get(entry.name) || entry.name;
            let acc = byGroup.get(group);
            if (!acc) {
                acc = {
                    name: group,
                    active_lamports: 0,
                    activating_lamports: 0,
                    deactivating_lamports: 0,
                    count: 0
                };
                byGroup.set(group, acc);
            }
            acc.active_lamports += entry.active_lamports || 0;
            acc.activating_lamports += entry.activating_lamports || 0;
            acc.deactivating_lamports += entry.deactivating_lamports || 0;
            acc.count += entry.count || 0;
        });

        return Array.from(byGroup.values());
    }

    function createNameRemap(latestPoolDefs, allEpochData) {
        const keyToCanonicalGroup = new Map();
        (latestPoolDefs || []).forEach(def => {
            if (def.public_key && def.group) {
                keyToCanonicalGroup.set(def.public_key, def.group);
            }
        });

        // Group names that still exist in the current registry. A rename means
        // the old name is gone, so remapping it is safe. A split means the old
        // name is still in use by the keys that stayed behind, and remapping it
        // would erase their entire history into the new group. Splits are
        // handled by getResolvedGroups through by_pool, not here.
        const liveGroupNames = new Set(keyToCanonicalGroup.values());

        const oldNameToCanonical = new Map();
        (allEpochData || []).forEach(epochData => {
            (epochData.pool_definitions || []).forEach(def => {
                if (def.public_key && def.group) {
                    const canonicalName = keyToCanonicalGroup.get(def.public_key);
                    if (canonicalName && canonicalName !== def.group && !liveGroupNames.has(def.group)) {
                        oldNameToCanonical.set(def.group, canonicalName);
                    }
                }
            });
        });
        return oldNameToCanonical;
    }

    // ============================================
    // SUMMARY BLOCK
    // ============================================
    function populateSummaryBlock(data, historicStakeData, highlightEpoch, isStale = false) {
        const { metadata, validators } = data;
        let totalStake = 0, activatingStake = 0, deactivatingStake = 0, activeValidatorsCount = 0;
        
        validators.forEach(v => {
            if (v && v.totals) {
                totalStake += v.totals.total_active_lamports || 0;
                activatingStake += v.totals.total_activating_lamports || 0;
                deactivatingStake += v.totals.total_deactivating_lamports || 0;
                if (meetsStakeThreshold(v.totals.total_active_lamports, v.totals.total_activating_lamports)) {
                    activeValidatorsCount++;
                }
            }
        });
        
        const epochNote = isStale ? `<span class="epoch-inline-note">in epoch ${metadata.epoch}</span>` : '';
        const summaryChartHtml = historicStakeData ? 
            `<div class="summary-chart-wrapper">
                <div class="interactive-chart-container" id="summary-chart-container"></div>
            </div>` : '';
        const localSnap = formatLocalSnapshot(metadata.timestamp_utc);
        
        document.getElementById('summary-container').innerHTML = `
            <div class="sp-summary-card">
                <span class="title"><i class="fas fa-clock icon"></i>Snapshot Time</span>
                <span class="value">${localSnap.dt} <span class="small-text">${localSnap.tzShort}</span></span>
            </div>
            <div class="sp-summary-card">
                <span class="title"><i class="fas fa-layer-group icon"></i>Epoch</span>
                <span class="value">${metadata.epoch} ${isStale ? '<span class="epoch-flag">past</span>' : ''} 
                    <span class="small-text">(${(metadata.epoch_completed_percent).toFixed(2)}%)</span>
                </span>
            </div>
            <div class="sp-summary-card cv-phone-hide">
                <span class="title"><i class="fas fa-server icon"></i>Cluster</span>
                <span class="value">${metadata.cluster_name}</span>
            </div>
            <div class="sp-summary-card cv-phone-hide">
                <span class="title"><i class="fas fa-users icon"></i>Active Validators</span>
                <span class="value">${activeValidatorsCount}</span>
            </div>
            <div class="sp-summary-card total-stake-card">
                <span class="title"><i class="fas fa-coins icon"></i>Stake Distribution</span>
                ${summaryChartHtml}
                <div class="total-stake-grid">
                    <div class="total-stake-item">
                        <i class="fas fa-chart-pie icon" id="total-stake-icon"></i>
                        <div class="stake-info">
                            <span class="value">${formatNumber(lamportsToSol(totalStake), 2)}</span>
                            <span class="label">Total Active Stake${epochNote}</span>
                        </div>
                    </div>
                    <div class="total-stake-item">
                        <i class="fas fa-arrow-trend-up icon" id="activating-stake-icon"></i>
                        <div class="stake-info">
                            <span class="value">${formatNumber(lamportsToSol(activatingStake), 2)}</span>
                            <span class="label">Activating${epochNote}</span>
                        </div>
                    </div>
                    <div class="total-stake-item">
                        <i class="fas fa-arrow-trend-down icon" id="deactivating-stake-icon"></i>
                        <div class="stake-info">
                            <span class="value">${formatNumber(lamportsToSol(deactivatingStake), 2)}</span>
                            <span class="label">Deactivating${epochNote}</span>
                        </div>
                    </div>
                    <div class="total-stake-item">
                        <i class="fas fa-sitemap icon" id="total-validators-icon"></i>
                        <div class="stake-info">
                            <span class="value">${validators.length}</span>
                            <span class="label">Total Included Validators${epochNote}</span>
                        </div>
                    </div>
                </div>
            </div>`;
            
        if (historicStakeData) {
            chartsToRedraw.push({ 
                id: 'summary-chart-container', 
                data: historicStakeData, 
                title: 'Total Active Stake Dynamics', 
                highlightEpoch 
            });
        }
    }

    // ============================================
    // POOL DATA AGGREGATION
    // ============================================
    // poolDefs supplies category and key metadata for the rendered cards.
    // snapshotDefs supplies the short_name to public_key link for the snapshot
    // these validators came from, and defaults to poolDefs when both are the
    // same set. The main dashboard render passes latestPoolDefinitions as
    // poolDefs, so it must pass the snapshot's own definitions separately.
    function aggregatePoolData(validators, poolDefs, snapshotDefs) {
        const resolveDefs = snapshotDefs || poolDefs;
        const aggregatedGroups = {};
        const definitionsMap = {};
        const poolsByGroup = {};

        (poolDefs || []).forEach(def => {
            if (!definitionsMap[def.group]) definitionsMap[def.group] = def;
            if (!poolsByGroup[def.group]) poolsByGroup[def.group] = [];
            poolsByGroup[def.group].push(def);
        });

        (validators || []).forEach(validator => {
            const resolved = getResolvedGroups(validator, resolveDefs);
            if (resolved.length === 0) return;

            resolved.forEach(group => {
                const groupName = group.name;

                if (!aggregatedGroups[groupName]) {
                    const def = definitionsMap[groupName] || {};
                    const category = def.category || 'OTHER';
                    aggregatedGroups[groupName] = {
                        name: groupName,
                        category,
                        total_active_lamports: 0,
                        total_activating_lamports: 0,
                        total_deactivating_lamports: 0,
                        total_validator_count: 0,
                        active_validator_count: 0,
                        definition: def,
                        staker_keys: [],
                        withdrawer_keys: []
                    };
                }
                
                const g = aggregatedGroups[groupName];
                g.total_active_lamports += group.active_lamports || 0;
                g.total_activating_lamports += group.activating_lamports || 0;
                g.total_deactivating_lamports += group.deactivating_lamports || 0;
                g.total_validator_count++;
                if (meetsStakeThreshold(group.active_lamports, group.activating_lamports)) {
                    g.active_validator_count++;
                }
            });
        });

        for (const groupName in aggregatedGroups) {
            if (poolsByGroup[groupName]) {
                poolsByGroup[groupName].forEach(pool => {
                    if (pool.type === 'S' && pool.public_key) {
                        aggregatedGroups[groupName].staker_keys.push(pool.public_key);
                    }
                    if (pool.type === 'W' && pool.public_key) {
                        aggregatedGroups[groupName].withdrawer_keys.push(pool.public_key);
                    }
                });
            }
        }
        
        return aggregatedGroups;
    }

    function poolCardHtml(g, sparklineData, highlightEpoch, isStale = false, selEpoch = null) {
        const epochNote = isStale ? `<span class="epoch-inline-note">in epoch ${selEpoch}</span>` : '';
        const excludedGroups = ['OTHER', 'SELF_STAKE', 'ID_STAKE'];

        let keysHtml = '';
        const totalKeys = g.staker_keys.length + g.withdrawer_keys.length;
        if (!excludedGroups.includes(g.name) && totalKeys > 0) {
            let keysContentHtml = '';
            if (g.staker_keys.length > 0) {
                keysContentHtml += `<div class="key-group">
                    <strong>Staker Keys:</strong>
                    ${g.staker_keys.map(k => `<code>${k}</code>`).join('')}
                </div>`;
            }
            if (g.withdrawer_keys.length > 0) {
                keysContentHtml += `<div class="key-group">
                    <strong>Withdrawer Keys:</strong>
                    ${g.withdrawer_keys.map(k => `<code>${k}</code>`).join('')}
                </div>`;
            }
            
            if (totalKeys <= KEY_VISIBILITY_THRESHOLD) {
                keysHtml = `<div class="pool-keys-container">${keysContentHtml}</div>`;
            } else {
                keysHtml = `<div class="pool-keys-container">
                    <button class="pool-keys-toggle" data-key-count="${totalKeys}">
                        <span class="toggle-text">Show ${totalKeys} Keys</span>
                        <i class="fas fa-chevron-down toggle-icon"></i>
                    </button>
                    <div class="pool-keys-list">${keysContentHtml}</div>
                </div>`;
            }
        }

        const chartContainerId = `chart-container-${g.name.replace(/\s+/g, '-')}-${Math.random().toString(36).slice(2,7)}`;
        const chartHtml = sparklineData && sparklineData.length >= 1 ? 
            `<div class="interactive-chart-container" id="${chartContainerId}"></div>` : '';

        const title = cleanText(g.definition.long_name) || g.name;
        let descText = cleanText(g.definition.description);
        const url = cleanText(g.definition.url);
        
        if (g.name === 'OTHER' && !descText) {
            descText = 'Aggregate of all stakes that do not match any defined pool or stakeholder category. ' +
                      'This includes validators that are not captured by other groups rules or keys.';
        }
        
        let detailsHtml = '';
        if (descText || url) {
            detailsHtml = `<div class="pool-details">
                ${descText ? `
                    <div class="desc-wrap" style="--desc-lines:${DESC_LINES}">
                        <p class="desc-text">${descText}</p>
                    </div>
                ` : ''}
                ${url ? `<a href="${url}" target="_blank" rel="noopener noreferrer">
                    Learn more <i class="fas fa-external-link-alt fa-xs"></i>
                </a>` : ''}
            </div>`;
        }
        
        // Block B: render pool logo with data-logo-default so theme switches can
        // swap in {name}_light.{ext} or {name}_dark.{ext} variants without re-rendering.
        // The .card-header-logo wrapper carries the circle styling (size, bg,
        // border); the img inside fills with 12% padding for breathing room.
        // Same img-inside-wrapper pattern as .pool-badge / .stat-icon / donut center.
        const isDarkTheme = document.body.classList.contains('dark-theme-body');
        const resolvedDefault = resolveLogoUrlSync(g.definition.image, isDarkTheme, 96);
        let logoHtml;
        if (g.name === 'OTHER' || !g.definition.image) {
            logoHtml = `<div class="card-header-logo card-header-logo-svg">${g.name === 'OTHER' ? otherIsoImg(96) : ''}${OTHER_GROUP_SVG}</div>`;
        } else {
            logoHtml = `<div class="card-header-logo"><img src="${resolvedDefault}" data-logo-default="${g.definition.image}" data-logo-iso="96" alt="${title} logo"></div>`;
        }
        
        const displayTitle = g.name === 'OTHER' ? 'Other Stakes' : title;
        const includedLabel = g.name === 'OTHER' ? 'Included' : 'Included in Pool';

        if (sparklineData && sparklineData.length >= 1) {
            chartsToRedraw.push({ 
                id: chartContainerId, 
                data: sparklineData, 
                title: 'Active Stake', 
                highlightEpoch 
            });
        }

        return `
            <div class="sp-block sp-group-card sp-pool-card" data-pool-group="${g.name}">
                <div class="card-header" style="cursor: pointer;">
                    ${logoHtml}
                    <span class="pool-name" title="${displayTitle}">${displayTitle}${CV_GO_SVG}</span>
                </div>
                <div class="card-body">
                    <div class="card-main-content">
                        <div class="card-stats">
                            <div class="stat-item">
                                <span class="label">Active Stake${epochNote}</span>
                                <span class="value">${formatNumber(lamportsToSol(g.total_active_lamports), 2)}</span>
                            </div>
                            <div class="stat-item">
                                <span class="label">Active Validators${epochNote}</span>
                                <span class="value">${g.active_validator_count}</span>
                            </div>
                        </div>
                        ${chartHtml}
                        <div class="stake-breakdown">
                            <div class="breakdown-item">
                                <span class="label">
                                    <i class="fas fa-arrow-trend-up icon-activating"></i> 
                                    Activating${epochNote}
                                </span>
                                <span class="value">${formatNumber(lamportsToSol(g.total_activating_lamports), 2)} SOL</span>
                            </div>
                            <div class="breakdown-item">
                                <span class="label">
                                    <i class="fas fa-arrow-trend-down icon-deactivating"></i> 
                                    Deactivating${epochNote}
                                </span>
                                <span class="value">${formatNumber(lamportsToSol(g.total_deactivating_lamports), 2)} SOL</span>
                            </div>
                            <div class="breakdown-item">
                                <span class="label">
                                    <i class="fas fa-sitemap icon-total-validators"></i> 
                                    ${includedLabel}${epochNote}
                                </span>
                                <span class="value">${g.total_validator_count} validators</span>
                            </div>
                        </div>
                    </div>
                    ${detailsHtml}
                    ${keysHtml}
                </div>
            </div>`;
    }

    function orderedCategories(groupsArr, baseOrder) {
        const seen = new Set();
        const order = [];
        
        (baseOrder || []).forEach(cat => {
            if (cat && cat !== 'OTHER' && !seen.has(cat)) { 
                seen.add(cat); 
                order.push(cat); 
            }
        });
        
        const catsInData = Array.from(new Set(groupsArr.map(g => g.category || 'OTHER')));
        catsInData.forEach(cat => {
            if (cat && cat !== 'OTHER' && !seen.has(cat)) { 
                seen.add(cat); 
                order.push(cat); 
            }
        });
        
        if (catsInData.includes('OTHER')) order.push('OTHER');
        
        return order;
    }
    
    function populateGroupsBlock(
        aggregatedData,
        historicDataByPool,
        sortMode = 'stake',
        categoryOrderInput = [],
        highlightEpoch = null,
        isStale = false,
        selEpoch = null
    ) {
        const container = document.getElementById('groups-grid-container');
        chartsToRedraw = chartsToRedraw.filter(c => c.id === 'summary-chart-container');

        if (!aggregatedData || Object.keys(aggregatedData).length === 0) {
            container.className = 'sp-groups-grid';
            container.innerHTML = '<p style="grid-column: 1 / -1; text-align: center;">No pool data available to display.</p>';
            return;
        }

        const groupsArr = Object.values(aggregatedData).filter(g => g.total_validator_count > 0);
        const getSparkData = (gname) => historicDataByPool ? historicDataByPool[gname] : null;

        if (sortMode === 'stake') {
            container.className = 'sp-groups-grid';
            const sorted = groupsArr.sort((a, b) => b.total_active_lamports - a.total_active_lamports);
            container.innerHTML = sorted.map(g => 
                poolCardHtml(g, getSparkData(g.name), highlightEpoch, isStale, selEpoch)
            ).join('');
            initDescriptionCollapsers(container);
            return;
        }

        if (sortMode === 'validators') {
            container.className = 'sp-groups-grid';
            const sorted = groupsArr.sort((a, b) => {
                if (b.active_validator_count !== a.active_validator_count) {
                    return b.active_validator_count - a.active_validator_count;
                }
                return b.total_active_lamports - a.total_active_lamports;
            });
            container.innerHTML = sorted.map(g => 
                poolCardHtml(g, getSparkData(g.name), highlightEpoch, isStale, selEpoch)
            ).join('');
            initDescriptionCollapsers(container);
            return;
        }

        if (sortMode === 'activating') {
            container.className = 'sp-groups-grid';
            const sorted = groupsArr.sort((a, b) => 
                b.total_activating_lamports - a.total_activating_lamports || 
                b.total_active_lamports - a.total_active_lamports
            );
            container.innerHTML = sorted.map(g => 
                poolCardHtml(g, getSparkData(g.name), highlightEpoch, isStale, selEpoch)
            ).join('');
            initDescriptionCollapsers(container);
            return;
        }

        if (sortMode === 'deactivating') {
            container.className = 'sp-groups-grid';
            const sorted = groupsArr.sort((a, b) => 
                b.total_deactivating_lamports - a.total_deactivating_lamports || 
                b.total_active_lamports - a.total_active_lamports
            );
            container.innerHTML = sorted.map(g => 
                poolCardHtml(g, getSparkData(g.name), highlightEpoch, isStale, selEpoch)
            ).join('');
            initDescriptionCollapsers(container);
            return;
        }

        // Category mode
        container.className = '';
        let html = '';
        const catOrder = orderedCategories(groupsArr, categoryOrderInput);
        
        catOrder.forEach(cat => {
            const inCat = groupsArr.filter(g => (g.category || 'OTHER') === cat);
            if (inCat.length === 0) return;
            
            inCat.sort((a, b) => b.total_active_lamports - a.total_active_lamports);
            const title = cat === 'OTHER' ? 'Other' : toTitleCaseKey(cat);
            const meta = `${inCat.length} pool${inCat.length > 1 ? 's' : ''}`;
            
            html += `
                <div class="category-section">
                    <div class="category-header">
                        <div class="title">${title}</div>
                        <div class="meta">${meta}</div>
                    </div>
                    <div class="sp-groups-grid">
                        ${inCat.map(g => 
                            poolCardHtml(g, getSparkData(g.name), highlightEpoch, isStale, selEpoch)
                        ).join('')}
                    </div>
                </div>`;
        });
        
        container.innerHTML = html;
        initDescriptionCollapsers(container);
    }

    // ============================================
    // DESCRIPTION COLLAPSE / EXPAND
    // ============================================
    function initDescriptionCollapsers(root = document) {
        root.querySelectorAll('.pool-details .desc-wrap').forEach(wrap => {
            const text = wrap.querySelector('.desc-text');
            if (!text) return;

            const lines = parseInt(getComputedStyle(wrap).getPropertyValue('--desc-lines')) || 4;

            wrap.classList.add('no-clamp');
            const fullH = Math.ceil(text.getBoundingClientRect().height);
            const lh = parseFloat(getComputedStyle(text).lineHeight) || 20;
            const maxH = Math.ceil(lh * lines);
            wrap.classList.remove('no-clamp');

            const needToggle = fullH > maxH + 1;

            if (needToggle) {
                wrap.classList.add('collapsed');
                wrap.dataset.collapsible = '1';
                wrap.setAttribute('aria-expanded', 'false');
            } else {
                wrap.classList.remove('collapsed');
                wrap.removeAttribute('data-collapsible');
                wrap.setAttribute('aria-expanded', 'true');
            }
        });
    }

    // ============================================
    // INFO NOTES
    // ============================================
    function renderInfoNotes(minStakeSol, isStale, selEpoch, latestEpoch) {
        const stale = isStale
            ? `<span class="stale">
                <i class="fas fa-hourglass-half"></i>
                You are viewing data from&nbsp;<b>epoch ${selEpoch}</b> 
                <b>&nbsp;</b> latest is<b>&nbsp;</b><b>${latestEpoch}</b>
               </span>`
            : '';

        document.getElementById('info-notes-container').innerHTML = `
            <div class="sp-info-container">
                <div class="sp-info-line">
                    <i class="fas fa-info-circle"></i>
                    <div>Validators count as active from <b class="nowrap">${formatNumber(minStakeSol, 1)} SOL</b> of active or activating stake. Pool figures use the stake from that pool.</div>
                </div>
                <div class="sp-info-line">
                    <i class="fas fa-sync-alt"></i>
                    <div>Live data is refreshed continuously throughout the epoch. Complete snapshots are archived several times per epoch and at every epoch boundary.</div>
                </div>
                ${stale}
                <div class="sp-info-line sp-info-version">
                    <i class="fas fa-code-branch"></i>
                    <div>StakeMap v${DASHBOARD_VERSION}</div>
                </div>
            </div>`;

        const pill = document.getElementById('epoch-stale-pill');
        if (pill) pill.style.display = isStale ? 'inline-flex' : 'none';
    }

    // ============================================
    // PHASE 3: LIVE DATA STALENESS BANNER
    // ============================================
    // Driven by the watcher-owned status.json on the R2 data domain. The file
    // carries expected_interval_seconds, so backend cadence changes never
    // require a frontend redeploy. Thresholds: silent under 3x the expected
    // interval (never before 30 min), yellow up to 12x (never before 2 h),
    // red above that or when consecutive_failures >= 3. The floors keep a
    // fast live cadence from making the banner nervous: stake moves at epoch
    // boundaries, so a short delay changes nothing for the reader. Data is always shown regardless; the banner
    // only annotates it. If the status endpoint itself is unreachable, the
    // banner stays hidden - it must never block or degrade the dashboard.
    // Visual debug override: append ?status_debug=yellow|red|ok to the URL.
    const STATUS_POLL_MS = 120 * 1000;
    const STALE_YELLOW_FLOOR_S = 30 * 60;
    const STALE_RED_FLOOR_S = 2 * 60 * 60;

    function formatStatusAge(seconds) {
        if (!isFinite(seconds)) return 'a long time';
        if (seconds < 90 * 60) return Math.round(seconds / 60) + ' min';
        return (Math.round(seconds / 360) / 10) + ' h';
    }

    function renderStalenessBanner(severity, ageSeconds, lastSuccessIso, forced) {
        let el = document.getElementById('cv-staleness-banner');
        if (severity === 'ok') {
            if (el) el.style.display = 'none';
            return;
        }
        if (!el) {
            el = document.createElement('div');
            el.id = 'cv-staleness-banner';
            // Pinned placement: right below the site header and OUTSIDE the
            // tab containers, so the banner is visible on every dashboard tab
            // and survives tab switches. Sticky keeps it at the viewport top
            // when scrolled - the page auto-scrolls to the active tab on
            // load, so a banner buried inside the tab content would simply
            // never be seen without scrolling back up.
            const siteHeader = document.querySelector('header');
            if (siteHeader && siteHeader.parentNode) {
                siteHeader.insertAdjacentElement('afterend', el);
            } else {
                const anchor = document.getElementById('summary-container');
                if (!anchor || !anchor.parentNode) return;
                anchor.parentNode.insertBefore(el, anchor);
            }
        }
        const isYellow = severity === 'yellow';
        // Sit right BELOW the site header, not over it. The header itself is
        // sticky, so its current bottom edge equals its on-screen height and
        // is stable while scrolling; if the header were static and already
        // scrolled away, the offset clamps to 0 and the banner takes the
        // viewport top. Re-measured on every render (every status poll), so
        // window resizes self-correct within two minutes.
        let bannerTopOffset = 0;
        const siteHeaderForOffset = document.querySelector('header');
        if (siteHeaderForOffset) {
            bannerTopOffset = Math.max(0, Math.round(siteHeaderForOffset.getBoundingClientRect().bottom));
        }
        el.style.cssText = 'display:block;position:sticky;top:' + bannerTopOffset + 'px;z-index:60;margin:0;' +
            'padding:10px 16px;font-size:14px;line-height:1.45;font-weight:500;text-align:center;' +
            'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);' +
            (isYellow
                ? 'background:rgba(245,158,11,0.16);border-bottom:1px solid rgba(245,158,11,0.5);color:#d97706;'
                : 'background:rgba(239,68,68,0.16);border-bottom:1px solid rgba(239,68,68,0.55);color:#ef4444;');
        let lastSeen = '';
        if (lastSuccessIso) {
            const t = Date.parse(lastSuccessIso);
            lastSeen = isNaN(t) ? lastSuccessIso : new Date(t).toUTCString();
        }
        el.textContent = isYellow
            ? 'Live data is updating with a delay: last successful check ' + formatStatusAge(ageSeconds) + ' ago. Historical epochs are unaffected.'
            : 'Live data is currently unavailable (RPC provider issues). Showing the last known snapshot' + (lastSeen ? ' from ' + lastSeen : '') + '. Historical epochs are unaffected.';
        if (forced) el.textContent += ' [test view: status_debug is set in the address]';
    }

    async function checkDataStaleness(statusUrl) {
        try {
            const resp = await fetchWithTimeout(statusUrl, { cache: 'no-store' }, 8000);
            if (!resp.ok) throw new Error('status endpoint returned ' + resp.status);
            const st = await resp.json();
            const interval = (st && st.expected_interval_seconds > 0) ? st.expected_interval_seconds : 9000;
            const lastTs = (st && st.last_success_utc) ? Date.parse(st.last_success_utc) : NaN;
            const fails = (st && typeof st.consecutive_failures === 'number') ? st.consecutive_failures : 0;
            const age = isNaN(lastTs) ? Infinity : Math.max(0, (Date.now() - lastTs) / 1000);
            let severity = 'ok';
            if (age > Math.max(interval * 12, STALE_RED_FLOOR_S) || fails >= 3) severity = 'red';
            else if (age > Math.max(interval * 3, STALE_YELLOW_FLOOR_S)) severity = 'yellow';
            const dbg = new URLSearchParams(window.location.search).get('status_debug');
            if (dbg === 'yellow' || dbg === 'red' || dbg === 'ok') severity = dbg;
            renderStalenessBanner(severity, age, st && st.last_success_utc, dbg === severity);
            subheaderPlace();
        } catch (_) {
            /* status endpoint unreachable: stay silent, never block the dashboard */
        }
    }

    let stalenessMonitorStarted = false;
    function initStalenessMonitor(manifest) {
        if (stalenessMonitorStarted) return;
        stalenessMonitorStarted = true;
        const statusUrl = dataApiUrl((manifest && manifest.status_url) || STATUS_URL_DEFAULT);
        checkDataStaleness(statusUrl);
        setInterval(function () { checkDataStaleness(statusUrl); }, STATUS_POLL_MS);
    }

    // ============================================
    // DATA LOADING
    // ============================================
    function updateLoaderProgress(percentage, text = "Loading data...") {
        const progressText = document.getElementById('loader-progress-text');
        const loaderText = document.querySelector('#sofzp-loader-overlay .loader-text');

        if (progressText) {
            progressText.textContent = `${Math.round(percentage)}%`;
        }
        if (loaderText) {
            const currentText = loaderText.childNodes[0]?.nodeValue || '';
            if (currentText.trim() !== text) {
                loaderText.childNodes[0].nodeValue = text + " ";
            }
        }
    }

    // ============================================
    // BLOCK E PHASE 3: AGGREGATED HISTORY SUPPORT
    // ============================================
    // Frontend reads stakepool-data/{cluster}/aggregated-history.json instead of
    // 130+ per-epoch files. Aggregated entries are converted to pseudo-snapshots
    // matching the {metadata, validators[], pool_definitions[]} shape so the rest
    // of the dashboard works unchanged. Full per-epoch JSON is lazy-loaded only
    // when user opens an old epoch on a pool detail page (validators table needs
    // real per-validator data).
    
    // In-session cache for lazy-loaded full epoch snapshots. Keyed by epoch number.
    // Saves bandwidth when user switches between previously-visited epochs.
    const fullEpochCache = new Map();
    
    // Convert one aggregated entry into a pseudo-snapshot matching the shape the
    // rest of the dashboard expects. Three independent invariants are preserved:
    //   1. Sum of validators[].totals.total_active_lamports == totals.active_lamports
    //   2. Sum of validators[].aggregations.by_group[name] == pool_stats[name]
    //   3. Number of validators[] entries with aggregations.by_group[name] == pool_stats[name].validator_count
    // Achieved by emitting one "totals carrier" validator with the epoch totals
    // and N pseudo-validators per pool group (each carrying 1/N of the pool's stake).
    function synthesizeSnapshot(epochEntry) {
        const totals = epochEntry.totals || { active_lamports: 0, validator_count: 0 };
        const poolStats = epochEntry.pool_stats || {};
        const validators = [];
        
        // (1) Single "totals carrier" - feeds overallHistoricStake.
        // Has totals.total_active_lamports = epoch total, no by_group entries.
        validators.push({
            __pseudo: 'totals_carrier',
            totals: {
                total_active_lamports: totals.active_lamports || 0,
                total_activating_lamports: 0,
                total_deactivating_lamports: 0
            },
            aggregations: { by_group: [] }
        });
        
        // (2) Per-pool pseudo-validators. For each pool with N validators,
        // emit N entries each carrying 1/N of the pool's stake. Their totals
        // are zero so they don't affect overallHistoricStake.
        for (const groupName in poolStats) {
            const stats = poolStats[groupName];
            const n = Math.max(1, stats.validator_count | 0);
            const activeShare = Math.floor((stats.active_lamports || 0) / n);
            const activatingShare = Math.floor((stats.activating_lamports || 0) / n);
            const deactivatingShare = Math.floor((stats.deactivating_lamports || 0) / n);
            
            for (let i = 0; i < n; i++) {
                validators.push({
                    __pseudo: 'pool_carrier',
                    __pool_group: groupName,
                    totals: {
                        total_active_lamports: 0,
                        total_activating_lamports: 0,
                        total_deactivating_lamports: 0
                    },
                    aggregations: {
                        by_group: [{
                            name: groupName,
                            active_lamports: activeShare,
                            activating_lamports: activatingShare,
                            deactivating_lamports: deactivatingShare
                        }]
                    }
                });
            }
        }
        
        return {
            __aggregated: true,
            __snapshot_source_url: epochEntry.snapshot_source_url || '',
            metadata: {
                epoch: epochEntry.epoch,
                timestamp_utc: epochEntry.snapshot_timestamp_utc,
                epoch_completed_percent: epochEntry.epoch_completed_percent,
                cluster_name: 'mainnet-beta'
            },
            pool_definitions: epochEntry.pool_definitions || [],
            validators: validators
        };
    }
    
    // Lazy-load the full per-epoch snapshot for a given epoch. Used when user
    // opens an old epoch on a pool detail page - the validators table needs real
    // per-validator stake data which pseudo-snapshots cannot provide.
    // Returns the full snapshot or null on failure.
    async function loadEpochFull(epoch) {
        // Check in-session cache first
        if (fullEpochCache.has(epoch)) {
            return fullEpochCache.get(epoch);
        }
        
        // Get source URL from epochMap pseudo-entry
        const epochData = epochMap.get(epoch);
        if (!epochData) {
            console.error(`No epoch entry found for ${epoch}`);
            return null;
        }
        
        // If already a full snapshot (not pseudo), return as-is
        if (!epochData.__aggregated) {
            return epochData;
        }
        
        const sourceUrl = epochData.__snapshot_source_url;
        if (!sourceUrl) {
            console.error(`No snapshot_source_url for epoch ${epoch}`);
            return null;
        }
        
        try {
            console.log('[stake-dashboard] Loading full snapshot for epoch ' + epoch);
            const response = await fetchWithMirror(sourceUrl, { cache: "default" });
            if (!response.ok) {
                throw new Error(`Failed to load full snapshot: ${response.status}`);
            }
            const fullData = await response.json();
            fullEpochCache.set(epoch, fullData);
            // Also replace pseudo entry in epochMap so future reads hit full data
            epochMap.set(epoch, fullData);
            // Update allEpochData index too
            const idx = allEpochData.findIndex(d => d.metadata && d.metadata.epoch === epoch);
            if (idx >= 0) allEpochData[idx] = fullData;
            return fullData;
        } catch (err) {
            console.error(`Lazy load failed for epoch ${epoch}:`, err);
            return null;
        }
    }
    
    // Show/hide a small loader overlay for lazy snapshot loads.
    // Targets the pool detail content area to avoid covering the whole page.
    function showEpochLoader(message = 'Loading epoch data...') {
        let loader = document.getElementById('pool-epoch-loader');
        if (!loader) {
            loader = document.createElement('div');
            loader.id = 'pool-epoch-loader';
            loader.className = 'pool-epoch-loader';
            loader.innerHTML = `
                <div class="pool-epoch-loader-inner">
                    <i class="fas fa-spinner fa-spin"></i>
                    <span class="pool-epoch-loader-text"></span>
                </div>
            `;
            document.body.appendChild(loader);
        }
        loader.querySelector('.pool-epoch-loader-text').textContent = message;
        loader.style.display = 'flex';
    }
    
    function hideEpochLoader() {
        const loader = document.getElementById('pool-epoch-loader');
        if (loader) loader.style.display = 'none';
    }
    
    // Phase 3: the latest snapshot is served from the R2 live endpoint first
    // (fresher, off-git, updated every published run), with a silent fallback
    // to the GitHub file from the manifest. ANY live failure - network error,
    // timeout, non-200, malformed body - falls back; only a failure of BOTH
    // sources propagates to the caller.
    async function fetchLatestSnapshot(manifest) {
        const liveUrl = dataApiUrl(manifest.live_data_url || LIVE_DATA_URL_DEFAULT);
        validatorsBaseUrl = liveUrl.replace(/[^/]*$/, 'validators/');
        const githubUrl = manifest.latest_data_url;
        try {
            const live = await fetchJsonWithCache(liveUrl, 'live', LIVE_FETCH_TIMEOUT_MS);
            if (live && live.metadata && Array.isArray(live.validators) && live.validators.length > 0) {
                console.log('[stake-dashboard] latest snapshot source: R2 live');
                return live;
            }
            console.warn('[stake-dashboard] live.json looks malformed, falling back to GitHub');
        } catch (liveErr) {
            console.warn('[stake-dashboard] live.json unavailable, falling back to GitHub:', liveErr && liveErr.message);
        }
        const fromGithub = await fetchJsonWithCache(githubUrl, 'latest');
        console.log('[stake-dashboard] latest snapshot source: GitHub');
        return fromGithub;
    }

    // Try to load via aggregated-history.json. Returns the {latestData, historicData, epochs}
    // shape on success, or null if aggregated path is unavailable (caller falls back to old path).
    async function tryFetchFromAggregated(manifest) {
        const aggregatedUrl = manifest.aggregated_history_url;
        const latestUrl = manifest.latest_data_url;
        
        if (!aggregatedUrl || !latestUrl) {
            return null; // Old manifest - caller falls back to historic_data_urls
        }
        
        updateLoaderProgress(10, "Loading aggregated history...");
        
        console.log('[stake-dashboard] Loading aggregated history and latest snapshot in parallel');
        // Load aggregated and latest in parallel. Both go through the
        // sessionStorage cache so re-entering the dashboard from the site
        // within the cache TTL renders nearly instantly.
        let aggregated, latestData;
        try {
            const [aggResult, latestResult] = await Promise.all([
                fetchJsonWithCache(aggregatedUrl, 'aggregated'),
                fetchLatestSnapshot(manifest)
            ]);
            aggregated = aggResult;
            latestData = latestResult;
        } catch (err) {
            // Aggregated history fetch failure is recoverable - caller
            // falls back to historic_data_urls. Latest fetch failure is not
            // recoverable, but caller's outer try/catch handles it.
            if (err && err.message && err.message.indexOf('aggregated') >= 0) {
                console.warn('Aggregated history fetch failed, will fall back to per-epoch URLs');
                return null;
            }
            throw err;
        }
        
        updateLoaderProgress(50, "Processing aggregated data...");
        
        if (!aggregated.epochs || !Array.isArray(aggregated.epochs)) {
            console.warn('Aggregated history has invalid structure, falling back');
            return null;
        }
        
        updateLoaderProgress(75, "Building dashboard...");
        
        // Convert each aggregated entry to pseudo-snapshot
        const pseudoSnapshots = aggregated.epochs.map(synthesizeSnapshot);
        
        // Combine with the latest full snapshot. If the latest epoch is already
        // present in aggregated (recently finalized), prefer the full snapshot.
        const latestEpoch = latestData.metadata.epoch;
        const combined = pseudoSnapshots.filter(p => p.metadata.epoch !== latestEpoch);
        combined.push(latestData);
        combined.sort((a, b) => a.metadata.epoch - b.metadata.epoch);
        
        const epochMapLocal = new Map(combined.map(d => [d.metadata.epoch, d]));
        const epochs = Array.from(epochMapLocal.keys()).sort((a, b) => a - b);
        const latest = epochs[epochs.length - 1];

        // The historic series is built before latestPoolDefinitions is assigned
        // further down the init path, so the canonical key map has to be seeded
        // here or every past epoch would be aggregated with raw group names.
        buildCanonicalKeyGroup(latestData.pool_definitions);
        
        // Build historic series. aggregatePoolData and the .totals reduction
        // both work correctly on pseudo-snapshots by design.
        const historicDataByPool = {};
        const overallHistoricStake = [];
        
        combined.forEach(data => {
            const epoch = data.metadata.epoch;
            const totalEpochStake = data.validators.reduce((sum, v) =>
                sum + (v && v.totals ? (v.totals.total_active_lamports || 0) : 0), 0);
            overallHistoricStake.push({
                epoch,
                value: lamportsToSol(totalEpochStake)
            });
            
            const aggregatedForEpoch = aggregatePoolData(data.validators, data.pool_definitions);
            for (const groupName in aggregatedForEpoch) {
                if (!historicDataByPool[groupName]) {
                    historicDataByPool[groupName] = [];
                }
                historicDataByPool[groupName].push({
                    epoch,
                    value: lamportsToSol(aggregatedForEpoch[groupName].total_active_lamports)
                });
            }
        });
        
        allEpochData = combined;
        epochMap = epochMapLocal;
        latestEpochNumber = latest;
        
        updateLoaderProgress(100, "Done");
        
        return {
            latestData: epochMap.get(latestEpochNumber),
            historicData: {
                overall: overallHistoricStake,
                byPool: historicDataByPool
            },
            epochs
        };
    }
    
    async function fetchAllFromManifest() {
        try {
            console.log('[stake-dashboard] Fetching manifest from: ' + MANIFEST_URL);
            const manifest = await fetchJsonWithCache(MANIFEST_URL, 'manifest', MANIFEST_TIMEOUT_MS);

            // Phase 3: start the staleness monitor as soon as the manifest is
            // known (it may carry a custom status_url).
            initStalenessMonitor(manifest);

            // Block E Phase 3: try aggregated path first. Returns null if manifest
            // doesn't have aggregated_history_url (legacy) or fetch failed - then
            // we fall through to the legacy historic_data_urls path below.
            try {
                const aggregatedResult = await tryFetchFromAggregated(manifest);
                if (aggregatedResult) {
                    return aggregatedResult;
                }
            } catch (aggErr) {
                console.warn('Aggregated path errored, falling back to legacy:', aggErr);
            }

            const urls = manifest.historic_data_urls || [];
            if (urls.length === 0) {
                throw new Error('No historic data URLs found in manifest.');
            }

            let loadedCount = 0;
            const totalToLoad = urls.length;
            updateLoaderProgress(0);

            const fetches = urls.map(url =>
                fetchWithTimeout(url, { cache: "default" })
                .then(res => {
                    if (!res.ok) return null;
                    loadedCount++;
                    updateLoaderProgress((loadedCount / totalToLoad) * 100);
                    return res.json();
                })
                .catch(() => null)
            );

            const results = await Promise.allSettled(fetches);
            updateLoaderProgress(100, "Processing data...");

            const valid = results
                .filter(r => r.status === 'fulfilled' && r.value)
                .map(r => r.value)
                .sort((a, b) => a.metadata.epoch - b.metadata.epoch);
                
            if (valid.length === 0) {
                throw new Error('No valid historic data could be fetched from manifest URLs.');
            }

            const epochMapLocal = new Map(valid.map(d => [d.metadata.epoch, d]));
            const epochs = Array.from(epochMapLocal.keys()).sort((a, b) => a - b);
            const latest = epochs[epochs.length - 1];

            // Same reason as in the aggregated path: seed the canonical key map
            // from the newest snapshot before aggregating any past epoch.
            buildCanonicalKeyGroup((epochMapLocal.get(latest) || {}).pool_definitions);

            const historicDataByPool = {};
            const overallHistoricStake = [];
            
            valid.forEach(data => {
                const epoch = data.metadata.epoch;
                const totalEpochStake = data.validators.reduce((sum, v) => 
                    sum + (v && v.totals ? (v.totals.total_active_lamports || 0) : 0), 0
                );
                overallHistoricStake.push({ 
                    epoch, 
                    value: lamportsToSol(totalEpochStake) 
                });
                
                const aggregatedForEpoch = aggregatePoolData(data.validators, data.pool_definitions);
                for (const groupName in aggregatedForEpoch) {
                    if (!historicDataByPool[groupName]) {
                        historicDataByPool[groupName] = [];
                    }
                    historicDataByPool[groupName].push({ 
                        epoch, 
                        value: lamportsToSol(aggregatedForEpoch[groupName].total_active_lamports) 
                    });
                }
            });

            allEpochData = valid;
            epochMap = epochMapLocal;
            latestEpochNumber = latest;

            return { 
                latestData: epochMap.get(latestEpochNumber), 
                historicData: { 
                    overall: overallHistoricStake, 
                    byPool: historicDataByPool 
                }, 
                epochs 
            };
        } catch (error) {
            console.error("Critical error fetching manifest data, falling back:", error);
            
            // Even on the catastrophic fallback path the staleness monitor is
            // useful: a red banner over epoch-820 data is exactly the honest
            // picture. Defaults are used since the manifest is unavailable.
            initStalenessMonitor(null);

            try {
                console.log('[stake-dashboard] Trying fallback URL: ' + FALLBACK_JSON_URL);
                const response = await fetchWithTimeout(FALLBACK_JSON_URL, { cache: "default" });
                if (!response.ok) {
                    throw new Error(`Fallback fetch failed: ${response.status}`);
                }
                const latestData = await response.json();
                
                allEpochData = [latestData];
                epochMap = new Map([[latestData.metadata.epoch, latestData]]);
                latestEpochNumber = latestData.metadata.epoch;

                buildCanonicalKeyGroup(latestData.pool_definitions);

                const totalEpochStake = latestData.validators.reduce((sum, v) => 
                    sum + (v && v.totals ? (v.totals.total_active_lamports || 0) : 0), 0
                );
                const overallHistoricStake = [{ 
                    epoch: latestData.metadata.epoch, 
                    value: lamportsToSol(totalEpochStake) 
                }];
                
                const aggregatedForEpoch = aggregatePoolData(latestData.validators, latestData.pool_definitions);
                const historicDataByPool = {};
                for (const groupName in aggregatedForEpoch) {
                    historicDataByPool[groupName] = [{ 
                        epoch: latestData.metadata.epoch, 
                        value: lamportsToSol(aggregatedForEpoch[groupName].total_active_lamports) 
                    }];
                }
                
                return { 
                    latestData, 
                    historicData: { 
                        overall: overallHistoricStake, 
                        byPool: historicDataByPool 
                    }, 
                    epochs: [latestData.metadata.epoch] 
                };
            } catch (fallbackError) {
                console.error("Fallback fetch also failed:", fallbackError);
                return null;
            }
        }
    }

    // ============================================
    // TAB SWITCHING
    // ============================================
    function buildCategoryOrderFrom(defs) {
        const ord = [];
        const seen = new Set();
        (defs || []).forEach(def => {
            if (def.category && !seen.has(def.category)) { 
                seen.add(def.category); 
                ord.push(def.category); 
            }
        });
        return ord.filter(c => c !== 'OTHER');
    }
    
    function setActiveSortButton(mode) {
        document.querySelectorAll('#sorting-bar .sort-btn').forEach(b => 
            b.classList.remove('active')
        );
        const btn = document.querySelector(`#sorting-bar .sort-btn[data-sort="${mode}"]`);
        if (btn) btn.classList.add('active');
    }
    
    // Maps tab id to its label as shown in breadcrumbs.
    const tabToBreadcrumb = {
        'pools': 'Pools',
        'validators': 'Validators', 
        'docs': 'Documentation'
    };
    
	function activateTab(targetTab) {
		requestAnimationFrame(() => subheaderShowTab(targetTab));
		document.querySelectorAll('.sp-tab-link').forEach(item => 
			item.classList.remove('active')
		);
		document.querySelectorAll('.sp-tab-content').forEach(item => 
			item.classList.remove('active')
		);
		
		const link = document.querySelector(`.sp-tab-link[data-tab="${targetTab}"]`);
		const content = document.getElementById(`tab-content-${targetTab}`);
		
		if (link && content) { 
			link.classList.add('active'); 
			content.classList.add('active'); 
		}
		
		// Bug 10 fix: re-initialize description collapsers when switching to Pools tab.
		// Root cause: initDescriptionCollapsers uses getBoundingClientRect to measure
		// text height; when the tab is display:none at first render, height = 0, and
		// the collapser cannot detect overflow - descriptions stay uncollapsed forever.
		// Re-running after the tab becomes visible measures real heights correctly.
		if (targetTab === 'pools') {
			// Use rAF so the browser has applied the display change before measuring
			requestAnimationFrame(() => {
				const poolsContainer = document.getElementById('groups-grid-container');
				if (poolsContainer) initDescriptionCollapsers(poolsContainer);
			});
		}
		
		// Оновлюємо breadcrumbs
		const breadcrumbSection = document.getElementById('breadcrumb-section');
		if (breadcrumbSection) {
			breadcrumbSection.textContent = tabToBreadcrumb[targetTab] || 'Pools';
			breadcrumbSection.dataset.tab = targetTab;
		}
		
		// Очищаємо пошук валідаторів при переході на іншу вкладку
		if (targetTab !== 'validators' && searchQuery) {
			window.clearValidatorSearch();
		}
		
		const epochSel = document.getElementById('epoch-select');
		let epochForUrl = null;
		if (epochSel && epochSel.value) {
			epochForUrl = (Number(epochSel.value) === Number(latestEpochNumber)) ? 'latest' : epochSel.value;
		}
	
		setUrlState({ 
			tab: targetTab, 
			sort: targetTab === 'pools' ? currentSortMode : null, 
			epoch: epochForUrl,
        	search: searchQuery || null 
		});
		
		if (targetTab === 'pools') {
			requestAnimationFrame(() => drawAllChartsNow());
			setTimeout(drawAllChartsNow, 0);
		}
		
        const tabsNav = document.querySelector('.sp-tabs-nav');
        if (tabsNav) {
            tabsNav.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
	}

    // ============================================
    // CHART FUNCTIONS (ВИКЛИК)
    // ============================================
    function drawAllChartsNow() {
        chartsToRedraw.forEach(chart => {
            const container = document.getElementById(chart.id);
            if (container) {
                renderInteractiveChart(container, chart.data, chart.title, chart.highlightEpoch ?? null);
            }
        });
    }
    
    const redrawAllChartsDebounced = debounce(drawAllChartsNow, 200);

    // ============================================
    // ФУНКЦІЯ ПЕРЕКЛЮЧЕННЯ ЕПОХ
    // ============================================
    
    // Block E Phase 3: async wrapper that ensures full snapshot data is loaded
    // before switching the main dashboard view to a historic epoch. Pseudo
    // snapshots from aggregated-history.json are sufficient for building
    // historic series (sparklines, charts) but lack the per-validator detail
    // that the main view (pool cards, validators list, top stats) requires.
    // For latest epoch this is a no-op since latest is always full.
    async function switchToEpochWithLazyLoad(epochNum, historicData) {
        const numKey = Number(epochNum);
        const entry = epochMap.get(numKey);
        if (entry && entry.__aggregated) {
            showEpochLoader(`Loading epoch ${numKey}...`);
            try {
                await loadEpochFull(numKey);
            } finally {
                hideEpochLoader();
            }
        }
        switchToEpoch(epochNum, historicData);
    }

    function switchToEpoch(epochNum, historicData) {
        const data = epochMap.get(Number(epochNum));
        if (!data) return;
        mainRenderedEpoch = Number(epochNum);

        categoryOrder = buildCategoryOrderFrom(latestPoolDefinitions);

        chartsToRedraw = [];
        const isStale = Number(epochNum) !== Number(latestEpochNumber);
        const highlightEpoch = isStale ? Number(epochNum) : null;

        populateSummaryBlock(data, historicData ? historicData.overall : null, highlightEpoch, isStale);

        const minStakeSol = lamportsToSol(MIN_ACTIVE_STAKE);
        renderInfoNotes(minStakeSol, isStale, epochNum, latestEpochNumber);

        // ⭐ ВИПРАВЛЕННЯ ЛОГІКИ СОРТУВАННЯ
        // 1. Спочатку аналізуємо пошуковий запит
        analyzeSearchQuery(searchQuery);
        // 2. Ініціалізуємо дані валідаторів (фільтрація + сортування відбудеться всередині)
        initValidatorsData(data.validators, isStale, epochNum, data.pool_definitions, data.script_info);
        requestAnimationFrame(subheaderShowCurrentTab);

        const aggregatedPools = aggregatePoolData(data.validators, latestPoolDefinitions, data.pool_definitions);
        populateGroupsBlock(
            aggregatedPools, 
            historicData ? historicData.byPool : null, 
            currentSortMode, 
            categoryOrder, 
            highlightEpoch, 
            isStale, 
            epochNum
        );

        requestAnimationFrame(() => drawAllChartsNow());
        setTimeout(drawAllChartsNow, 0);
    }

    // ============================================
    // VALIDATOR PAGE (v2.4.0): ?validator=<vote>
    // ============================================
    // One validator across every pool it ever had. History comes from the
    // per-validator file on R2 (finalized epochs only); the current epoch
    // comes from the live snapshot already in memory. Past epochs never load
    // the full snapshots, so stepping through epochs is instant.
    const VALIDATOR_FILE_TIMEOUT_MS = 15000;
    const META_FIRST_EPOCH = 1042;      // commission, version, delinquency are recorded from here
    const CREDITS_FIRST_EPOCH = 1044;   // vote credits per epoch are recorded from here
    const DATASET_FIRST_EPOCH = 820;
    const CHANGES_VISIBLE = 15;
    let validatorsBaseUrl = LIVE_DATA_URL_DEFAULT.replace(/[^/]*$/, 'validators/');
    // Epoch the main view was last rendered for: returning to it re-renders
    // only when the URL asks for a different epoch.
    let mainRenderedEpoch = null;
    // The pool page and the main view live inside main(); it registers them here.
    let cvShowPool = null;
    let cvShowMain = null;
    let cvMainScrollY = null;
    let cvVd = null;        // model of the open validator page
    let cvVdSeq = 0;        // drops answers that arrive for a page already left
    // The pools block opens as a table; cards are one click away and the choice is kept.
    let cvSourcesView = safeStorage.getItem('validatorSourcesView') === 'cards' ? 'cards' : 'table';
    let cvSort = { key: 'active', dir: 'desc' };   // one order for the table and the cards
    let cvShowPastPools = safeStorage.getItem('validatorShowPastPools') === '1';
    let cvPoolFilter = null;    // pool picked in the donut (or CV_THIN_KEY for the pools under 1%)
    let cvCardOrder = null;     // { names, epoch }: the order the cards keep while only the epoch changes
    let cvBarKey = null;        // sort button lit in the bar right now (none while kept cards match no order)
    let cvIndexByVote = null;   // vote -> row of the validators index
    let validatorsListEpoch = NaN;   // epoch of the validators list on screen
    let cvNowNameMap = null;    // vote -> current name (validators index)
    let cvAuxChart = safeStorage.getItem('validatorAuxChart') === 'rank' ? 'rank' : 'accounts';
    let cvIndexData = null;     // the validators index once it has loaded
    let cvAliasMap = null;      // vote -> former names
    let validatorsAgeAsc = false;
    let validatorsHasAge = false;
    let cvChangesExpanded = false;
    let cvChartSeq = 0;
    let cvIndexPromise = null;
    let cvLiveRanks = null;
    let cvLiveRanksFor = null;
    const cvShardCache = new Map();

    function cvFetchJsonState(url) {
        return fetchWithTimeout(url, {}, VALIDATOR_FILE_TIMEOUT_MS).then(res => {
            if (res.status === 404) return { state: 'missing', data: null };
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json().then(data => ({ state: 'ok', data }));
        });
    }
    // One history file per validator, kept for the session. A failed download
    // is not cached, so the next visit tries again.
    function loadValidatorShard(vote) {
        if (cvShardCache.has(vote)) return cvShardCache.get(vote);
        const p = cvFetchJsonState(validatorsBaseUrl + encodeURIComponent(vote) + '.json').catch(err => {
            console.warn('[stake-dashboard] validator history unavailable:', err && err.message);
            cvShardCache.delete(vote);
            return { state: 'error', data: null };
        });
        cvShardCache.set(vote, p);
        return p;
    }
    // Every validator seen since epoch 820 (active or gone). Loaded on demand.
    function loadValidatorsIndex() {
        if (!cvIndexPromise) {
            cvIndexPromise = cvFetchJsonState(validatorsBaseUrl + 'index.json')
                .then(r => {
                    const data = (r.state === 'ok' && r.data && Array.isArray(r.data.validators)) ? r.data : null;
                    if (data) {
                        cvIndexData = data;
                        cvAliasMap = new Map();
                        cvNowNameMap = new Map();
                        cvIndexByVote = new Map();
                        data.validators.forEach(row => {
                            cvIndexByVote.set(row.vote, row);
                            cvNowNameMap.set(row.vote, String(row.name || '').trim());
                            if (Array.isArray(row.aliases) && row.aliases.length) cvAliasMap.set(row.vote, row.aliases);
                        });
                    }
                    return data;
                })
                .catch(err => {
                    console.warn('[stake-dashboard] validators index unavailable:', err && err.message);
                    cvIndexPromise = null;
                    return null;
                });
        }
        return cvIndexPromise;
    }
    function cvLiveSnapshot() {
        const snap = epochMap.get(Number(latestEpochNumber));
        return snap && !snap.__aggregated && Array.isArray(snap.validators) ? snap : null;
    }
    function cvFindLiveRow(key) {
        const snap = cvLiveSnapshot();
        if (!snap) return null;
        return snap.validators.find(v => v.info && (v.info.vote_pubkey === key || v.info.identity_pubkey === key)) || null;
    }
    // Rank by active stake in the live snapshot (1 = largest), the same
    // measure as stake_rank in the history files.
    function cvLiveRank(vote) {
        const snap = cvLiveSnapshot();
        if (!snap) return null;
        if (cvLiveRanksFor !== snap) {
            cvLiveRanks = new Map();
            snap.validators.slice()
                .sort((a, b) => ((b.totals && b.totals.total_active_lamports) || 0) - ((a.totals && a.totals.total_active_lamports) || 0))
                .forEach((v, i) => { if (v.info) cvLiveRanks.set(v.info.vote_pubkey, i + 1); });
            cvLiveRanksFor = snap;
        }
        return cvLiveRanks.get(vote) || null;
    }
    // Compact meta of a history file -> the shape of validators[].meta, so
    // the same chips render for the live epoch and for past epochs.
    function cvMetaFromShard(m) {
        if (!m) return null;
        return {
            commission: m.commission,
            commission_bps: m.commission_bps,
            version: m.version,
            client: m.client,
            delinquent: m.delinquent,
            epoch_credits: typeof m.credits === 'number' ? m.credits : null,
            jito: m.jito ? {
                mev_commission_bps: typeof m.mev_bps === 'number' ? m.mev_bps : null,
                priority_fee_commission_bps: typeof m.pf_bps === 'number' ? m.pf_bps : null,
                running_jito: true,
                running_bam: m.bam === true
            } : null
        };
    }
    function cvBuildModel(vote, liveRow, shardRes, indexRow) {
        const shard = shardRes && shardRes.state === 'ok' ? shardRes.data : null;
        const snap = cvLiveSnapshot();
        const info = liveRow ? (liveRow.info || {}) : (cvFindLoadedInfo(vote) || {});
        const epochs = [];
        if (shard && Array.isArray(shard.epochs)) {
            shard.epochs.forEach(e => {
                if (!e || typeof e.epoch !== 'number') return;
                const groups = Object.keys(e.groups || {}).map(name => {
                    const g = e.groups[name] || [];
                    return { name: nameRemap.get(name) || name, active: g[0] || 0, activating: g[1] || 0,
                        deactivating: g[2] || 0, count: null };
                });
                epochs.push({
                    epoch: e.epoch, ts: e.ts || null, active: e.active || 0, activating: e.activating || 0,
                    deactivating: e.deactivating || 0, accounts: typeof e.accounts === 'number' ? e.accounts : null,
                    rank: typeof e.stake_rank === 'number' ? e.stake_rank : null, groups,
                    meta: cvMetaFromShard(e.meta), scriptInfo: { jito_metadata: { status: 'ok' } }, isLive: false
                });
            });
        }
        if (liveRow && snap) {
            const liveEpoch = Number(latestEpochNumber);
            const t = liveRow.totals || {};
            const liveEntry = {
                epoch: liveEpoch, ts: snap.metadata ? snap.metadata.timestamp_utc : null,
                active: t.total_active_lamports || 0, activating: t.total_activating_lamports || 0,
                deactivating: t.total_deactivating_lamports || 0,
                accounts: typeof t.total_stake_accounts === 'number' ? t.total_stake_accounts : null,
                rank: cvLiveRank(vote),
                groups: getResolvedGroups(liveRow, snap.pool_definitions).map(g => ({
                    name: g.name, active: g.active_lamports, activating: g.activating_lamports,
                    deactivating: g.deactivating_lamports, count: g.count || 0
                })),
                meta: liveRow.meta || null, scriptInfo: snap.script_info || null, isLive: true
            };
            const at = epochs.findIndex(e => e.epoch === liveEpoch);
            if (at >= 0) epochs[at] = liveEntry; else epochs.push(liveEntry);
        }
        epochs.sort((a, b) => a.epoch - b.epoch);
        // One colour per staker, given in the order the stakers first appear
        // in the history (by name inside an epoch): later epochs only add.
        const poolColors = new Map();
        epochs.forEach(e => e.groups.slice().sort((a, b) => (a.name < b.name ? -1 : (a.name > b.name ? 1 : 0))).forEach(g => {
            if (g.name === 'OTHER' || poolColors.has(g.name) || !(g.active > 0 || g.activating > 0)) return;
            poolColors.set(g.name, cvPaletteColor(poolColors.size));
        }));
        const rawName = String((liveRow ? info.name : (shard ? shard.name : (indexRow ? indexRow.name : ''))) || '').trim();
        const realName = hasRealName(rawName);
        const identity = String((liveRow ? info.identity_pubkey : (shard ? shard.identity : (indexRow ? indexRow.identity : ''))) || '');
        // Vote account age: the registry value travels in the live row, in the
        // history file and in the index; the first one present is the base.
        let age = null;
        const reg = snap && snap.script_info ? snap.script_info.validator_age_registry : null;
        const ageSrc = [liveRow ? liveRow.meta : null, shard, indexRow].find(s => s && typeof s.validator_age === 'number');
        if (ageSrc) {
            age = { value: ageSrc.validator_age, epoch: Number(ageSrc.validator_age_epoch),
                isMin: ageSrc.validator_age_is_min === true };
        }
        return {
            vote, identity, rawName, realName,
            displayName: realName ? rawName : shortenPubkey(rawName || vote),
            iconUrl: isValidHttpUrl(info.icon_url) ? info.icon_url : '',
            website: isValidHttpUrl(info.website) ? info.website : '',
            details: cleanText(info.details || '').trim(),
            nameChanges: shard && Array.isArray(shard.name_changes) ? shard.name_changes : [],
            identityChanges: shard && Array.isArray(shard.identity_changes) ? shard.identity_changes : [],
            isActive: !!liveRow,
            epochs,
            poolColors,
            lastEpoch: epochs.length ? epochs[epochs.length - 1].epoch : null,
            historyState: shard ? 'ok' : (shardRes ? shardRes.state : 'loading'),
            age,
            ageUnavailable: !age && !!liveRow && !!reg && reg.status !== 'ok',
            selectedEpoch: null
        };
    }
    // Did the validator vote in this finalized epoch? Credits where the files
    // have them (1044+), the delinquency flag for 1042-1043, presence with
    // stake before that.
    function cvVotedIn(entry) {
        if (entry.epoch >= CREDITS_FIRST_EPOCH && entry.meta && typeof entry.meta.epoch_credits === 'number') {
            return entry.meta.epoch_credits > 0;
        }
        if (entry.epoch >= META_FIRST_EPOCH && entry.meta) return entry.meta.delinquent === false;
        return true;
    }
    // Vote account age as of an epoch of the page: { value, isMin } or null.
    // Current epoch: registry value + 1 once the validator has credits in it.
    // Past epoch: the registry value minus the voted epochs after it.
    function cvAgeAt(m, entry) {
        if (!m.age || !entry || !isFinite(m.age.epoch)) return null;
        let value = m.age.value;
        if (entry.isLive) {
            if (entry.meta && entry.meta.epoch_credits > 0) value += 1;
        } else if (entry.epoch < m.age.epoch) {
            m.epochs.forEach(e => {
                if (!e.isLive && e.epoch > entry.epoch && e.epoch <= m.age.epoch && cvVotedIn(e)) value -= 1;
            });
        }
        return { value: Math.max(0, value), isMin: m.age.isMin };
    }
    function cvAgeNow(m) {
        if (!m.age || !m.epochs.length) return null;
        return cvAgeAt(m, m.epochs[m.epochs.length - 1]);
    }
    function cvAgeText(a) {
        return a ? (a.isMin ? '\u2265 ' : '') + formatNumber(a.value) : '';
    }

    // ---------- navigation ----------
    // A navigation writes the URL first and then renders what the URL says,
    // so Back and Forward (popstate) reuse the same renderer without adding
    // history entries.
    function validatorHref(vote, epoch) {
        const p = new URLSearchParams();
        p.set('validator', vote);
        const n = Number(epoch);
        if (epoch !== null && epoch !== undefined && epoch !== '' && isFinite(n) && n !== Number(latestEpochNumber)) {
            p.set('epoch', String(n));
        }
        return window.location.pathname + '?' + p.toString();
    }
    function poolHref(group, epoch, vote) {
        const p = new URLSearchParams();
        p.set('pool', group);
        const n = Number(epoch);
        p.set('epoch', (!isFinite(n) || n === Number(latestEpochNumber)) ? 'latest' : String(n));
        if (vote) p.set('find', vote);
        return window.location.pathname + '?' + p.toString();
    }
    function cvRememberMainScroll() {
        const main = document.getElementById('main-dashboard-view');
        if (main && main.style.display !== 'none') cvMainScrollY = window.scrollY;
    }
    function cvRenderRoute(fresh) {
        const p = new URLSearchParams(window.location.search);
        const v = p.get('validator');
        if (v) { showValidatorDetail(v, fresh); return; }
        hideValidatorDetail();
        const pool = p.get('pool');
        if (pool && cvShowPool) { cvShowPool(pool, { history: true, fresh }); return; }
        if (cvShowMain) cvShowMain({ history: true });
    }
    function cvNavigate(href) {
        cvRememberMainScroll();
        window.history.pushState({}, '', href);
        cvRenderRoute(true);
    }
    // Links marked data-cv-nav are real links (new tab, copy link) that a
    // plain left click turns into an in-page navigation.
    document.addEventListener('click', (e) => {
        const a = e.target && e.target.closest ? e.target.closest('a[data-cv-nav]') : null;
        if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const href = a.getAttribute('href');
        if (!href) return;
        e.preventDefault();
        if (window.hidePoolTooltip) window.hidePoolTooltip();
        cvNavigate(href);
    });

    // ---------- charts ----------
    function cvFormatSol(v) {
        if (v >= 1_000_000) return (v / 1_000_000).toFixed(2) + 'M';
        if (v >= 1_000) return (v / 1_000).toFixed(1) + 'K';
        return v.toFixed(0);
    }
    function cvEpochDate(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(d);
    }
    // Chart over epochs. x follows the epoch number, so an epoch missing from
    // the history shows as a break in the line instead of a silent jump.
    // points: [{ epoch, ts, value, down }] ascending (down = second series of
    // the butterfly chart). opts: { height, butterfly, scaleMode,
    // highlightEpoch, onPick, emptyText }.
    function cvRenderEpochChart(container, points, opts) {
        if (!container) return;
        opts = opts || {};
        container.__cvChart = { points, opts };
        if (!points || points.length === 0) {
            container.innerHTML = '<div class="chart-no-data">' + escapeHtml(opts.emptyText || 'No data') + '</div>';
            return;
        }
        const width = container.clientWidth;
        if (width === 0) {
            if ('ResizeObserver' in window && !container.__cvChartRo) {
                const ro = new ResizeObserver(entries => {
                    if (entries[0] && entries[0].contentRect.width > 0) {
                        ro.disconnect();
                        container.__cvChartRo = null;
                        const c = container.__cvChart;
                        if (c) cvRenderEpochChart(container, c.points, c.opts);
                    }
                });
                container.__cvChartRo = ro;
                ro.observe(container);
            }
            return;
        }
        const H = opts.height || 90;
        const PAD = opts.grid ? 13 : 5;
        const fmt = opts.fmt || cvFormatSol;
        const id = 'cv-chart-' + (++cvChartSeq);
        const e0 = points[0].epoch;
        const e1 = points[points.length - 1].epoch;
        const xOf = ep => (e1 === e0 ? width / 2 : ((ep - e0) / (e1 - e0)) * width);
        // Runs of consecutive epochs; a missing epoch starts a new run. With
        // zeroBreak the epochs without stake form runs of their own (drawn grey).
        const isZero = p => !!opts.zeroBreak && !(p.value > 0);
        const runs = [];
        points.forEach((p, i) => {
            if (i === 0 || p.epoch - points[i - 1].epoch > 1 || isZero(p) !== isZero(points[i - 1])) runs.push([]);
            runs[runs.length - 1].push(p);
        });
        const xy = (p, y) => xOf(p.epoch).toFixed(2) + ',' + y.toFixed(2);
        const linePath = (run, yOf) => 'M ' + run.map(p => xy(p, yOf(p))).join(' L ');
        const fillPath = (run, yOf, base) => 'M ' + xOf(run[0].epoch).toFixed(2) + ',' + base + ' L ' +
            run.map(p => xy(p, yOf(p))).join(' L ') + ' L ' + xOf(run[run.length - 1].epoch).toFixed(2) + ',' + base + ' Z';
        // Light horizontal grid: the top and bottom lines carry the largest
        // and the smallest value on the chart.
        const gridLine = (y, label) => '<line class="cv-grid-line" x1="0" x2="' + width + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '"></line>' +
            '<text class="cv-grid-label" x="6" y="' + (y - 3).toFixed(1) + '">' + escapeHtml(label) + '</text>' +
            '<text class="cv-grid-label" x="' + (width - 6) + '" y="' + (y - 3).toFixed(1) + '" text-anchor="end">' + escapeHtml(label) + '</text>';
        const epochBtn = ep => '<button type="button" class="cv-chart-ep" data-cv-epoch="' + ep + '" data-cv-stay="1" data-cv-tip="Open epoch ' + ep + '">' + ep + '</button>';
        const stat = (label, valueText, ep) => '<span>' + label + ': <span class="value">' + valueText + '</span> ' + epochBtn(ep) + '</span>';
        const maxBy = (get) => points.reduce((a, p) => (get(p) > get(a) ? p : a), points[0]);
        let defs = '';
        let grid = '';
        let body = '';
        let stats = '';
        let yUp;
        let yDown = null;
        const UP = '#14F195';
        const DOWN = '#FF6B6B';
        if (opts.butterfly) {
            const mid = H / 2;
            const maxUp = Math.max.apply(null, points.map(p => p.value));
            const maxDown = Math.max.apply(null, points.map(p => p.down || 0));
            const unified = opts.scaleMode !== 'separate';
            const sUp = (unified ? Math.max(maxUp, maxDown) : maxUp) || 1;
            const sDown = (unified ? Math.max(maxUp, maxDown) : maxDown) || 1;
            yUp = p => mid - (p.value / sUp) * (mid - PAD);
            yDown = p => mid + ((p.down || 0) / sDown) * (mid - PAD);
            defs = '<defs>' +
                '<linearGradient id="' + id + '-up" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(20,241,149,0.35)"/><stop offset="100%" stop-color="rgba(20,241,149,0.03)"/></linearGradient>' +
                '<linearGradient id="' + id + '-down" x1="0" y1="1" x2="0" y2="0"><stop offset="0%" stop-color="rgba(255,107,107,0.35)"/><stop offset="100%" stop-color="rgba(255,107,107,0.03)"/></linearGradient>' +
                '</defs><line class="epoch-center-line" x1="0" y1="' + mid + '" x2="' + width + '" y2="' + mid + '"></line>';
            if (opts.grid) grid = gridLine(PAD, '+' + fmt(sUp)) + gridLine(H - PAD, '-' + fmt(sDown));
            if (opts.stats) {
                const pUp = maxBy(p => p.value);
                const pDown = maxBy(p => p.down || 0);
                stats = stat('Peak in', '+' + fmt(pUp.value), pUp.epoch) + stat('Peak out', '-' + fmt(pDown.down || 0), pDown.epoch);
            }
            runs.forEach(run => {
                if (run.length > 1) {
                    body += '<path d="' + fillPath(run, yUp, mid) + '" class="chart-path-fill" style="fill:url(#' + id + '-up);"/>' +
                        '<path d="' + linePath(run, yUp) + '" class="chart-path-line" style="stroke:' + UP + ';"/>' +
                        '<path d="' + fillPath(run, yDown, mid) + '" class="chart-path-fill" style="fill:url(#' + id + '-down);"/>' +
                        '<path d="' + linePath(run, yDown) + '" class="chart-path-line" style="stroke:' + DOWN + ';"/>';
                } else {
                    body += '<circle cx="' + xOf(run[0].epoch).toFixed(2) + '" cy="' + yUp(run[0]).toFixed(2) + '" r="2.5" style="fill:' + UP + ';"/>' +
                        '<circle cx="' + xOf(run[0].epoch).toFixed(2) + '" cy="' + yDown(run[0]).toFixed(2) + '" r="2.5" style="fill:' + DOWN + ';"/>';
                }
            });
        } else {
            const vals = points.map(p => p.value);
            const minV = Math.min.apply(null, vals);
            const maxV = Math.max.apply(null, vals);
            const flat = maxV === minV;
            const frac = v => (flat ? 0.5 : (v - minV) / (maxV - minV));
            // invert: smaller is better (rank), so the smallest value sits on top.
            yUp = p => (opts.invert ? PAD + frac(p.value) * (H - 2 * PAD) : H - PAD - frac(p.value) * (H - 2 * PAD));
            defs = '<defs><linearGradient id="' + id + '-fill" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="var(--sparkline-gradient-start)"/><stop offset="100%" stop-color="var(--sparkline-gradient-end)"/>' +
                '</linearGradient></defs>';
            if (opts.grid) {
                grid = flat ? gridLine(H / 2, fmt(minV))
                    : gridLine(PAD, fmt(opts.invert ? minV : maxV)) + gridLine(H / 2, fmt((minV + maxV) / 2)) +
                      gridLine(H - PAD, fmt(opts.invert ? maxV : minV));
            }
            if (opts.stats) {
                const held = opts.zeroBreak && points.some(p => p.value > 0) ? points.filter(p => p.value > 0) : points;
                const lo = held.reduce((a, p) => (p.value < a.value ? p : a), held[0]);
                const hi = maxBy(p => p.value);
                const labels = opts.statLabels || ['Min', 'Max'];
                stats = stat(labels[0], fmt(lo.value), lo.epoch) + stat(labels[1], fmt(hi.value), hi.epoch);
            }
            runs.forEach(run => {
                if (isZero(run[0])) {
                    if (run.length > 1) {
                        body += '<line class="cv-zero-run" x1="' + xOf(run[0].epoch).toFixed(2) + '" x2="' + xOf(run[run.length - 1].epoch).toFixed(2) +
                            '" y1="' + yUp(run[0]).toFixed(2) + '" y2="' + yUp(run[0]).toFixed(2) + '"></line>';
                    }
                    return;
                }
                if (run.length > 1) {
                    body += '<path d="' + fillPath(run, yUp, H) + '" class="chart-path-fill" style="fill:url(#' + id + '-fill);"/>' +
                        '<path d="' + linePath(run, yUp) + '" class="chart-path-line"/>';
                } else {
                    body += '<circle class="cv-chart-point" cx="' + xOf(run[0].epoch).toFixed(2) + '" cy="' + yUp(run[0]).toFixed(2) + '" r="2.5"/>';
                }
            });
        }
        // Marker of the selected epoch (not on the last point: the line ends there anyway).
        const hi = opts.highlightEpoch;
        const marker = (hi !== null && hi !== undefined && Number(hi) !== e1)
            ? points.find(p => p.epoch === Number(hi)) || null : null;
        let marks = '';
        if (marker) {
            const mx = xOf(marker.epoch).toFixed(2);
            marks = '<line class="selected-epoch-line" x1="' + mx + '" x2="' + mx + '" y1="0" y2="' + H + '"></line>' +
                '<circle class="selected-epoch-dot" cx="' + mx + '" cy="' + yUp(marker).toFixed(2) + '" r="4.5"' +
                (opts.butterfly ? ' style="fill:' + UP + ';"' : '') + '></circle>' +
                (yDown ? '<circle class="selected-epoch-dot" cx="' + mx + '" cy="' + yDown(marker).toFixed(2) + '" r="4.5" style="fill:' + DOWN + ';"></circle>' : '');
        }
        marks += '<line class="tracker-line-svg" x1="-999" x2="-999" y1="0" y2="' + H + '"></line>' +
            '<circle class="tracker-dot-svg" cx="-999" cy="-999" r="4.5"' + (opts.butterfly ? ' style="fill:' + UP + ';"' : '') + '></circle>' +
            (yDown ? '<circle class="tracker-dot-svg cv-tracker-down" cx="-999" cy="-999" r="4.5" style="fill:' + DOWN + ';"></circle>' : '');
        const first = points[0];
        const last = points[points.length - 1];
        const label = p => (opts.butterfly
            ? p.epoch + ': <span class="value">+' + fmt(p.value) + ' / -' + fmt(p.down || 0) + '</span>'
            : p.epoch + ': <span class="value">' + fmt(p.value) + '</span>');
        container.style.display = 'block';
        container.innerHTML = '<div class="chart-tooltip' + (opts.butterfly ? ' epoch-dynamics-tooltip' : '') + '"></div>' +
            '<svg viewBox="0 0 ' + width + ' ' + H + '" preserveAspectRatio="none" style="height:' + H + 'px;overflow:visible;' +
            (opts.onPick ? 'cursor:pointer;' : '') + '">' + defs + grid + body + marks + '</svg>' +
            (stats ? '<div class="chart-range-labels cv-chart-stats">' + stats + '</div>'
                : '<div class="chart-range-labels"><span>' + label(first) + '</span>' +
                  (points.length > 1 ? '<span>' + label(last) + '</span>' : '') + '</div>');
        const svg = container.querySelector('svg');
        const tooltip = container.querySelector('.chart-tooltip');
        const line = svg.querySelector('.tracker-line-svg');
        const dots = svg.querySelectorAll('.tracker-dot-svg');
        const nearest = (clientX) => {
            const rect = svg.getBoundingClientRect();
            const x = ((clientX - rect.left) / (rect.width || 1)) * width;
            let best = points[0];
            let bestD = Infinity;
            points.forEach(p => {
                const d = Math.abs(xOf(p.epoch) - x);
                if (d < bestD) { bestD = d; best = p; }
            });
            return best;
        };
        const show = (clientX) => {
            const p = nearest(clientX);
            const px = xOf(p.epoch);
            line.setAttribute('x1', px); line.setAttribute('x2', px);
            dots[0].setAttribute('cx', px); dots[0].setAttribute('cy', yUp(p));
            if (dots[1] && yDown) { dots[1].setAttribute('cx', px); dots[1].setAttribute('cy', yDown(p)); }
            const date = cvEpochDate(p.ts);
            const head = '<span class="epoch">Epoch ' + p.epoch + '</span>' + (date ? ' <span class="cv-tip-date">' + escapeHtml(date) + '</span>' : '');
            tooltip.innerHTML = opts.butterfly
                ? '<div>' + head + '</div>' +
                  '<div class="activating-line"><span class="dot" style="background:' + UP + ';"></span> Activating: ' + cvFormatSol(p.value) + ' SOL</div>' +
                  '<div class="deactivating-line"><span class="dot" style="background:' + DOWN + ';"></span> Deactivating: ' + cvFormatSol(p.down || 0) + ' SOL</div>'
                : head + ': ' + escapeHtml(opts.tip ? opts.tip(p) : formatNumber(p.value, p.value < 1000 ? 2 : 0) + ' SOL');
            const half = (tooltip.offsetWidth || 120) / 2 + 4;
            tooltip.style.left = Math.max(half, Math.min(width - half, px)) + 'px';
            tooltip.style.top = (opts.butterfly ? 8 : Math.max(8, yUp(p))) + 'px';
            tooltip.style.opacity = '1';
            line.style.opacity = '1';
            dots.forEach(d => { d.style.opacity = '1'; });
        };
        const hide = () => {
            tooltip.style.opacity = '';
            tooltip.innerHTML = '';
            line.style.opacity = '';
            dots.forEach(d => { d.style.opacity = ''; });
            line.setAttribute('x1', -999); line.setAttribute('x2', -999);
            dots.forEach(d => { d.setAttribute('cx', -999); });
        };
        svg.addEventListener('mousemove', e => show(e.clientX));
        svg.addEventListener('mouseleave', hide);
        svg.addEventListener('touchstart', e => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
        svg.addEventListener('touchmove', e => { if (e.touches[0]) show(e.touches[0].clientX); }, { passive: true });
        if (opts.onPick) svg.addEventListener('click', e => opts.onPick(nearest(e.clientX).epoch));
    }
    function cvRedrawCharts() {
        const view = document.getElementById('validator-detail-view');
        if (!view || view.style.display === 'none') return;
        view.querySelectorAll('.interactive-chart-container').forEach(c => {
            if (c.__cvChart) cvRenderEpochChart(c, c.__cvChart.points, c.__cvChart.opts);
        });
    }
    window.addEventListener('resize', debounce(cvRedrawCharts, 200));

    // ---------- view ----------
    function hideValidatorDetail() {
        cvVdSeq++;
        cvVd = null;
        const view = document.getElementById('validator-detail-view');
        if (view) view.style.display = 'none';
    }
    function cvVdShowView() {
        const main = document.getElementById('main-dashboard-view');
        const pool = document.getElementById('pool-detail-view');
        const view = document.getElementById('validator-detail-view');
        if (main) main.style.display = 'none';
        if (pool) pool.style.display = 'none';
        if (view) view.style.display = 'block';
        currentPoolGroup = null;
        const section = document.getElementById('breadcrumb-section');
        if (section) { section.textContent = 'Validators'; section.dataset.tab = 'validators'; }
        const sep = document.querySelector('.breadcrumb-detail-sep');
        const cur = document.getElementById('breadcrumb-current');
        if (sep) sep.style.display = 'inline';
        if (cur) cur.style.display = 'inline';
    }
    // Loading, not found and unavailable states replace the page blocks.
    function cvVdMessage(kind, key) {
        const view = document.getElementById('validator-detail-view');
        const box = document.getElementById('cv-vd-message');
        if (!view || !box) return;
        if (!kind) { view.removeAttribute('data-state'); box.innerHTML = ''; return; }
        view.setAttribute('data-state', 'message');
        const back = '<a class="cv-vd-back" href="' + escapeHtml(window.location.pathname + '?tab=validators') +
            '" data-cv-main="1"><i class="fas fa-arrow-left" aria-hidden="true"></i>Validators list</a>';
        let title = 'Loading...';
        if (kind === 'loading') {
            box.innerHTML = '<div class="cv-vd-msg"><div class="cv-vd-spinner"></div><p>Loading validator...</p></div>';
        } else if (kind === 'notfound') {
            title = 'Not found';
            box.innerHTML = '<div class="cv-vd-msg"><h2>Validator not found</h2>' +
                '<p>No validator with this vote account or identity key appears in the data since epoch ' + DATASET_FIRST_EPOCH + '.</p>' +
                '<p class="cv-vd-msg-key">' + escapeHtml(key || '') + '</p>' + back + '</div>';
        } else {
            title = 'Unavailable';
            box.innerHTML = '<div class="cv-vd-msg"><h2>Validator data is unavailable right now</h2>' +
                '<p>The history files did not respond. Please try again in a minute.</p>' + back + '</div>';
        }
        const cur = document.getElementById('breadcrumb-current');
        if (cur) cur.textContent = kind === 'loading' ? '' : title;
        subheaderSet('Validator', title, '<span class="cv-flow-logo is-icon"><i class="fas fa-user" aria-hidden="true"></i></span>', null, null);
    }
    function cvVdEpochFromUrl() {
        const raw = new URLSearchParams(window.location.search).get('epoch');
        const n = Number(raw);
        return raw !== null && raw !== '' && isFinite(n) ? n : null;
    }
    // The epoch is written only when it differs from the validator's own
    // latest epoch, so a plain ?validator=<vote> link always opens the newest data.
    function cvVdWriteUrl() {
        const m = cvVd;
        if (!m) return;
        const p = new URLSearchParams();
        p.set('validator', m.vote);
        if (m.selectedEpoch !== null && m.selectedEpoch !== m.lastEpoch) p.set('epoch', String(m.selectedEpoch));
        window.history.replaceState({}, '', window.location.pathname + '?' + p.toString());
    }
    async function showValidatorDetail(key, fresh) {
        const seq = ++cvVdSeq;
        cvVd = null;
        cvChangesExpanded = false;
        cvCardOrder = null;
        cvPoolFilter = null;
        cvVdShowView();
        if (fresh) window.scrollTo({ top: 0 });
        const liveRow = cvFindLiveRow(key);
        const wanted = cvVdEpochFromUrl();
        let vote = liveRow ? liveRow.info.vote_pubkey : key;
        let indexRow = null;
        let indexLoaded = false;
        if (liveRow) {
            // An identity key in the link is replaced with the vote account.
            if (vote !== key) window.history.replaceState({}, '', validatorHref(vote, wanted));
            if (wanted === null || wanted === Number(latestEpochNumber)) {
                // Header and the current epoch render at once; the history
                // joins when its file arrives.
                cvVd = cvBuildModel(vote, liveRow, null, null);
                cvVdRender();
            } else {
                cvVdMessage('loading');
            }
        } else {
            cvVdMessage('loading');
            const index = await loadValidatorsIndex();
            if (seq !== cvVdSeq) return;
            indexLoaded = !!index;
            indexRow = index ? (index.validators.find(r => r.vote === key || r.identity === key) || null) : null;
            if (indexLoaded && !indexRow) { cvVdMessage('notfound', key); return; }
            if (indexRow && indexRow.vote !== key) {
                vote = indexRow.vote;
                window.history.replaceState({}, '', validatorHref(vote, wanted));
            }
        }
        const shardRes = await loadValidatorShard(vote);
        if (seq !== cvVdSeq) return;
        if (shardRes.state === 'ok') {
            cvVd = cvBuildModel(vote, liveRow, shardRes, indexRow);
            cvVdRender();
            return;
        }
        if (!liveRow) {
            cvVdMessage(!indexLoaded && shardRes.state === 'missing' ? 'notfound' : 'unavailable', key);
            return;
        }
        // In the live data but without a history file: a validator new in this
        // epoch, or a failed download. The index tells the two apart.
        let state = 'error';
        const index = await loadValidatorsIndex();
        if (seq !== cvVdSeq) return;
        if (index && !index.validators.some(r => r.vote === vote)) state = 'new';
        cvVd = cvBuildModel(vote, liveRow, { state, data: null }, null);
        cvVdRender();
    }
    function cvVdRender() {
        const m = cvVd;
        if (!m) return;
        cvVdMessage(null);
        const sel = document.getElementById('validator-epoch-select');
        const list = m.epochs.map(e => e.epoch).sort((a, b) => b - a);
        sel.innerHTML = list.map(e => '<option value="' + e + '">Epoch ' + e +
            (e === Number(latestEpochNumber) ? ' (latest)' : '') + '</option>').join('');
        const wanted = cvVdEpochFromUrl();
        m.selectedEpoch = (wanted !== null && list.includes(wanted)) ? wanted : (list.length ? list[0] : null);
        if (m.selectedEpoch !== null) sel.value = String(m.selectedEpoch);
        cvVdWriteUrl();
        cvVdRenderStatic(m, sel);
        cvVdRenderEpoch();
    }
    function cvVdMiniAvatarHtml(m) {
        if (m.iconUrl && !brokenImages.has(m.iconUrl)) {
            return '<span class="cv-flow-logo cv-vd-mini"><img src="' + escapeHtml(m.iconUrl) + '" alt=""></span>';
        }
        return '<span class="cv-flow-logo is-initials">' + escapeHtml(getInitials(m.displayName, m.identity)) + '</span>';
    }
    // Parts that do not depend on the selected epoch: who the validator is now.
    function cvVdRenderStatic(m, sel) {
        const $ = id => document.getElementById(id);
        $('cv-vd-avatar').innerHTML = cvVdAvatarHtml(m);
        $('cv-vd-name').textContent = m.displayName;
        $('cv-vd-name').title = m.displayName;
        $('cv-vd-name-copy').innerHTML = m.realName ? copyButtonHtml(m.rawName, 'Copy name') : '';
        let status = '';
        if (!m.isActive && m.lastEpoch !== null) {
            status = '<span class="cv-vd-badge is-inactive" data-cv-tip="Last seen with stake in epoch ' + m.lastEpoch + '">' +
                '<i class="fas fa-power-off" aria-hidden="true"></i>Inactive since epoch ' + (m.lastEpoch + 1) + '</span>';
        } else if (m.historyState === 'new') {
            status = '<span class="cv-vd-badge is-new" data-cv-tip="First seen in the current epoch">' +
                '<i class="fas fa-seedling" aria-hidden="true"></i>New validator</span>';
        }
        $('cv-vd-status').innerHTML = status;
        $('cv-vd-keys').innerHTML = (m.identity ? keyTokenHtml('ID', m.identity) : '') + keyTokenHtml('Vote', m.vote);
        cvVdSetProfile(m.website, m.details);
        const cur = $('breadcrumb-current');
        if (cur) cur.textContent = m.displayName;
        subheaderSet('Validator', m.displayName, cvVdMiniAvatarHtml(m), null, sel);
        const barImg = document.querySelector('#cv-subheader .cv-subheader-logo img');
        if (barImg) {
            barImg.addEventListener('error', () => {
                const slot = document.querySelector('#cv-subheader .cv-subheader-logo');
                // (an image replaced since then must not overwrite the newer logo)
                if (slot && cvVd === m && barImg.isConnected) {
                    slot.innerHTML = '<span class="cv-flow-logo is-initials">' + escapeHtml(getInitials(m.displayName, m.identity)) + '</span>';
                }
            });
        }
        const small = ' <small class="cv-vd-of">' + escapeHtml(m.displayName) + '</small>';
        $('cv-vd-stake-title').innerHTML = 'Stake History' + small;
        $('cv-vd-dyn-title').innerHTML = 'Epoch Dynamics' + small;
        $('cv-vd-sources-title').textContent = 'Stakers';
        $('cv-vd-donut-title').innerHTML = 'Stake Distribution' + small;
        $('cv-vd-changes-title').innerHTML = 'Changes' + small;
        $('validator-detail-view').classList.toggle('is-inactive', !m.isActive);
    }
    // Value of a name_changes / identity_changes list as of an epoch.
    function cvValueAt(changes, field, epoch) {
        let val = null;
        changes.slice().sort((a, b) => a.epoch - b.epoch).forEach(c => {
            if (c && typeof c.epoch === 'number' && c.epoch <= epoch) val = c[field];
        });
        return val;
    }
    function cvVdSelectEpoch(epoch, push) {
        const sel = document.getElementById('validator-epoch-select');
        if (!sel || !cvVd || Number(sel.value) === Number(epoch)) return;
        if (!Array.from(sel.options).some(o => Number(o.value) === Number(epoch))) return;
        // A jump (an epoch pill, a change-log entry) keeps the epoch it left as
        // a Back target; stepping and chart clicks replace the entry.
        if (push === true) window.history.pushState({}, '', window.location.href);
        sel.value = String(epoch);
        sel.dispatchEvent(new Event('change'));
    }
    // Everything that follows the selected epoch.
    function cvVdRenderEpoch() {
        const m = cvVd;
        if (!m) return;
        const $ = id => document.getElementById(id);
        const E = m.selectedEpoch;
        const idx = m.epochs.findIndex(e => e.epoch === E);
        const entry = idx >= 0 ? m.epochs[idx] : null;
        const isPast = E !== Number(latestEpochNumber);
        const view = $('validator-detail-view');
        view.classList.toggle('is-past-epoch', isPast);
        view.classList.toggle('cv-vd-delinquent', !!(entry && entry.meta && entry.meta.delinquent === true));
        $('cv-vd-stale-pill').style.display = isPast ? 'flex' : 'none';
        let info = '<span class="epoch-number">Epoch ' + E + '</span>' + (isPast
            ? '<span class="past-epoch-badge"><i class="fas fa-history"></i> past</span>'
            : '<span class="current-epoch-badge"><i class="fas fa-check-circle"></i> current</span>');
        if (entry && entry.ts) {
            const f = formatLocalSnapshot(entry.ts);
            info += '<span class="epoch-separator">&bull;</span><span class="snapshot-info"><span class="snapshot-label">Snapshot:</span>' +
                '<span class="snapshot-value">' + escapeHtml(f.dt + ' ' + f.tzShort) + '</span></span>';
        }
        $('cv-vd-epoch-info').innerHTML = info;
        // A full snapshot of the selected epoch, when one is in memory (the
        // visitor came from that epoch, or asked for it), adds what the
        // history files lack: stake accounts per pool and the profile of then.
        const loadedRow = entry && !entry.isLive ? cvLoadedRowAt(m.vote, E) : null;
        if (loadedRow && entry.groups.some(g => g.count === null)) {
            const snap = epochMap.get(Number(E));
            const counts = new Map(getResolvedGroups(loadedRow, snap.pool_definitions).map(g => [g.name, g.count || 0]));
            entry.groups.forEach(g => { if (g.count === null && counts.has(g.name)) g.count = counts.get(g.name); });
        }
        // The page shows the validator as it was in the selected epoch (as the
        // lists of that epoch do); grey notes say what it is called now.
        const thenInfo = loadedRow ? (loadedRow.info || {}) : null;
        const nameThenRaw = (entry && E !== m.lastEpoch) ? cvValueAt(m.nameChanges, 'name', E) : null;
        const nameThen = nameThenRaw === null ? null : String(nameThenRaw || '').trim();
        const nameDiffers = nameThen !== null && nameThen !== m.rawName;
        const shownRaw = nameDiffers ? nameThen : m.rawName;
        const shownName = hasRealName(shownRaw) ? shownRaw : shortenPubkey(shownRaw || m.vote);
        const idThen = (entry && E !== m.lastEpoch) ? cvValueAt(m.identityChanges, 'identity', E) : null;
        const idDiffers = !!idThen && idThen !== m.identity;
        const shownIdentity = idDiffers ? idThen : m.identity;
        const iconThen = thenInfo && isValidHttpUrl(thenInfo.icon_url) ? thenInfo.icon_url : '';
        const shownIcon = (E !== m.lastEpoch && iconThen) ? iconThen : m.iconUrl;
        const avatarHtml = cvAvatarHtml(shownIcon, shownName, shownIdentity);
        const useThen = E !== m.lastEpoch && !!thenInfo;
        cvVdSetProfile(useThen ? (isValidHttpUrl(thenInfo.website) ? thenInfo.website : '') : m.website,
            useThen ? cleanText(thenInfo.details || '').trim() : m.details);
        m.shownName = shownName;
        m.avatarHtml = avatarHtml;
        m.shownIcon = shownIcon;
        m.shownIdentity = shownIdentity;
        $('cv-vd-name').textContent = shownName;
        $('cv-vd-name').title = shownName;
        // On a past epoch a yellow pill marks a name that is not the current one.
        const namePill = $('cv-vd-namepill');
        if (namePill) {
            namePill.innerHTML = nameDiffers
                ? '<span class="cv-vd-asof" data-cv-tip="The name of this validator in epoch ' + E + '"><i class="fas fa-hourglass-half" aria-hidden="true"></i>name in epoch ' + E + '</span>'
                : '';
        }
        $('cv-vd-name-copy').innerHTML = hasRealName(shownRaw) ? copyButtonHtml(shownRaw, 'Copy name') : '';
        $('cv-vd-keys').innerHTML = (shownIdentity ? keyTokenHtml('ID', shownIdentity) : '') + keyTokenHtml('Vote', m.vote);
        $('cv-vd-avatar').innerHTML = avatarHtml;
        const crumb = $('breadcrumb-current');
        if (crumb) crumb.textContent = shownName;
        const barTitle = document.querySelector('#cv-subheader .cv-subheader-title');
        if (barTitle) barTitle.textContent = shownName;
        const barLogo = document.querySelector('#cv-subheader .cv-subheader-logo');
        if (barLogo) {
            const initials = '<span class="cv-flow-logo is-initials">' + escapeHtml(getInitials(shownName, shownIdentity)) + '</span>';
            barLogo.innerHTML = (shownIcon && !brokenImages.has(shownIcon))
                ? '<span class="cv-flow-logo cv-vd-mini"><img src="' + escapeHtml(shownIcon) + '" alt=""></span>' : initials;
            const barImg = barLogo.querySelector('img');
            if (barImg) barImg.addEventListener('error', () => { barLogo.innerHTML = initials; });
        }
        const notes = [];
        if (nameDiffers) {
            notes.push('<span class="cv-vd-then-item is-now"><i class="fas fa-arrow-right" aria-hidden="true"></i>' +
                (m.isActive ? 'Now: ' : 'Later: ') + '<b>' + escapeHtml(m.displayName) + '</b></span>');
        }
        if (idDiffers) {
            notes.push('<span class="cv-vd-then-item is-now"><i class="fas fa-arrow-right" aria-hidden="true"></i>Identity ' +
                (m.isActive ? 'now' : 'later') + ': ' + keyTokenHtml('ID', m.identity) + '</span>');
        }
        $('cv-vd-then').innerHTML = notes.join('');
        let chips = '';
        if (entry && entry.meta) {
            chips = (isPast ? '<span class="cv-vd-asof"><i class="fas fa-hourglass-half" aria-hidden="true"></i>In epoch ' + E + '</span>' : '') +
                buildMetaChipsHtml(entry.meta, entry.scriptInfo);
        } else if (entry && E < META_FIRST_EPOCH) {
            chips = '<span class="cv-vd-nodata">Commission and client data start at epoch ' + META_FIRST_EPOCH + '</span>';
        }
        $('cv-vd-chips').innerHTML = chips;
        // Metric cards; the details of each open in a tooltip (hover) that a click pins.
        const note = isPast ? ' in epoch ' + E : '';
        const card = (icon, cls, valueHtml, label, tipKind) =>
            '<div class="pool-metric-card"' + (tipKind ? ' data-cv-vdtip="' + tipKind + '"' : '') + '>' +
            '<i class="fas ' + icon + ' pool-metric-icon' + (cls ? ' ' + cls : '') + '"></i><div class="pool-metric-info">' +
            '<span class="pool-metric-value' + (cls === 'activating' ? ' positive' : (cls === 'deactivating' ? ' negative' : '')) + '">' +
            valueHtml + '</span><span class="pool-metric-label">' + escapeHtml(label + note) + '</span></div></div>';
        let ageHtml = '-';
        const ageThen = cvAgeAt(m, entry);
        const ageNow = cvAgeNow(m);
        if (ageThen) {
            ageHtml = escapeHtml(cvAgeText(ageThen));
            if (ageNow && E !== m.lastEpoch) {
                ageHtml += '<small class="cv-vd-now"> / ' + escapeHtml(cvAgeText(ageNow)) + (m.isActive ? ' now' : ' at the end') + '</small>';
            }
        }
        const sol = '<small class="cv-vd-unit"> SOL</small>';
        $('cv-vd-metrics').innerHTML = !entry ? '' : (
            card('fa-chart-pie', '', formatNumber(lamportsToSol(entry.active), 2) + sol, 'Active Stake') +
            card('fa-ranking-star', '', entry.rank ? '#' + formatNumber(entry.rank) : '-', 'Stake Rank', 'rank') +
            card('fa-wallet', '', entry.accounts !== null ? formatNumber(entry.accounts) : '-', 'Stake Accounts', 'accounts') +
            card('fa-hourglass-half', '', ageHtml, 'Vote Account Age', 'age') +
            card('fa-arrow-trend-up', 'activating', (entry.activating > 0 ? '+' + formatNumber(lamportsToSol(entry.activating), 2) : '0') + sol, 'Activating', 'activating') +
            card('fa-arrow-trend-down', 'deactivating', (entry.deactivating > 0 ? '-' + formatNumber(lamportsToSol(entry.deactivating), 2) : '0') + sol, 'Deactivating', 'deactivating'));
        // History charts.
        const small = ' <small class="cv-vd-of">' + escapeHtml(shownName) + '</small>';
        const stakeBox = $('cv-vd-stake-chart');
        const auxBox = $('cv-vd-aux-chart');
        const dynBox = $('cv-vd-dyn-chart');
        const rankMode = cvAuxChart === 'rank';
        document.querySelectorAll('#cv-vd-aux-toggle button').forEach(b =>
            b.classList.toggle('active', b.getAttribute('data-aux') === cvAuxChart));
        $('cv-vd-stake-title').innerHTML = 'Stake History' + small;
        $('cv-vd-dyn-title').innerHTML = 'Epoch Dynamics' + small;
        $('cv-vd-donut-title').innerHTML = 'Stake Distribution' + small;
        $('cv-vd-changes-title').innerHTML = 'Changes' + small;
        $('cv-vd-aux-title').innerHTML = (rankMode ? 'Stake Rank' : 'Stake Accounts') + small;
        $('cv-vd-aux-icon').className = 'fas ' + (rankMode ? 'fa-ranking-star' : 'fa-wallet');
        if (m.historyState === 'ok') {
            const whole = v => formatNumber(Math.round(v));
            cvRenderEpochChart(stakeBox, m.epochs.map(e => ({ epoch: e.epoch, ts: e.ts, value: lamportsToSol(e.active) })),
                { height: 110, grid: true, stats: true, highlightEpoch: E, onPick: cvVdSelectEpoch });
            cvRenderEpochChart(auxBox, rankMode
                ? m.epochs.filter(e => e.rank).map(e => ({ epoch: e.epoch, ts: e.ts, value: e.rank }))
                : m.epochs.filter(e => e.accounts !== null).map(e => ({ epoch: e.epoch, ts: e.ts, value: e.accounts })),
                rankMode
                    ? { height: 110, grid: true, stats: true, invert: true, statLabels: ['Best', 'Lowest'], fmt: v => '#' + whole(v),
                        tip: p => '#' + whole(p.value) + ' by active stake', highlightEpoch: E, onPick: cvVdSelectEpoch }
                    : { height: 110, grid: true, stats: true, fmt: whole, tip: p => whole(p.value) + ' stake accounts',
                        highlightEpoch: E, onPick: cvVdSelectEpoch });
            cvRenderEpochChart(dynBox, m.epochs.map(e => ({ epoch: e.epoch, ts: e.ts, value: lamportsToSol(e.activating),
                down: lamportsToSol(e.deactivating) })),
                { height: 110, butterfly: true, grid: true, stats: true, scaleMode: cvDynScaleMode, highlightEpoch: E, onPick: cvVdSelectEpoch });
        } else {
            const text = cvHistoryStateText(m);
            [stakeBox, auxBox, dynBox].forEach(box => {
                box.__cvChart = null;
                box.innerHTML = '<div class="chart-no-data">' + escapeHtml(text) + '</div>';
            });
        }
        cvVdUnpinTip();
        cvRichTips.clear();
        cvRenderDonut(m, entry, avatarHtml);
        cvVdRenderSources(m, entry, idx);
        cvVdRenderChanges(m);
    }
    function cvHistoryStateText(m) {
        if (m.historyState === 'loading') return 'Loading history...';
        if (m.historyState === 'new') return 'History appears after the current epoch is finalized';
        return 'History temporarily unavailable';
    }

    // ---------- pools of the validator ----------
    function cvSourceDef(name) {
        return latestPoolDefinitions.find(d => d.group === name) ||
            { group: name, short_name: name, long_name: '', category: 'OTHER', image: '', url: '' };
    }
    function cvSourceTitle(name, def) {
        return name === 'OTHER' ? 'Other Stakes' : (cleanText(def.long_name) || def.short_name || name);
    }
    // Logo circle of a source for the table (wrapper pattern, theme variants).
    function cvSourceLogoMini(g, isoSize) {
        if (g.name !== 'OTHER' && isValidHttpUrl(g.def.image)) {
            const isDark = document.body.classList.contains('dark-theme-body');
            return '<span class="cv-flow-logo"><img src="' + escapeHtml(resolveLogoUrlSync(g.def.image, isDark, isoSize)) +
                '" data-logo-default="' + escapeHtml(g.def.image) + '"' +
                (isoSize ? ' data-logo-iso="' + Number(isoSize) + '"' : '') + ' alt=""></span>';
        }
        if (g.name === 'OTHER' && isoSize) {
            const sprite = otherIsoImg(isoSize);
            if (sprite) return '<span class="cv-flow-logo is-other">' + sprite + OTHER_GROUP_SVG + '</span>';
        }
        return poolLogoMiniHtml(g.name, null);
    }
    function cvSignedSol(lamports) {
        const sol = lamportsToSol(lamports);
        const text = formatCompact(Math.abs(sol));
        if (text === '0') return { text: '0', cls: '' };
        return sol > 0 ? { text: '+' + text, cls: 'cv-vd-pos' } : { text: '-' + text, cls: 'cv-vd-neg' };
    }
    function cvVdRenderSources(m, entry, idx) {
        const body = document.getElementById('cv-vd-sources-body');
        const sub = document.getElementById('cv-vd-sources-sub');
        const bar = document.getElementById('cv-vd-sortbar');
        const scopeBox = document.getElementById('cv-vd-scope');
        document.querySelectorAll('#cv-vd-view-toggle button').forEach(b =>
            b.classList.toggle('active', b.getAttribute('data-view') === cvSourcesView));
        if (!body) return;
        if (!entry) {
            body.innerHTML = '';
            if (sub) sub.textContent = '';
            if (bar) bar.innerHTML = '';
            if (scopeBox) scopeBox.innerHTML = '';
            return;
        }
        const E = entry.epoch;
        const isPast = E !== Number(latestEpochNumber);
        if (sub) sub.textContent = 'Who stakes with ' + (m.shownName || m.displayName) + (isPast ? ' in epoch ' + E : '');
        const src = cvEntrySources(m, entry);
        const prev = idx > 0 && m.epochs[idx - 1].epoch === E - 1 ? m.epochs[idx - 1] : null;
        src.shown.forEach(g => {
            const before = prev ? prev.groups.find(x => x.name === g.name) : null;
            g.delta = prev ? g.active - (before ? before.active : 0) : null;
            g.share = entry.active > 0 ? (g.active / entry.active) * 100 : 0;
        });
        const past = m.historyState === 'ok' ? cvPastPools(m, entry, src.shown) : [];
        past.forEach(p => {
            const before = prev ? prev.groups.find(x => x.name === p.name) : null;
            p.delta = prev ? -(before ? before.active : 0) : null;
        });
        const thin = cvThinPools(entry, src.shown);
        if (cvPoolFilter === CV_THIN_KEY ? !thin.length : (cvPoolFilter && !src.shown.some(g => g.name === cvPoolFilter))) cvPoolFilter = null;
        // Which pools to show: those of this epoch, or every pool that ever
        // held stake with this validator.
        if (scopeBox) {
            scopeBox.innerHTML = past.length
                ? '<div class="cv-vd-toggle" role="group" aria-label="Which stakers to show"><button type="button" data-scope="epoch"' +
                  (cvShowPastPools ? '' : ' class="active"') + '>In this epoch<span class="cv-vd-count">' + src.shown.length + '</span></button>' +
                  '<button type="button" data-scope="all"' + (cvShowPastPools ? ' class="active"' : '') +
                  ' data-cv-tip="Adds the stakers that held stake with this validator in other epochs">All epochs<span class="cv-vd-count">' +
                  (src.shown.length + past.length) + '</span></button></div>'
                : '';
        }
        const isTable = cvSourcesView === 'table';
        const sortKey = cvSort.key;
        const sortDir = cvSort.dir;
        const minSol = lamportsToSol(MIN_ACTIVE_STAKE);
        const smallHtml = src.small.length
            ? '<div class="cv-vd-small"><span' + cvRich('<div class="pool-tooltip-title">Below ' + minSol + ' SOL</div>' + src.small.map(g =>
                cvTipRow(cvSourceLogoMini(g), g.title, formatNumber(lamportsToSol(g.active + g.activating), 4) + ' SOL')).join('')) + '>+' +
              src.small.length + ' below ' + minSol + ' SOL</span></div>'
            : '';
        const sortBar = (key, dir, note) => {
            cvBarKey = key;
            if (!bar) return;
            const caret = '<i class="fas ' + (dir === 'asc' ? 'fa-caret-up' : 'fa-caret-down') + '" aria-hidden="true"></i>';
            const btn = (k, icon, label) => '<button type="button" class="sort-btn' + (key === k ? ' active' : '') + '" data-src-sort="' + k +
                '"><i class="fas ' + icon + '" aria-hidden="true"></i> ' + label + (key === k && k !== 'category' ? ' ' + caret : '') + '</button>';
            bar.innerHTML = '<span class="label">Sort:</span>' + btn('category', 'fa-folder-tree', 'By Category') + btn('active', 'fa-coins', 'By Stake') +
                btn('activating', 'fa-arrow-trend-up', 'By Activating') + btn('deactivating', 'fa-arrow-trend-down', 'By Deactivating') +
                btn('change', 'fa-arrows-up-down', 'By Change vs ' + (E - 1)) + (note || '');
        };
        if (src.shown.length === 0 && !(cvShowPastPools && past.length)) {
            sortBar(sortKey, sortDir);
            body.innerHTML = '<div class="chart-no-data">No staker reaches ' + minSol + ' SOL in this epoch</div>' + smallHtml;
            return;
        }
        const thinNames = new Set(thin.map(g => g.name));
        const list = !cvPoolFilter ? src.shown
            : src.shown.filter(g => (cvPoolFilter === CV_THIN_KEY ? thinNames.has(g.name) : g.name === cvPoolFilter));
        const pastList = (cvShowPastPools && !cvPoolFilter) ? past : [];
        const filterHtml = cvPoolFilter
            ? '<div class="cv-vd-filter">Showing only <b>' + (cvPoolFilter === CV_THIN_KEY
                ? 'the ' + list.length + (list.length > 1 ? ' stakers' : ' staker') + ' under 1%' : escapeHtml(list[0].title)) +
              '</b> <button type="button" class="cv-vd-linkbtn" data-cv-pool-clear="1">Show all stakers</button></div>'
            : '';
        const countsNote = (isPast && list.some(g => g.count === null))
            ? '<p class="cv-vd-note">Stake accounts per staker are not in the history files. <button type="button" class="cv-vd-linkbtn" id="cv-vd-load-counts">Load them for epoch ' +
              E + '</button> (the full data of the epoch, a few seconds).</p>'
            : '';
        const epochNote = isPast ? '<span class="epoch-inline-note">in epoch ' + E + '</span>' : '';
        const pct = g => (g.share > 0 && g.share < 0.01 ? '&lt;0.01%' : (g.share >= 10 ? g.share.toFixed(1) : g.share.toFixed(2)) + '%');
        const href = g => escapeHtml(poolHref(g.name, E, m.vote));
        const goTip = g => escapeHtml(isPast
            ? 'Opens the ' + g.title + ' page for epoch ' + E + ' with this validator selected. A past epoch takes a moment to load.'
            : 'Opens the ' + g.title + ' page with this validator selected');
        const catTitle = c => (c === 'OTHER' ? 'Other' : toTitleCaseKey(c));
        const sortedBy = (arr, key, dir) => arr.slice().sort((a, b) => {
            const x = cvSourceValue(a, key);
            const y = cvSourceValue(b, key);
            const c = x < y ? -1 : (x > y ? 1 : 0);
            return (dir === 'asc' ? c : -c) || (b.active - a.active);
        });
        const byActive = arr => arr.slice().sort((a, b) => (b.active - a.active) || (b.activating - a.activating));
        const cats = orderedCategories(list.concat(pastList), categoryOrder.length ? categoryOrder : buildCategoryOrderFrom(latestPoolDefinitions));
        const freshOrder = (key, dir) => (key === 'category'
            ? cats.reduce((acc, cat) => acc.concat(byActive(list.filter(g => g.category === cat))), [])
            : sortedBy(list, key, dir));
        // Status of a pool that holds no stake here in the selected epoch.
        const pastStatus = p => '<span class="cv-vd-past-badge">' + (p.before !== null ? 'No stake since epoch ' + (p.before + 1) : 'Stake from epoch ' + p.after) +
            '</span><button type="button" class="cv-chart-ep" data-cv-stay="1" data-cv-epoch="' + (p.before !== null ? p.before : p.after) + '" data-cv-tip="' +
            (p.before !== null ? 'Open epoch ' + p.before + ': the latest epoch with stake from this staker' : 'Open epoch ' + p.after + ': the first epoch with stake from this staker') +
            '">' + (p.before !== null ? p.before : p.after) + '</button>';
        const series = name => (m.historyState === 'ok' ? cvSourceSeries(m, name) : []);
        const seriesFull = name => (m.historyState === 'ok' ? cvSourceSeries(m, name, true) : []);
        const corner = g => '<a class="cv-corner" data-cv-nav href="' + href(g) + '" aria-label="' + escapeHtml('Open the ' + g.title + ' page') +
            '"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>';
        if (isTable) {
            sortBar(sortKey, sortDir);
            const hasCounts = list.some(g => g.count !== null);
            const head = (key, label, cls, tip) => '<button type="button" class="cv-st-h' + (cls ? ' ' + cls : '') +
                (sortKey === key ? ' is-sorted' : '') + '" data-src-sort="' + key + '"' + (tip ? ' data-cv-tip="' + tip + '"' : '') + '>' + label + ' <i class="fas ' +
                (sortKey === key ? (sortDir === 'asc' ? 'fa-caret-up' : 'fa-caret-down') : 'fa-sort') + '" aria-hidden="true"></i></button>';
            // (an amount too small to show as a number is a plain zero, without the arrow)
            const flow = (lamports, up) => (formatCompact(lamportsToSol(lamports)) !== '0'
                ? '<span class="' + (up ? 'cv-vd-pos' : 'cv-vd-neg') + '"><i class="fas ' + (up ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down') +
                  '" aria-hidden="true"></i> ' + formatCompact(lamportsToSol(lamports)) + '</span>'
                : '<span class="cv-vd-muted">0</span>');
            const zero = label => '<span class="cv-st-c" data-label="' + label + '"><span class="cv-vd-muted">0</span></span>';
            // The pool name is the only link of a row; the arrow next to it says so.
            const rowHtml = g => {
                const d = g.delta === null ? null : cvSignedSol(g.delta);
                return '<div class="cv-st-row">' +
                    '<span class="cv-st-c cv-st-source"><a class="cv-st-logo" data-cv-nav href="' + href(g) + '" tabindex="-1" aria-hidden="true">' +
                    cvSourceLogoMini(g, 96) + '</a><span class="cv-vd-src-text"><a class="cv-vd-src-name" data-cv-nav href="' +
                    href(g) + '" data-cv-tip="' + goTip(g) + '">' + cvLinkLabelHtml(g.title) + '</a><span class="cv-vd-src-cat">' +
                    escapeHtml(catTitle(g.category)) + '</span></span></span>' +
                    '<span class="cv-st-c" data-label="Active stake, SOL">' + formatNumber(lamportsToSol(g.active), 2) + '</span>' +
                    '<span class="cv-st-c cv-st-share" data-label="Share of validator"><span class="cv-st-bar"><i style="width:' +
                    Math.max(1, Math.min(100, g.share)).toFixed(1) + '%"></i></span><span class="cv-st-pct">' + pct(g) + '</span></span>' +
                    (hasCounts ? '<span class="cv-st-c" data-label="Stake accounts">' + (g.count !== null ? formatNumber(g.count) : '') + '</span>' : '') +
                    '<span class="cv-st-c" data-label="Activating">' + flow(g.activating, true) + '</span>' +
                    '<span class="cv-st-c" data-label="Deactivating">' + flow(g.deactivating, false) + '</span>' +
                    '<span class="cv-st-c" data-label="Change vs epoch ' + (E - 1) + '">' +
                    (d ? '<span class="' + d.cls + '">' + d.text + '</span>' : '<span class="cv-vd-muted">-</span>') + '</span>' +
                    '<span class="cv-st-c cv-st-trend" data-label="Stake over time">' + cvMiniSpark(seriesFull(g.name), E) + '</span>' + corner(g) + '</div>';
            };
            const pastRowHtml = p => {
                const d = p.delta === null ? null : cvSignedSol(p.delta);
                return '<div class="cv-st-row is-past">' +
                    '<span class="cv-st-c cv-st-source">' + cvSourceLogoMini(p, 96) + '<span class="cv-vd-src-text"><span class="cv-vd-src-name">' +
                    escapeHtml(p.title) + '</span><span class="cv-vd-src-cat">' + escapeHtml(catTitle(p.category)) + '</span><span class="cv-vd-past-line">' +
                    pastStatus(p) + '</span></span></span>' + zero('Active stake, SOL') +
                    '<span class="cv-st-c cv-st-share" data-label="Share of validator"><span class="cv-st-bar"></span><span class="cv-st-pct cv-vd-muted">0%</span></span>' +
                    (hasCounts ? zero('Stake accounts') : '') + zero('Activating') + zero('Deactivating') +
                    '<span class="cv-st-c" data-label="Change vs epoch ' + (E - 1) + '">' +
                    (d ? '<span class="' + d.cls + '">' + d.text + '</span>' : '<span class="cv-vd-muted">-</span>') + '</span>' +
                    '<span class="cv-st-c cv-st-trend" data-label="Stake over time">' + cvMiniSpark(seriesFull(p.name), E) + '</span></div>';
            };
            let rows = '';
            if (sortKey === 'category') {
                cats.forEach(cat => {
                    const inCat = byActive(list.filter(g => g.category === cat));
                    const pastCat = pastList.filter(p => p.category === cat);
                    if (!inCat.length && !pastCat.length) return;
                    const share = inCat.reduce((a, g) => a + g.share, 0);
                    rows += '<div class="cv-st-group"><span>' + escapeHtml(catTitle(cat)) + '</span><span class="cv-st-group-meta">' +
                        (inCat.length ? inCat.length + (inCat.length > 1 ? ' stakers, ' : ' staker, ') +
                            (share > 0 && share < 0.01 ? '&lt;0.01' : (share >= 10 ? share.toFixed(1) : share.toFixed(2))) + '% of stake' : 'no stake in this epoch') +
                        '</span></div>' + inCat.map(rowHtml).join('') + pastCat.map(pastRowHtml).join('');
                });
            } else {
                rows = sortedBy(list, sortKey, sortDir).map(rowHtml).join('') + pastList.map(pastRowHtml).join('');
            }
            body.innerHTML = filterHtml + '<div class="cv-st' + (hasCounts ? '' : ' no-counts') + '"><div class="cv-st-row cv-st-head">' +
                head('name', 'Staker', 'cv-st-source') + head('active', 'Active, SOL') + head('active', 'Share') +
                (hasCounts ? head('accounts', 'Accounts') : '') + head('activating', 'Activating') + head('deactivating', 'Deactivating') +
                head('change', 'vs ' + (E - 1), '', 'Change of the active stake against epoch ' + (E - 1)) +
                '<div class="cv-st-h cv-st-trend">Stake over time</div></div>' + rows + '</div>' + smallHtml + countsNote;
            return;
        }
        // Cards keep their places when only the epoch changes, so a card
        // watched across epochs does not jump; a click on a sort button
        // (or any other change of the view) sorts them again.
        const freshAll = (key, dir) => (key === 'category'
            ? cats.reduce((acc, cat) => acc.concat(byActive(list.filter(g => g.category === cat)), pastList.filter(p => p.category === cat)), [])
            : sortedBy(list, key, dir).concat(pastList)).map(g => g.name);
        const fresh = freshAll(sortKey, sortDir);
        if (!cvCardOrder) cvCardOrder = { names: fresh.slice(), epoch: E };
        const pos = new Map(cvCardOrder.names.map((n, i) => [n, i]));
        fresh.forEach(n => { if (!pos.has(n)) { pos.set(n, pos.size); cvCardOrder.names.push(n); } });
        const ordered = list.concat(pastList).sort((a, b) => pos.get(a.name) - pos.get(b.name));
        const names = ordered.map(g => g.name);
        const same = (a, b) => a.length === b.length && a.every((n, i) => n === b[i]);
        let barKey = same(names, fresh) ? sortKey : null;
        let barDir = sortDir;
        if (barKey === null) {
            ['category', 'active', 'activating', 'deactivating', 'change'].forEach(k => ['desc', 'asc'].forEach(d => {
                if (barKey === null && same(names, freshAll(k, d))) { barKey = k; barDir = d; }
            }));
        }
        sortBar(barKey, barDir, barKey === null
            ? '<span class="cv-vd-kept" data-cv-tip="The cards stay where they were so you can follow one across epochs. A sort button puts them in order again.">Card order kept from epoch ' +
              cvCardOrder.epoch + '</span>' : '');
        const charts = [];
        const logoHtml = g => ((g.name === 'OTHER' || !isValidHttpUrl(g.def.image))
            ? '<div class="card-header-logo card-header-logo-svg">' + (g.name === 'OTHER' ? otherIsoImg(96) + OTHER_GROUP_SVG
                : '<span class="cv-src-initials">' + escapeHtml(getInitials(g.title)) + '</span>') + '</div>'
            : '<div class="card-header-logo"><img src="' + escapeHtml(resolveLogoUrlSync(g.def.image,
                document.body.classList.contains('dark-theme-body'), 96)) + '" data-logo-default="' + escapeHtml(g.def.image) + '" data-logo-iso="96" alt=""></div>');
        const chartHtml = name => {
            if (m.historyState !== 'ok') return '';
            const id = 'cv-src-chart-' + (++cvChartSeq);
            charts.push({ id, points: series(name) });
            return '<div class="interactive-chart-container" id="' + id + '"></div>';
        };
        const item = (icon, cls, label, value) => '<div class="breakdown-item"><span class="label"><i class="fas ' + icon + ' ' + cls +
            '"></i> ' + label + epochNote + '</span><span class="value">' + value + '</span></div>';
        const cardHtml = g => '<div class="sp-block sp-group-card cv-src-card"><div class="card-header"><a class="cv-src-link" data-cv-nav href="' + href(g) +
            '" data-cv-tip="' + goTip(g) + '">' + logoHtml(g) + '<span class="pool-name">' + cvLinkLabelHtml(g.title) + '</span></a>' + corner(g) + '</div>' +
            '<div class="card-body"><div class="card-main-content"><div class="card-stats">' +
            '<div class="stat-item"><span class="label">Active Stake' + epochNote + '</span><span class="value">' +
            formatNumber(lamportsToSol(g.active), 2) + '</span></div>' +
            '<div class="stat-item"><span class="label">Share of validator' + epochNote + '</span><span class="value">' + pct(g) + '</span></div>' +
            '</div>' + chartHtml(g.name) + '<div class="stake-breakdown">' +
            item('fa-arrow-trend-up', 'icon-activating', 'Activating', formatNumber(lamportsToSol(g.activating), 2) + ' SOL') +
            item('fa-arrow-trend-down', 'icon-deactivating', 'Deactivating', formatNumber(lamportsToSol(g.deactivating), 2) + ' SOL') +
            (g.count !== null ? item('fa-wallet', 'icon-total-validators', 'Stake accounts', formatNumber(g.count)) : '') +
            '</div></div></div></div>';
        const pastCardHtml = p => '<div class="sp-block sp-group-card cv-src-card is-past"><div class="card-header"><div class="cv-src-link">' +
            logoHtml(p) + '<span class="pool-name">' + escapeHtml(p.title) + '</span></div></div>' +
            '<div class="card-body"><div class="card-main-content"><div class="cv-vd-past-line">' + pastStatus(p) + '</div><div class="card-stats">' +
            '<div class="stat-item"><span class="label">Active Stake' + epochNote + '</span><span class="value">0</span></div>' +
            '<div class="stat-item"><span class="label">Share of validator' + epochNote + '</span><span class="value">0%</span></div>' +
            '</div>' + chartHtml(p.name) + '<div class="stake-breakdown">' +
            '<div class="breakdown-item"><span class="label"><i class="fas fa-mountain icon-total-validators"></i> Peak stake</span><span class="value">' +
            formatCompact(lamportsToSol(p.peak)) + ' SOL in epoch ' + p.peakEpoch + '</span></div></div></div></div></div>';
        const anyCard = g => (g.past ? pastCardHtml(g) : cardHtml(g));
        let html = '';
        if (sortKey === 'category') {
            html = '<div class="cv-cat-flow">';
            cats.forEach(cat => {
                const inCat = ordered.filter(g => g.category === cat);
                const n = inCat.length;
                if (!n) return;
                html += '<div class="category-section cv-cat-n' + Math.min(n, 3) + '"><div class="category-header"><div class="title">' + escapeHtml(catTitle(cat)) +
                    '</div><div class="meta">' + n + (n > 1 ? ' stakers' : ' staker') + '</div></div><div class="sp-groups-grid">' +
                    inCat.map(anyCard).join('') + '</div></div>';
            });
            html += '</div>';
        } else {
            html = '<div class="sp-groups-grid cv-vd-flat-grid">' + ordered.map(anyCard).join('') + '</div>';
        }
        body.innerHTML = filterHtml + html + smallHtml + countsNote;
        charts.forEach(c => cvRenderEpochChart(document.getElementById(c.id), c.points,
            { height: 76, grid: true, stats: true, zeroBreak: true, highlightEpoch: E, onPick: cvVdSelectEpoch }));
    }

    // ---------- shared pieces of the page ----------
    // Profile fields of a validator that left: the newest full snapshot in
    // memory that still has it (a visitor who came from an old epoch has one).
    function cvFindLoadedInfo(vote) {
        const epochs = Array.from(epochMap.keys()).sort((a, b) => Number(b) - Number(a));
        for (const ep of epochs) {
            const snap = epochMap.get(ep);
            if (!snap || snap.__aggregated || !Array.isArray(snap.validators)) continue;
            const row = snap.validators.find(v => v.info && v.info.vote_pubkey === vote);
            if (row) return row.info;
        }
        return null;
    }
    function cvVdAvatarHtml(m) {
        return (m.iconUrl && !brokenImages.has(m.iconUrl))
            ? '<img class="validator-image" src="' + escapeHtml(m.iconUrl) + '" alt="" data-fb-name="' +
              escapeHtml(m.displayName) + '" data-fb-key="' + escapeHtml(m.identity) + '">'
            : createFallbackImage(m.displayName, m.identity);
    }
    // Pools of one epoch: shown (reach the 0.1 SOL threshold) and small.
    function cvEntrySources(m, entry) {
        const all = entry.groups.map(g => {
            const def = cvSourceDef(g.name);
            return { name: g.name, active: g.active, activating: g.activating, deactivating: g.deactivating,
                count: g.count, def, title: cvSourceTitle(g.name, def), category: def.category || 'OTHER' };
        });
        return {
            all,
            shown: all.filter(g => meetsStakeThreshold(g.active, g.activating)),
            small: all.filter(g => !meetsStakeThreshold(g.active, g.activating) &&
                (g.active > 0 || g.activating > 0 || g.deactivating > 0)).sort((a, b) => b.active - a.active)
        };
    }
    // History of one pool in this validator. It starts where the pool
    // enters the system (as its chart on the main page does), not at the
    // validator's first epoch: before that the pool did not exist here.
    function cvSourceSeries(m, name, full) {
        const first = full ? m.epochs[0]
            : m.epochs.find(e => e.groups.some(s => s.name === name && (s.active > 0 || s.activating > 0)));
        if (!first) return [];
        return m.epochs.filter(e => e.epoch >= first.epoch).map(e => {
            const x = e.groups.find(s => s.name === name);
            return { epoch: e.epoch, ts: e.ts, value: lamportsToSol(x ? x.active : 0) };
        });
    }
    // Small static line for a table row; a missing epoch breaks the line.
    function cvMiniSpark(points, markEpoch) {
        if (!points || points.length < 2) return '';
        const W = 120;
        const H = 28;
        const P = 3;
        const e0 = points[0].epoch;
        const e1 = points[points.length - 1].epoch;
        const vals = points.map(p => p.value);
        const lo = Math.min.apply(null, vals);
        const span = (Math.max.apply(null, vals) - lo) || 1;
        const x = p => ((p.epoch - e0) / ((e1 - e0) || 1)) * W;
        const y = p => H - P - ((p.value - lo) / span) * (H - 2 * P);
        // Epochs with stake draw the line; epochs without it a grey dashed one.
        let held = '';
        let idle = '';
        points.forEach((p, i) => {
            const prev = i > 0 ? points[i - 1] : null;
            const zero = !(p.value > 0);
            const joined = !!prev && p.epoch - prev.epoch === 1 && !(prev.value > 0) === zero;
            const cmd = (joined ? 'L' : 'M') + x(p).toFixed(1) + ',' + y(p).toFixed(1) + ' ';
            if (zero) idle += cmd; else held += cmd;
        });
        const mark = (markEpoch !== undefined && markEpoch !== null && Number(markEpoch) !== e1)
            ? points.find(p => p.epoch === Number(markEpoch)) : null;
        return '<svg class="cv-mini-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
            (idle ? '<path class="cv-mini-idle" d="' + idle + '"/>' : '') + (held ? '<path d="' + held + '"/>' : '') +
            (mark ? '<path class="cv-mini-mark" d="M' + x(mark).toFixed(1) + ',' + y(mark).toFixed(1) + ' h0.01"/>' : '') + '</svg>';
    }
    function cvSourceValue(g, key) {
        if (key === 'name') return g.title.toLowerCase();
        if (key === 'activating') return g.activating;
        if (key === 'deactivating') return g.deactivating;
        if (key === 'accounts') return g.count === null ? -1 : g.count;
        if (key === 'change') return g.delta === null ? 0 : g.delta;
        return g.active;
    }
    function cvVdRerenderPools() {
        const m = cvVd;
        if (!m) return;
        const idx = m.epochs.findIndex(e => e.epoch === m.selectedEpoch);
        const entry = idx >= 0 ? m.epochs[idx] : null;
        cvRichTips.clear();
        cvRenderDonut(m, entry, m.avatarHtml);
        cvVdRenderSources(m, entry, idx);
    }

    // ---------- donut: where the stake comes from ----------
    // Colours of the stakers in the donut. Each staker of a validator gets
    // one for the whole page (see poolColors in cvBuildModel), so a colour
    // never changes from epoch to epoch.
    const CV_PALETTE = ['#4C8DF6', '#F5A524', '#14C99B', '#EC5F8A', '#9945FF', '#8BC34A', '#22B8CF', '#FF8A4C', '#C9A227', '#E055C8',
        '#7C6CF2', '#2FA37C', '#D9534F', '#A3A948', '#B07AA1', '#6B8E9F', '#F28E9C', '#86BCB6', '#9C755F', '#D4A6C8'];
    function cvPaletteColor(i) {
        if (i < CV_PALETTE.length) return CV_PALETTE[i];
        return 'hsl(' + Math.round((i * 137.508) % 360) + ', 62%, ' + (i % 2 ? 58 : 46) + '%)';
    }
    function cvPoolColor(m, name) {
        if (name === 'OTHER') return '#8A94A6';
        return (m.poolColors && m.poolColors.get(name)) || '#B8C0CC';
    }
    function cvRenderDonut(m, entry, avatarHtml) {
        const box = document.getElementById('cv-vd-donut');
        if (!box) return;
        const shown = entry ? cvEntrySources(m, entry).shown.sort((a, b) => b.active - a.active) : [];
        if (!shown.length || !(entry.active > 0)) {
            box.innerHTML = '<div class="chart-no-data">No stake above ' + lamportsToSol(MIN_ACTIVE_STAKE) + ' SOL in this epoch</div>';
            return;
        }
        const pctText = share => (share * 100 >= 10 ? (share * 100).toFixed(1) : (share * 100).toFixed(2)) + '%';
        const poolRow = g => cvTipRow(cvSourceLogoMini(g), g.title, formatCompact(lamportsToSol(g.active)) + ' SOL<span class="cv-tip-dim">' +
            pctText(g.active / entry.active) + '</span>');
        // A pool under 1% of this validator's stake is too thin to see as a
        // slice: such pools share one grey slice (only when there are many).
        const thin = cvThinPools(entry, shown);
        const thinNames = new Set(thin.map(g => g.name));
        const segs = [];
        shown.forEach(g => {
            if (thinNames.has(g.name)) return;
            const share = g.active / entry.active;
            segs.push({ key: g.name, g, title: g.title, active: g.active, share, color: cvPoolColor(m, g.name),
                tip: cvRich('<div class="pool-tooltip-title cv-tip-pool">' + cvSourceLogoMini(g) + '<span>' + escapeHtml(g.title) + '</span></div>' +
                    cvTipRow('', 'Active stake', formatNumber(lamportsToSol(g.active), 2) + ' SOL') +
                    cvTipRow('', 'Share of validator', pctText(share)) + '<div class="cv-flow-more">Click: show only this staker below</div>') });
        });
        if (thin.length) {
            const sum = thin.reduce((a, g) => a + g.active, 0);
            const label = thin.length + (thin.length > 1 ? ' stakers' : ' staker') + ' under 1%';
            segs.push({ key: CV_THIN_KEY, g: null, title: label, active: sum, share: sum / entry.active, color: '#B8C0CC',
                tip: cvRich('<div class="pool-tooltip-title">' + label + ' of the validator stake</div>' + thin.slice(0, 12).map(poolRow).join('') +
                    (thin.length > 12 ? '<div class="cv-flow-more">and ' + (thin.length - 12) + ' more</div>' : '') +
                    '<div class="cv-flow-more">Click: show only these stakers below</div>') });
        }
        const R = 70;
        const C = 2 * Math.PI * R;
        let off = 0;
        const stable = new Map(Array.from((m.poolColors || new Map()).keys()).map((n, i) => [n, i]));
        const ringPos = sg => (!sg.g ? 1e7 : (stable.has(sg.g.name) ? stable.get(sg.g.name) : 1e6));
        const arcs = segs.slice().sort((a, b) => ringPos(a) - ringPos(b)).map(sg => {
            const full = sg.share * C;
            const len = Math.max(0.5, full - (segs.length > 1 ? 2 : 0));
            const html = '<circle class="cv-donut-seg' + (sg.key === cvPoolFilter ? ' is-selected' : '') + '" cx="90" cy="90" r="' + R +
                '" fill="none" stroke="' + sg.color + '" stroke-width="22" stroke-dasharray="' + len.toFixed(2) + ' ' + (C - len).toFixed(2) +
                '" stroke-dashoffset="' + (-off).toFixed(2) + '" data-cv-pool="' + escapeHtml(sg.key) + '"' + sg.tip + '></circle>';
            off += full;
            return html;
        }).join('');
        // The legend lists the pools with a slice of their own (up to eight)
        // and always ends with the merged "under 1%" row, which is a filter too.
        const LIMIT = 8;
        const single = segs.filter(sg => sg.g);
        const rest = single.slice(LIMIT);
        const legend = single.slice(0, LIMIT).concat(segs.filter(sg => !sg.g)).map(sg =>
            '<button type="button" class="cv-donut-row' + (sg.key === cvPoolFilter ? ' is-selected' : '') + '" data-cv-pool="' + escapeHtml(sg.key) + '"' +
            (sg.g ? '' : sg.tip) + '><span class="cv-donut-dot" style="background:' + sg.color + '"></span>' + (sg.g ? cvSourceLogoMini(sg.g) : '') +
            '<span class="cv-donut-name">' + escapeHtml(sg.title) + '</span><span class="cv-donut-share">' + pctText(sg.share) +
            '</span><span class="cv-donut-sol">' + formatCompact(lamportsToSol(sg.active)) + '</span></button>').join('') +
            (rest.length ? '<div class="cv-donut-more"><span' + cvRich(rest.map(sg => (sg.g ? poolRow(sg.g)
                : cvTipRow('', sg.title, formatCompact(lamportsToSol(sg.active)) + ' SOL<span class="cv-tip-dim">' + pctText(sg.share) + '</span>'))).join('')) +
                '>and ' + rest.length + ' more</span></div>' : '');
        box.innerHTML = '<div class="cv-donut-wrap"><svg class="cv-donut-svg' + (cvPoolFilter ? ' has-selection' : '') +
            '" viewBox="0 0 180 180" role="img" aria-label="Stake by staker"><g transform="rotate(-90 90 90)">' + arcs +
            '</g></svg><div class="cv-donut-center">' + (avatarHtml || cvVdAvatarHtml(m)) + '</div></div>' +
            '<div class="cv-donut-legend">' + legend + '</div>';
    }

    // ---------- tooltips of the metric cards ----------
    function cvTipRow(logoHtml, name, valueHtml, cls) {
        return '<div class="cv-flow-row">' + (logoHtml || '') + '<span class="cv-flow-name">' + escapeHtml(name) + '</span>' +
            '<span class="cv-flow-val' + (cls ? ' ' + cls : '') + '">' + valueHtml + '</span></div>';
    }
    function showCvVdTip(el) {
        const m = cvVd;
        if (!m) return;
        if (cvPinnedTip && cvPinnedTip.__card === el) return;
        const kind = el.getAttribute('data-cv-vdtip');
        const entry = m.epochs.find(e => e.epoch === m.selectedEpoch);
        if (!entry) return;
        const E = entry.epoch;
        const isPast = E !== Number(latestEpochNumber);
        const inEpoch = isPast ? ' in epoch ' + E : '';
        const title = text => '<div class="pool-tooltip-title">' + escapeHtml(text) + '</div>';
        const more = text => '<div class="cv-flow-more">' + escapeHtml(text) + '</div>';
        const LIMIT = 12;
        let html = '';
        if (kind === 'activating' || kind === 'deactivating') {
            const up = kind === 'activating';
            const rows = cvEntrySources(m, entry).all.filter(g => g[kind] >= MIN_ACTIVE_STAKE).sort((a, b) => b[kind] - a[kind]);
            html = title((up ? 'Activating' : 'Deactivating') + ' by staker' + inEpoch);
            if (!rows.length) html += more('Nothing above ' + lamportsToSol(MIN_ACTIVE_STAKE) + ' SOL');
            rows.slice(0, LIMIT).forEach(g => {
                html += cvTipRow(cvSourceLogoMini(g), g.title, '<i class="fas ' + (up ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down') +
                    '" aria-hidden="true"></i>' + formatCompact(lamportsToSol(g[kind])), up ? 'is-up' : 'is-down');
            });
            if (rows.length > LIMIT) html += more('and ' + (rows.length - LIMIT) + ' more');
        } else if (kind === 'accounts') {
            const rows = cvEntrySources(m, entry).all.filter(g => g.count !== null && g.count > 0).sort((a, b) => b.count - a.count);
            html = title('Stake accounts by staker' + inEpoch);
            if (!rows.length) html += more('Counts per staker are recorded for the current epoch only');
            rows.slice(0, LIMIT).forEach(g => { html += cvTipRow(cvSourceLogoMini(g), g.title, formatNumber(g.count)); });
            if (rows.length > LIMIT) html += more('and ' + (rows.length - LIMIT) + ' more');
        } else if (kind === 'age') {
            const then = cvAgeAt(m, entry);
            const now = cvAgeNow(m);
            html = title('Vote account age');
            if (!then) {
                html += more(m.ageUnavailable ? 'Age unavailable right now' : 'No age data for this vote account');
            } else {
                if (E !== m.lastEpoch && now) {
                    html += cvTipRow('', 'In epoch ' + E, escapeHtml(cvAgeText(then)) + ' epochs') +
                        cvTipRow('', m.isActive ? 'Now' : 'In its last epoch', escapeHtml(cvAgeText(now)) + ' epochs');
                } else {
                    html += cvTipRow('', 'Epochs with votes', escapeHtml(cvAgeText(then)));
                }
                html += more('Counts the epochs in which this vote account voted');
            }
        } else if (kind === 'rank') {
            html = title('Stake rank' + inEpoch);
            html += cvTipRow('', 'By active stake', entry.rank ? '#' + formatNumber(entry.rank) : '-');
            const live = cvLiveSnapshot();
            if (entry.isLive && live) html += cvTipRow('', 'Validators in this epoch', formatNumber(live.validators.length));
            const ranked = m.epochs.filter(e => e.rank);
            if (m.historyState === 'ok' && ranked.length > 1) {
                const best = ranked.reduce((a, e) => (e.rank < a.rank ? e : a), ranked[0]);
                const worst = ranked.reduce((a, e) => (e.rank > a.rank ? e : a), ranked[0]);
                html += cvTipRow('', 'Best, epoch ' + best.epoch, '#' + formatNumber(best.rank)) +
                    cvTipRow('', 'Lowest, epoch ' + worst.epoch, '#' + formatNumber(worst.rank));
            }
        } else {
            return;
        }
        const who = m.shownName || m.displayName;
        cvShowTipHtml(el, '<div class="cv-tip-who">' + cvMiniLogoHtml(m.shownIcon, who, m.shownIdentity) + '<span>' + escapeHtml(who) + '</span></div>' + html);
    }

    // ---------- search: former names and inactive validators ----------
    // The validators index (former names, validators that left) loads the
    // first time someone searches; the list then filters again with it.
    function cvEnsureIndexForSearch(query) {
        if (!query || cvIndexData) return;
        loadValidatorsIndex().then(index => {
            if (!index || !searchQuery) return;
            const stalePill = document.getElementById('epoch-stale-pill');
            const epochSel = document.getElementById('epoch-select');
            const isStale = !!stalePill && stalePill.style.display !== 'none';
            const epoch = epochSel ? epochSel.value : null;
            filterValidators();
            sortValidators();
            updateValidatorStats(isStale, epoch);
            renderValidatorsListItems();
        });
    }
    // Validators that match the search but hold no stake now: listed under
    // the results, marked inactive, each a link to its page.
    function cvInactiveMatchesHtml() {
        if (!searchQuery || !cvIndexData || isPoolSearchMode) return '';
        const terms = splitSearchTerms(searchQuery).filter(t => t.length >= 2);
        if (!terms.length) return '';
        const shown = new Set(validatorsData.map(v => (v.info ? v.info.vote_pubkey : '')));
        const live = cvLiveSnapshot();
        const liveVotes = new Set(live ? live.validators.map(v => (v.info ? v.info.vote_pubkey : '')) : []);
        const hits = cvIndexData.validators.filter(r => {
            if (shown.has(r.vote) || liveVotes.has(r.vote)) return false;
            const text = [r.name || '', r.vote || '', r.identity || ''].concat(r.aliases || []).join(' ').toLowerCase();
            return terms.some(t => text.includes(t));
        }).sort((a, b) => (b.last_epoch - a.last_epoch) || ((b.active_lamports || 0) - (a.active_lamports || 0)));
        if (!hits.length) return '';
        const LIMIT = 20;
        const rows = hits.slice(0, LIMIT).map(r => {
            const raw = String(r.name || '').trim();
            const name = hasRealName(raw) ? raw : shortenPubkey(raw || r.vote);
            const hit = cvNameHit(r.vote, raw, true);
            const href = escapeHtml(validatorHref(r.vote, null));
            const info = cvFindLoadedInfo(r.vote);
            const icon = info && isValidHttpUrl(info.icon_url) && !brokenImages.has(info.icon_url) ? info.icon_url : '';
            return '<div class="cv-inactive-row">' +
                '<a class="cv-inactive-avatar" data-cv-nav href="' + href + '" tabindex="-1" aria-hidden="true">' +
                (icon ? '<img src="' + escapeHtml(icon) + '" alt="">' : escapeHtml(getInitials(name, r.identity))) + '</a>' +
                '<div class="cv-inactive-main"><a class="cv-inactive-name cv-vlink" data-cv-nav href="' + href + '">' + escapeHtml(name) +
                CV_GO_SVG + '</a>' +
                (hit ? '<span class="cv-formerly">' + hit.label + ' <b>' + escapeHtml(hit.name) + '</b></span>' : '') +
                '<div class="cv-keys cv-inactive-keys">' + (r.identity ? keyTokenHtml('ID', r.identity) : '') + keyTokenHtml('Vote', r.vote) + '</div>' +
                '<div class="cv-inactive-chips"' + (r.last_epoch >= META_FIRST_EPOCH ? ' data-vote="' + escapeHtml(r.vote) + '"' : '') + '></div></div>' +
                '<span class="cv-inactive-meta">Inactive since epoch ' + (r.last_epoch + 1) + '</span>' +
                '<span class="cv-inactive-stake">' + formatCompact(lamportsToSol(r.active_lamports || 0)) + ' SOL in epoch ' + r.last_epoch + '</span></div>';
        }).join('');
        return '<div class="cv-inactive-block"><div class="cv-inactive-head"><i class="fas fa-power-off" aria-hidden="true"></i>Inactive validators (' +
            hits.length + ')<span>no stake in the current epoch; each page keeps the history</span></div>' + rows +
            (hits.length > LIMIT ? '<div class="cv-inactive-more">and ' + (hits.length - LIMIT) + ' more: add letters to narrow the search</div>' : '') + '</div>';
    }
    // Vote account age of a list row: registry value + 1 once it has credits
    // in the epoch of the snapshot.
    function cvListAge(v) {
        const meta = v ? v.meta : null;
        if (meta && typeof meta.validator_age === 'number') {
            return { value: meta.validator_age + (meta.epoch_credits > 0 ? 1 : 0), isMin: meta.validator_age_is_min === true };
        }
        // Snapshots before epoch 1043 carry no age: estimate it from the
        // registry value in the validators index, minus the epochs since.
        const row = (cvIndexByVote && v && v.info) ? cvIndexByVote.get(v.info.vote_pubkey) : null;
        if (!row || typeof row.validator_age !== 'number' || !isFinite(validatorsListEpoch)) return null;
        const since = Math.max(0, Number(row.validator_age_epoch) - validatorsListEpoch);
        return { value: Math.max(0, row.validator_age - since), isMin: row.validator_age_is_min === true, approx: true };
    }
    // Meta chips of a list row; the age chip joins only in the Age sort mode.
    function cvListMetaHtml(v) {
        const html = buildMetaChipsHtml(v.meta, validatorsScriptInfo);
        if (validatorsSortMode !== 'age' || !validatorsHasAge) return html;
        const a = cvListAge(v);
        const tip = !a ? 'No age data for this vote account'
            : (a.approx ? 'Estimated age in this epoch: the current age minus the epochs since. Exact for a validator that voted in every one of them.'
                : 'Vote account age: ' + cvAgeText(a) + ' epochs with votes');
        const chip = '<span class="cv-chip cv-chip-age' + (a ? '' : ' is-missing') + '" data-cv-tip="' + escapeHtml(tip) +
            '"><span class="cv-seg"><i class="fas fa-hourglass-half" aria-hidden="true"></i>' +
            (a ? (a.approx ? '~' : '') + escapeHtml(cvAgeText(a)) + ' ep' : '-') + '</span></span>';
        return html ? html.replace(/<\/div>$/, chip + '</div>') : '<div class="cv-meta">' + chip + '</div>';
    }

    // ---------- round 3 helpers ----------
    // The validator's row in the full snapshot of an epoch, when that
    // snapshot is in memory.
    function cvLoadedRowAt(vote, epoch) {
        const snap = epochMap.get(Number(epoch));
        if (!snap || snap.__aggregated || !Array.isArray(snap.validators)) return null;
        return snap.validators.find(v => v.info && v.info.vote_pubkey === vote) || null;
    }
    // Website button and description of the header (the current ones, or
    // those of the selected epoch when its full snapshot is in memory).
    function cvVdSetProfile(website, detailsText) {
        const site = document.getElementById('cv-vd-website');
        if (site) {
            if (website) {
                site.href = website;
                site.classList.remove('pool-official-link-hidden');
            } else {
                site.removeAttribute('href');
                site.classList.add('pool-official-link-hidden');
            }
        }
        const details = document.getElementById('cv-vd-details');
        if (!details || details.__cvText === detailsText) return;
        details.__cvText = detailsText;
        details.innerHTML = detailsText
            ? '<div class="pool-details"><div class="desc-wrap" style="--desc-lines:3" role="button" tabindex="0"><p class="desc-text">' +
              escapeHtml(detailsText) + '</p></div></div>'
            : '';
        if (detailsText) initDescriptionCollapsers(details);
    }
    function cvAvatarHtml(iconUrl, name, key) {
        return (iconUrl && !brokenImages.has(iconUrl))
            ? '<img class="validator-image" src="' + escapeHtml(iconUrl) + '" alt="" data-fb-name="' + escapeHtml(name) +
              '" data-fb-key="' + escapeHtml(key || '') + '">'
            : createFallbackImage(name, key || '');
    }
    // Pools that hold no stake with this validator in the selected epoch but
    // did in another one. before = the latest earlier epoch with stake,
    // after = the first later one.
    function cvPastPools(m, entry, shown) {
        const present = new Set(shown.map(g => g.name));
        const acc = new Map();
        m.epochs.forEach(e => e.groups.forEach(g => {
            if (present.has(g.name) || !meetsStakeThreshold(g.active, g.activating)) return;
            let a = acc.get(g.name);
            if (!a) {
                const def = cvSourceDef(g.name);
                a = { name: g.name, def, title: cvSourceTitle(g.name, def), category: def.category || 'OTHER', past: true,
                    active: 0, activating: 0, deactivating: 0, count: null, before: null, after: null, peak: 0, peakEpoch: e.epoch };
                acc.set(g.name, a);
            }
            if (e.epoch < entry.epoch) a.before = e.epoch;
            else if (e.epoch > entry.epoch && a.after === null) a.after = e.epoch;
            if (g.active > a.peak) { a.peak = g.active; a.peakEpoch = e.epoch; }
        }));
        return Array.from(acc.values()).sort((a, b) => b.peak - a.peak);
    }
    // A click on a metric card pins its tooltip: it stays, becomes solid and
    // selectable, until a click elsewhere, a scroll or Escape.
    let cvPinnedTip = null;
    function cvVdUnpinTip() {
        if (cvPinnedTip) cvPinnedTip.remove();
        cvPinnedTip = null;
    }
    function cvVdPinTip(card) {
        const same = cvPinnedTip && cvPinnedTip.__card === card;
        cvVdUnpinTip();
        if (same) return;
        showCvVdTip(card);
        const tip = document.getElementById('dynamic-pool-tooltip');
        if (!tip) return;
        tip.id = 'cv-pinned-tip';
        tip.classList.add('is-pinned');
        tip.__card = card;
        cvPinnedTip = tip;
    }
    // Names a validator can be found by: former names and, on a past epoch
    // where the list shows the old name, the current one.
    function cvNamesFor(vote) {
        if (!cvAliasMap) return [];
        const names = (cvAliasMap.get(vote) || []).slice();
        const now = cvNowNameMap ? cvNowNameMap.get(vote) : '';
        if (now) names.push(now);
        return names;
    }
    // The other name that made a validator match the search, with its label:
    // "now" for the current name, "formerly" (latest epoch) or "also known
    // as" (a past epoch, where the other name may be an earlier or a later one).
    function cvNameHit(vote, shownName, forceFormerly) {
        if (!cvAliasMap) return null;
        const cur = String(shownName || '').trim().toLowerCase();
        const latest = forceFormerly === true || cvListIsLatest();
        if (!latest) {
            // A past epoch shows the name of then: add the name of today.
            const now = cvNowNameMap ? cvNowNameMap.get(vote) : '';
            if (now && hasRealName(now) && now.toLowerCase() !== cur) {
                return { label: cvLiveVoteSet().has(vote) ? 'now' : 'later', name: now };
            }
        }
        if (!searchQuery) return null;
        const terms = splitSearchTerms(searchQuery);
        const hits = n => {
            const low = String(n || '').toLowerCase();
            return low !== cur && terms.some(t => low.includes(t) && !cur.includes(t));
        };
        const aliases = cvAliasMap.get(vote) || [];
        for (let i = aliases.length - 1; i >= 0; i--) {
            if (hits(aliases[i])) return { label: latest ? 'formerly' : 'also known as', name: aliases[i] };
        }
        return null;
    }
    function cvListIsLatest() {
        const sel = document.getElementById('epoch-select');
        return !sel || Number(sel.value) === Number(latestEpochNumber);
    }
    // Last known commission and client of the inactive validators in the
    // search results (their history files; recorded from epoch 1042).
    function cvFillInactiveChips() {
        document.querySelectorAll('.cv-inactive-chips[data-vote]').forEach(box => {
            const vote = box.getAttribute('data-vote');
            box.removeAttribute('data-vote');
            loadValidatorShard(vote).then(res => {
                if (res.state !== 'ok' || !res.data || !Array.isArray(res.data.epochs) || !box.isConnected) return;
                const last = res.data.epochs[res.data.epochs.length - 1];
                if (!last || !last.meta) return;
                box.innerHTML = '<span class="cv-vd-asof"><i class="fas fa-hourglass-half" aria-hidden="true"></i>In epoch ' + last.epoch + '</span>' +
                    buildMetaChipsHtml(cvMetaFromShard(last.meta), { jito_metadata: { status: 'ok' } });
            });
        });
    }

    // ---------- round 4 helpers ----------
    // Arrow shown next to a name that opens another page of the dashboard
    // (a validator page, a pool page): on hover, always on touch screens.
    const CV_GO_SVG = '<svg class="cv-go" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 8h10M8.5 3.5L13 8l-4.5 4.5"/></svg>';
    const CV_THIN_KEY = '__under1__';
    // Link text with the arrow glued to the last word, so the arrow never
    // wraps to a line of its own.
    function cvLinkLabelHtml(title) {
        const words = String(title || '').trim().split(/\s+/);
        const last = words.pop() || '';
        return (words.length ? escapeHtml(words.join(' ')) + ' ' : '') + '<span class="cv-nw">' + escapeHtml(last) + CV_GO_SVG + '</span>';
    }
    // Pools under 1% of the validator's stake (merged in the donut when the
    // validator has more than six pools).
    function cvThinPools(entry, shown) {
        if (!entry || !(entry.active > 0) || shown.length <= 6) return [];
        return shown.filter(g => g.active / entry.active < 0.01);
    }
    // Tooltips with markup (pool logos, rows): the HTML waits in a map and the
    // element carries only its id.
    const cvRichTips = new Map();
    let cvRichSeq = 0;
    function cvRich(html) {
        const id = 'r' + (++cvRichSeq);
        cvRichTips.set(id, html);
        return ' data-cv-rich="' + id + '"';
    }
    function cvShowTipHtml(el, html) {
        const old = document.getElementById('dynamic-pool-tooltip');
        if (old) old.remove();
        const tip = document.createElement('div');
        tip.id = 'dynamic-pool-tooltip';
        tip.className = 'pool-tooltip cv-flow-tip';
        tip.innerHTML = html;
        document.body.appendChild(tip);
        positionTip(el, tip);
        tip.classList.add('visible');
    }
    function showCvRichTip(el) {
        const html = cvRichTips.get(el.getAttribute('data-cv-rich'));
        if (html) cvShowTipHtml(el, html);
    }
    function cvMiniLogoHtml(iconUrl, name, key) {
        return (iconUrl && !brokenImages.has(iconUrl))
            ? '<span class="cv-flow-logo cv-vd-mini"><img src="' + escapeHtml(iconUrl) + '" alt=""></span>'
            : '<span class="cv-flow-logo is-initials">' + escapeHtml(getInitials(name, key || '')) + '</span>';
    }
    // ---------- validators list: tooltips, inactive mark, age on old epochs ----------
    function cvListEpochLine() {
        const pill = document.getElementById('epoch-stale-pill');
        const sel = document.getElementById('epoch-select');
        return (pill && pill.style.display !== 'none' && sel)
            ? '<div class="pool-tooltip-epoch">Epoch ' + escapeHtml(String(sel.value)) + '</div>' : '';
    }
    // Tooltip of the active stake in a list row: the exact amount and the
    // number of stake accounts (the row itself shows a rounded number).
    function showListStakeTip(el, v) {
        const t = v.totals || {};
        cvShowTipHtml(el, '<div class="pool-tooltip-title">Active stake</div>' + cvListEpochLine() +
            cvTipRow('', 'Total', formatNumber(lamportsToSol(t.total_active_lamports || 0), 2) + ' SOL') +
            (typeof t.total_stake_accounts === 'number' ? cvTipRow('', 'Stake accounts', formatNumber(t.total_stake_accounts)) : ''));
    }
    let cvLiveVotes = null;
    let cvLiveVotesFor = null;
    function cvLiveVoteSet() {
        const snap = cvLiveSnapshot();
        if (cvLiveVotesFor !== snap) {
            cvLiveVotes = new Set(snap ? snap.validators.map(v => (v.info ? v.info.vote_pubkey : '')) : []);
            cvLiveVotesFor = snap;
        }
        return cvLiveVotes;
    }
    // On a past epoch: a mark on the validators that hold no stake now.
    function cvGoneBadgeHtml(vote) {
        if (!cvLiveSnapshot() || cvLiveVoteSet().has(vote)) return '';
        const row = cvIndexByVote ? cvIndexByVote.get(vote) : null;
        return '<div class="cv-gone-line"><span class="cv-gone-badge" data-cv-tip="This validator holds no stake in the current epoch">' +
            '<i class="fas fa-power-off" aria-hidden="true"></i>Inactive ' + (row ? 'since epoch ' + (row.last_epoch + 1) : 'now') + '</span></div>';
    }
    function cvRerenderList() {
        const pill = document.getElementById('epoch-stale-pill');
        const sel = document.getElementById('epoch-select');
        const isStale = !!pill && pill.style.display !== 'none';
        const epoch = sel ? sel.value : null;
        updateSortButtons(isStale, epoch);
        filterValidators();
        sortValidators();
        updateValidatorStats(isStale, epoch);
        renderValidatorsListItems();
    }
    // The validators index adds to a list of a past epoch what its snapshot
    // lacks: who is inactive now, and ages before epoch 1043.
    let cvIndexAsked = false;
    function cvEnsureIndexForList() {
        if (cvIndexData || cvIndexAsked) return;
        cvIndexAsked = true;
        loadValidatorsIndex().then(index => {
            cvIndexAsked = false;
            if (index) cvRerenderList();
        });
    }

    // ---------- changes ----------
    function cvMevState(meta) {
        if (!meta) return null;
        if (!meta.jito) return 'not running Jito';
        return typeof meta.jito.mev_commission_bps === 'number' ? formatBpsPercent(meta.jito.mev_commission_bps) : null;
    }
    function cvVdRenderChanges(m) {
        const body = document.getElementById('cv-vd-changes-body');
        if (!body) return;
        if (m.historyState !== 'ok') {
            body.innerHTML = '<div class="chart-no-data">' + escapeHtml(cvHistoryStateText(m)) + '</div>';
            return;
        }
        const ORDER = { Name: 0, Identity: 1, Commission: 2, 'MEV commission': 3, Client: 4, Version: 5 };
        const arrow = '<i class="fas fa-arrow-right cv-vd-arrow" aria-hidden="true"></i>';
        const rows = [];
        const add = (epoch, kind, fromHtml, toHtml) => rows.push({ epoch, kind, html: fromHtml + arrow + toHtml });
        const nameHtml = n => {
            const t = String(n || '').trim();
            return hasRealName(t) ? '<b>' + escapeHtml(t) + '</b>' : '<span class="cv-vd-muted">no name</span>';
        };
        const names = m.nameChanges.slice().sort((a, b) => a.epoch - b.epoch);
        names.forEach((c, i) => { if (i > 0) add(c.epoch, 'Name', nameHtml(names[i - 1].name), nameHtml(c.name)); });
        const ids = m.identityChanges.slice().sort((a, b) => a.epoch - b.epoch);
        ids.forEach((c, i) => { if (i > 0) add(c.epoch, 'Identity', keyTokenHtml('ID', ids[i - 1].identity), keyTokenHtml('ID', c.identity)); });
        // The current epoch is not in the history file yet: compare the live
        // name and identity with the last recorded ones.
        const live = m.epochs.length && m.epochs[m.epochs.length - 1].isLive ? m.epochs[m.epochs.length - 1] : null;
        if (live && names.length && String(names[names.length - 1].name || '').trim() !== m.rawName) {
            add(live.epoch, 'Name', nameHtml(names[names.length - 1].name), nameHtml(m.rawName));
        }
        if (live && ids.length && ids[ids.length - 1].identity !== m.identity && m.identity) {
            add(live.epoch, 'Identity', keyTokenHtml('ID', ids[ids.length - 1].identity), keyTokenHtml('ID', m.identity));
        }
        let prev = null;
        m.epochs.forEach(e => {
            if (!e.meta) return;
            if (prev) {
                const text = v => '<span>' + escapeHtml(v) + '</span>';
                const c0 = formatBpsPercent(metaCommissionBps(prev.meta));
                const c1 = formatBpsPercent(metaCommissionBps(e.meta));
                if (c0 && c1 && c0 !== c1) add(e.epoch, 'Commission', text(c0), text(c1));
                const m0 = cvMevState(prev.meta);
                const m1 = cvMevState(e.meta);
                if (m0 && m1 && m0 !== m1) add(e.epoch, 'MEV commission', text(m0), text(m1));
                const k0 = typeof prev.meta.client === 'string' ? resolveClient(prev.meta.client) : null;
                const k1 = typeof e.meta.client === 'string' ? resolveClient(e.meta.client) : null;
                if (k0 && k1 && k0.name !== k1.name) add(e.epoch, 'Client', text(k0.name), text(k1.name));
                const v0 = metaVersion(prev.meta);
                const v1 = metaVersion(e.meta);
                if (v0 && v1 && v0 !== v1) add(e.epoch, 'Version', text(v0), text(v1));
            }
            prev = e;
        });
        rows.sort((a, b) => (b.epoch - a.epoch) || (ORDER[a.kind] - ORDER[b.kind]));
        const firstEpoch = m.epochs.length ? m.epochs[0].epoch : DATASET_FIRST_EPOCH;
        const foot = '<p class="cv-vd-changes-foot">Name and identity are tracked since epoch ' + firstEpoch +
            '; commission, client and version since epoch ' + Math.max(META_FIRST_EPOCH, firstEpoch) + '.</p>';
        if (rows.length === 0) {
            body.innerHTML = '<div class="cv-vd-changes-empty">No changes recorded.</div>' + foot;
            return;
        }
        const visible = cvChangesExpanded ? rows : rows.slice(0, CHANGES_VISIBLE);
        body.innerHTML = '<div class="cv-vd-changes-list">' + visible.map(r =>
            '<div class="cv-vd-change"><button type="button" class="cv-vd-change-epoch" data-cv-epoch="' + r.epoch +
            '" data-cv-tip="Open epoch ' + r.epoch + '">Epoch ' + r.epoch + '</button><span class="cv-vd-change-kind">' + r.kind +
            '</span><span class="cv-vd-change-text">' + r.html + '</span></div>').join('') + '</div>' +
            (rows.length > visible.length ? '<button type="button" class="cv-vd-more" id="cv-vd-changes-more">Show all ' +
                rows.length + ' changes</button>' : '') + foot;
    }

    // ---------- wiring (called once from main) ----------
    let cvDynScaleMode = safeStorage.getItem('validatorDynamicsScaleMode') === 'separate' ? 'separate' : 'unified';
    function cvVdInit() {
        const view = document.getElementById('validator-detail-view');
        const sel = document.getElementById('validator-epoch-select');
        if (!view || !sel) return;
        sel.addEventListener('change', () => {
            if (!cvVd) return;
            cvVd.selectedEpoch = Number(sel.value);
            cvVdWriteUrl();
            cvVdRenderEpoch();
        });
        const scaleBtn = document.getElementById('cv-vd-scale-toggle');
        const scaleUi = () => {
            if (!scaleBtn) return;
            const label = scaleBtn.querySelector('.toggle-label');
            if (label) label.textContent = cvDynScaleMode === 'unified' ? 'Unified' : 'Separate';
            scaleBtn.classList.toggle('active', cvDynScaleMode === 'separate');
        };
        scaleUi();
        view.addEventListener('click', (e) => {
            const t = e.target;
            if (t.closest('#cv-vd-scale-toggle')) {
                cvDynScaleMode = cvDynScaleMode === 'unified' ? 'separate' : 'unified';
                safeStorage.setItem('validatorDynamicsScaleMode', cvDynScaleMode);
                scaleUi();
                if (cvVd) cvVdRenderEpoch();
                return;
            }
            const auxBtn = t.closest('#cv-vd-aux-toggle button[data-aux]');
            if (auxBtn) {
                cvAuxChart = auxBtn.getAttribute('data-aux') === 'rank' ? 'rank' : 'accounts';
                safeStorage.setItem('validatorAuxChart', cvAuxChart);
                if (cvVd) cvVdRenderEpoch();
                return;
            }
            const viewBtn = t.closest('#cv-vd-view-toggle button[data-view]');
            if (viewBtn) {
                cvSourcesView = viewBtn.getAttribute('data-view') === 'cards' ? 'cards' : 'table';
                safeStorage.setItem('validatorSourcesView', cvSourcesView);
                cvCardOrder = null;
                cvVdRerenderPools();
                return;
            }
            const sortEl = t.closest('[data-src-sort]');
            if (sortEl) {
                // One order for the table and the cards; a second click flips it.
                const key = sortEl.getAttribute('data-src-sort');
                // (a click on a button that is not lit, as when the cards kept an
                // older order, sorts again without flipping)
                if (cvSort.key === key && key !== 'category' && cvBarKey === key) cvSort.dir = cvSort.dir === 'desc' ? 'asc' : 'desc';
                else if (cvSort.key !== key) cvSort = { key, dir: key === 'name' ? 'asc' : 'desc' };
                cvCardOrder = null;
                cvVdRerenderPools();
                return;
            }
            const epochBtn = t.closest('[data-cv-epoch]');
            if (epochBtn) {
                e.preventDefault();
                cvVdSelectEpoch(Number(epochBtn.getAttribute('data-cv-epoch')), true);
                if (!epochBtn.hasAttribute('data-cv-stay')) window.scrollTo({ top: 0, behavior: 'smooth' });
                return;
            }
            // A slice or a legend row of the donut narrows the pools below to
            // that pool, the way the pool page donut narrows its table.
            const poolPick = t.closest('[data-cv-pool]');
            if (poolPick) {
                const name = poolPick.getAttribute('data-cv-pool');
                cvPoolFilter = cvPoolFilter === name ? null : name;
                cvCardOrder = null;
                if (window.hidePoolTooltip) window.hidePoolTooltip();
                cvVdRerenderPools();
                return;
            }
            if (t.closest('[data-cv-pool-clear]')) {
                cvPoolFilter = null;
                cvCardOrder = null;
                cvVdRerenderPools();
                return;
            }
            const scopeBtn = t.closest('#cv-vd-scope button[data-scope]');
            if (scopeBtn) {
                cvShowPastPools = scopeBtn.getAttribute('data-scope') === 'all';
                cvCardOrder = null;
                safeStorage.setItem('validatorShowPastPools', cvShowPastPools ? '1' : '0');
                cvVdRerenderPools();
                return;
            }
            const loadBtn = t.closest('#cv-vd-load-counts');
            if (loadBtn) {
                // Stake accounts per pool of a past epoch live only in its full snapshot.
                const epoch = cvVd ? cvVd.selectedEpoch : null;
                if (epoch === null) return;
                loadBtn.disabled = true;
                loadBtn.textContent = 'Loading...';
                loadEpochFull(Number(epoch)).then(full => {
                    if (!cvVd || cvVd.selectedEpoch !== epoch) return;
                    if (full) {
                        cvVdRenderEpoch();
                    } else {
                        loadBtn.disabled = false;
                        loadBtn.textContent = 'Could not load, try again';
                    }
                });
                return;
            }
            if (t.closest('#cv-vd-changes-more')) {
                cvChangesExpanded = true;
                if (cvVd) cvVdRenderChanges(cvVd);
                return;
            }
            const mainLink = t.closest('a[data-cv-main]');
            if (mainLink) {
                e.preventDefault();
                const section = document.getElementById('breadcrumb-section');
                if (section) section.click();
                return;
            }
            const card = t.closest('[data-cv-vdtip]');
            if (card) {
                cvVdPinTip(card);
                return;
            }
            const wrap = t.closest('.desc-wrap');
            if (wrap && wrap.dataset.collapsible === '1') {
                const collapsed = wrap.classList.toggle('collapsed');
                wrap.setAttribute('aria-expanded', String(!collapsed));
            }
        });
        view.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('desc-wrap') &&
                e.target.dataset.collapsible === '1') {
                e.preventDefault();
                const collapsed = e.target.classList.toggle('collapsed');
                e.target.setAttribute('aria-expanded', String(!collapsed));
            }
        });
        // A pinned tooltip leaves on a click elsewhere, a scroll or Escape.
        document.addEventListener('click', (e) => {
            if (!cvPinnedTip || !e.target.closest) return;
            if (e.target.closest('#cv-pinned-tip') || e.target.closest('[data-cv-vdtip]')) return;
            cvVdUnpinTip();
        });
        window.addEventListener('scroll', cvVdUnpinTip, { passive: true });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cvVdUnpinTip(); });
        // A pool page opened from here arrives with ?find=<vote>; once the
        // visitor edits the pool search, the parameter no longer describes
        // the page and leaves the URL.
        const dropFind = () => {
            const p = new URLSearchParams(window.location.search);
            if (!p.has('find')) return;
            p.delete('find');
            window.history.replaceState({}, '', window.location.pathname + (p.toString() ? '?' + p.toString() : ''));
        };
        const poolSearch = document.getElementById('pool-validators-search');
        const poolClear = document.getElementById('pool-validators-search-clear');
        if (poolSearch) poolSearch.addEventListener('input', dropFind);
        if (poolClear) poolClear.addEventListener('click', dropFind);
    }

    // ============================================
    // MAIN ФУНКЦІЯ
    // ============================================
    async function main() {
        const loader = document.getElementById('sofzp-loader-overlay');
        document.getElementById('stake-pool-dashboard').classList.add('is-loading');

        // Показуємо скелетони
        document.getElementById('summary-container').innerHTML = 
            Array(4).fill('<div class="sp-summary-card"><div class="skeleton skeleton-text-small"></div><div class="skeleton skeleton-text"></div></div>').join('') + 
            '<div class="sp-summary-card total-stake-card"><div class="skeleton skeleton-text-small" style="width: 30%;"></div><div class="skeleton skeleton-text" style="height: 100px;"></div></div>';
        
        document.getElementById('groups-grid-container').innerHTML = 
            Array(3).fill('<div class="sp-block sp-group-card"><div class="card-header"><div class="skeleton skeleton-img"></div><div style="flex:1;"><div class="skeleton skeleton-text"></div></div></div><div class="card-body"><div class="card-stats"><div class="stat-item"><div class="skeleton skeleton-text-small"></div><div class="skeleton skeleton-text"></div></div><div class="stat-item"><div class="skeleton skeleton-text-small"></div><div class="skeleton skeleton-text"></div></div></div></div></div>').join('');
        
        applyTheme(safeStorage.getItem('siteTheme') || safeStorage.getItem('dashboardTheme') || 'light');

        const urlState = getUrlState();
		if (urlState.search) {
			searchQuery = urlState.search;
		}
        if (urlState.sort && ['stake', 'validators', 'activating', 'deactivating', 'category'].includes(urlState.sort)) {
            currentSortMode = urlState.sort;
        }

        const fetched = await fetchAllFromManifest();

        if (!fetched || !fetched.latestData) {
            console.error('[stake-dashboard] Failed to load data from any source.');
            document.getElementById('stake-pool-dashboard').innerHTML = 
                '<div style="text-align:center; padding: 40px 20px; color: #fff; max-width: 600px; margin: 0 auto;">' +
                  '<h3 style="color:#ff6b6b; margin-bottom: 16px;">Could not load StakeMap data</h3>' +
                  '<p style="color:#ccc; line-height: 1.6; margin-bottom: 16px;">' +
                    'The browser could not reach the data servers (<code style="background:#333;padding:2px 6px;border-radius:3px;">raw.githubusercontent.com</code> and ' +
                    '<code style="background:#333;padding:2px 6px;border-radius:3px;">data.stakemap.info</code>) ' +
                    'in time. This usually happens when:' +
                  '</p>' +
                  '<ul style="color:#ccc; text-align: left; line-height: 1.8; max-width: 500px; margin: 0 auto;">' +
                    '<li>Security software is inspecting HTTPS traffic</li>' +
                    '<li>A corporate firewall or DNS filter blocks these hosts</li>' +
                    '<li>An ad-blocker or privacy extension has overly broad rules</li>' +
                    '<li>The internet connection is unstable or very slow</li>' +
                    '<li>ISP-level filtering (rare)</li>' +
                  '</ul>' +
                  '<p style="color:#ccc; margin-top: 20px;">' +
                    'Try a different browser or network, or pause the security software for a moment. ' +
                    '<br>You can also <a href="javascript:location.reload()" style="color:#4a90ff;">refresh</a> the page.' +
                  '</p>' +
                '</div>';
            if (loader) loader.classList.add('hidden');
            return;
        }

        latestPoolDefinitions = fetched.latestData.pool_definitions || [];
        
        // Bug 8: "OTHER" is an aggregate of uncategorized stakes, not a real pool
        // from stakepools_list.csv. Add a synthetic definition so it can be opened
        // like any other pool (with validators, charts, dynamics), even though its
        // data repo entry does not exist.
        if (!latestPoolDefinitions.find(p => p.group === 'OTHER')) {
            latestPoolDefinitions.push({
                group: 'OTHER',
                short_name: 'Other Stakes',
                long_name: 'Other Stakes',
                category: 'OTHER',
                description: 'Aggregate of all stakes that do not match any defined pool or stakeholder category. This includes validators that are not captured by other groups rules or keys.',
                image: '',
                url: '',
                type: '',
                public_key: ''
            });
        }
        
        buildCanonicalKeyGroup(latestPoolDefinitions);
        nameRemap = createNameRemap(latestPoolDefinitions, allEpochData);
        invalidateGroupResolution();
        
        // Block B: scan logo variants for the initial theme now that pool defs
        // are loaded. applyTheme() at page init ran before data was available,
        // so the variant cache was empty then. Rendering functions will place
        // default URLs as img.src; once the scan finishes, refreshAllPoolLogos
        // swaps in any _light/_dark variants that actually exist on GitHub.
        const initialIsDark = document.body.classList.contains('dark-theme-body');
        scanLogoVariants(initialIsDark, () => refreshAllPoolLogos(initialIsDark));

        // Ремапінг історичних даних
        const historicByPool = fetched.historicData.byPool;
        for (const [oldName, newName] of nameRemap.entries()) {
            if (historicByPool[oldName]) {
                if (!historicByPool[newName]) {
                    historicByPool[newName] = [];
                }
                historicByPool[newName].push(...historicByPool[oldName]);
                historicByPool[newName].sort((a, b) => a.epoch - b.epoch);
                delete historicByPool[oldName];
            }
        }

        // Заповнюємо селектор епох
        const epochSelect = document.getElementById('epoch-select');
        const epochs = fetched.epochs.slice().sort((a, b) => b - a);
        epochSelect.innerHTML = epochs.map(e => 
            `<option value="${e}">${e}${e === latestEpochNumber ? ' (latest)' : ''}</option>`
        ).join('');
        
        let initialEpoch;
        if (urlState.epoch === 'latest') {
            initialEpoch = latestEpochNumber;
        } else if (!urlState.validator && urlState.epoch && epochMap.has(Number(urlState.epoch))) {
            initialEpoch = Number(urlState.epoch);
        } else {
            initialEpoch = latestEpochNumber;
        }
        epochSelect.value = initialEpoch;

        const initialTab = urlState.tab && ['pools', 'validators', 'docs'].includes(urlState.tab) 
            ? urlState.tab 
            : 'pools';
        
        setActiveSortButton(currentSortMode);
        activateTab(initialTab);
        switchToEpochWithLazyLoad(initialEpoch, fetched.historicData);

        // Ховаємо лоадер
        if (loader) {
            loader.classList.add('hidden');
        }
        document.getElementById('stake-pool-dashboard').classList.remove('is-loading');

        // ============================================
        // EVENT LISTENERS
        // ============================================
        document.getElementById('sorting-bar').addEventListener('click', (e) => {
            const btn = e.target.closest('.sort-btn');
            if (!btn) return;
            
            const mode = btn.getAttribute('data-sort');
            if (!mode || mode === currentSortMode) return;
            
            currentSortMode = mode;
            setActiveSortButton(currentSortMode);
            
            const selectedEpoch = epochSelect.value;
            const epochForUrl = (Number(selectedEpoch) === Number(latestEpochNumber)) ? 'latest' : selectedEpoch;
            
            setUrlState({ tab: 'pools', sort: currentSortMode, epoch: epochForUrl, search: searchQuery || null });
            switchToEpochWithLazyLoad(selectedEpoch, fetched.historicData);
        });

        epochSelect.addEventListener('change', () => {
            const selectedEpoch = epochSelect.value;
            const epochForUrl = (Number(selectedEpoch) === Number(latestEpochNumber)) ? 'latest' : selectedEpoch;
            setUrlState({ 
                tab: document.querySelector('.sp-tab-link.active')?.getAttribute('data-tab') || 'pools', 
                sort: currentSortMode, 
                epoch: epochForUrl,
        		search: searchQuery || null 
            });
            switchToEpochWithLazyLoad(selectedEpoch, fetched.historicData);
        });
        
        document.querySelectorAll('.sp-tab-link').forEach(link => {
            link.addEventListener('click', (e) => {
                const targetTab = e.currentTarget.getAttribute('data-tab');
                activateTab(targetTab);
            });
        });

        const grid = document.getElementById('groups-grid-container');
        
        grid.addEventListener('click', (event) => {
            // Обробка кнопки показу/приховування ключів
            const toggleButton = event.target.closest('.pool-keys-toggle');
            if (toggleButton) {
                const keyList = toggleButton.nextElementSibling;
                if (keyList && keyList.classList.contains('pool-keys-list')) {
                    toggleButton.classList.toggle('active');
                    keyList.classList.toggle('expanded');
                    const textSpan = toggleButton.querySelector('.toggle-text');
                    textSpan.textContent = toggleButton.classList.contains('active')
                        ? 'Hide Keys'
                        : `Show ${toggleButton.dataset.keyCount} Keys`;
                }
                return;
            }
            
            // Обробка кліку на опис
            const wrap = event.target.closest('.pool-details .desc-wrap');
            if (wrap) {
                if (wrap.dataset.collapsible === '1') {
                    const isCollapsed = wrap.classList.toggle('collapsed');
                    wrap.setAttribute('aria-expanded', String(!isCollapsed));
                }
                return;
            }
        });
        
        grid.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('desc-wrap')) {
                e.preventDefault();
                const wrap = e.target;
                if (wrap.dataset.collapsible === '1') {
                    const isCollapsed = wrap.classList.toggle('collapsed');
                    wrap.setAttribute('aria-expanded', String(!isCollapsed));
                }
            }
        });

        // Обробник теми (єдиний перемикач в breadcrumbs)
        const breadcrumbThemeToggle = document.getElementById('theme-toggle-breadcrumb');
        if (breadcrumbThemeToggle) {
            breadcrumbThemeToggle.addEventListener('change', (e) => {
                const newTheme = e.target.checked ? 'dark' : 'light';
                // Write to site-wide key first; keep legacy key in sync so
                // any old code paths still work and a downgrade is harmless.
                safeStorage.setItem('siteTheme', newTheme);
                safeStorage.setItem('dashboardTheme', newTheme);
                applyTheme(newTheme);
            });
        }

        // Watch for theme changes triggered outside this script (e.g. site
        // Header toggle setting data-theme on <html>). Same-tab storage events
        // do not fire, so MutationObserver is the reliable signal here.
        const themeObserver = new MutationObserver(() => {
            const externalTheme = document.documentElement.getAttribute('data-theme') || 'light';
            const currentlyDark = document.body.classList.contains('dark-theme-body');
            const externalIsDark = externalTheme === 'dark';
            if (externalIsDark !== currentlyDark) {
                applyTheme(externalTheme);
            }
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme'],
        });

        const refreshDescCollapsers = debounce(() => {
            const root = document.getElementById('groups-grid-container');
            if (root) initDescriptionCollapsers(root);
        }, 150);
        
        // ============================================
        // ФУНКЦІЇ ДЛЯ ДЕТАЛЬНОГО ВИДУ ПУЛУ
        // ============================================
        
        // Функція для показу детального виду пулу
        async function showPoolDetail(poolGroup, opts) {
            // opts.history: the URL is already written (Back, Forward, a link), nothing is pushed.
            const viaHistory = !!(opts && opts.history);
            if (!viaHistory) cvRememberMainScroll();
            hideValidatorDetail();
            currentPoolGroup = poolGroup;
            
            // Приховуємо головний вид, показуємо детальний
            document.getElementById('main-dashboard-view').style.display = 'none';
            document.getElementById('pool-detail-view').style.display = 'block';
            
            // Показуємо третій рівень breadcrumbs (назва пулу)
            const detailSep = document.querySelector('.breadcrumb-detail-sep');
            const breadcrumbCurrent = document.getElementById('breadcrumb-current');
            if (detailSep) detailSep.style.display = 'inline';
            if (breadcrumbCurrent) breadcrumbCurrent.style.display = 'inline';
            
            // Оновлюємо breadcrumb-section на "Pools" для сторінки пулу
            const breadcrumbSection = document.getElementById('breadcrumb-section');
            if (breadcrumbSection) {
                breadcrumbSection.textContent = 'Pools';
                breadcrumbSection.dataset.tab = 'pools';
            }
            
            // Знаходимо дані пулу
            const poolDef = latestPoolDefinitions.find(p => p.group === poolGroup);
            if (!poolDef) {
                console.error('Pool not found:', poolGroup);
                showMainDashboard();
                return;
            }
            
            // Оновлюємо breadcrumbs
            if (breadcrumbCurrent) breadcrumbCurrent.textContent = poolDef.long_name || poolDef.short_name;
            
            // Заповнюємо header
            const poolImage = document.getElementById('pool-detail-image');
            const poolImageContainer = poolImage?.parentElement;
            if (isValidHttpUrl(poolDef.image)) {
                // Block B: resolve logo for current theme (uses cache if known).
                const isDarkTheme = document.body.classList.contains('dark-theme-body');
                poolImage.dataset.logoIso = '256';
                poolImage.src = resolveLogoUrlSync(poolDef.image, isDarkTheme, 256);
                poolImage.dataset.logoDefault = poolDef.image;
                poolImage.alt = poolDef.long_name || poolDef.short_name;
                poolImage.style.display = '';
                // Remove any previously injected SVG fallback
                const existingSvg = poolImageContainer?.querySelector('.pool-detail-svg-fallback');
                if (existingSvg) existingSvg.remove();
            } else {
                // Bug 8: OTHER (and any pool without image) - show SVG fallback in the
                // same slot so layout stays consistent.
                poolImage.style.display = 'none';
                poolImage.removeAttribute('src');
                if (poolImageContainer) {
                    let svgWrap = poolImageContainer.querySelector('.pool-detail-svg-fallback');
                    if (!svgWrap) {
                        svgWrap = document.createElement('div');
                        svgWrap.className = 'pool-detail-image pool-detail-svg-fallback';
                        poolImageContainer.insertBefore(svgWrap, poolImage);
                    }
                    svgWrap.innerHTML = (poolGroup === 'OTHER' ? otherIsoImg(256) : '') + OTHER_GROUP_SVG;
                }
            }
            
            document.getElementById('pool-detail-name').textContent = poolDef.long_name || poolDef.short_name;
            poolSubheaderSet(poolDef);
            document.getElementById('pool-detail-description').textContent = cleanText(poolDef.description);
            
            // Categories
            const categoriesContainer = document.getElementById('pool-detail-categories');
            categoriesContainer.innerHTML = '';
            if (poolDef.category) {
                const categories = poolDef.category.split(',').map(c => c.trim());
                categories.forEach(cat => {
                    const tag = document.createElement('span');
                    tag.className = 'pool-category-tag';
                    tag.textContent = toTitleCaseKey(cat);
                    categoriesContainer.appendChild(tag);
                });
            }
            
            // Official link - змінюємо текст на "Learn More"
            const poolLink = document.getElementById('pool-detail-url');
            if (poolDef.url) {
                poolLink.href = poolDef.url;
                poolLink.classList.remove('pool-official-link-hidden');
                poolLink.style.display = '';
                poolLink.innerHTML = '<i class="fas fa-external-link-alt"></i> Learn More';
            } else {
                // Use class with !important to override mobile display:inline-flex!important rule
                poolLink.classList.add('pool-official-link-hidden');
            }
            
            // ВИПРАВЛЕННЯ 5: Заповнюємо селектор епохи на сторінці пулу
            const poolEpochSelect = document.getElementById('pool-epoch-select');
            if (poolEpochSelect && epochMap && epochMap.size > 0) {
                poolEpochSelect.innerHTML = '';
                
                
                // Отримуємо список епох де цей пул присутній
                const allEpochs = Array.from(epochMap.keys()).sort((a, b) => Number(b) - Number(a));
                
                // Bug 8 additional: OTHER is a synthetic aggregate, not in pool_definitions.
                // It's present in every epoch as validator.aggregations.by_group entry,
                // so we skip the pool_definitions filter and use all epochs directly.
                let epochs;
                if (poolGroup === 'OTHER') {
                    epochs = allEpochs;
                } else {
                    // Фільтруємо епохи - показуємо тільки ті, де пул існує (з будь-яким іменем)
                    const poolAvailableEpochs = allEpochs.filter(epoch => {
                        const epochData = epochMap.get(epoch);
                        if (!epochData || !epochData.pool_definitions) return false;
                        // Перевіряємо чи пул є в списку pool_definitions для цієї епохи (будь-яке з імен)
                        // Resolve each historical definition to its current group,
                        // so a pool keeps its epochs after a rename or a split.
                        return epochData.pool_definitions.some(def => canonicalGroupForDef(def) === poolGroup);
                    });
                    
                    // Якщо не знайшли жодної епохи з цим пулом - показуємо всі (fallback)
                    epochs = poolAvailableEpochs.length > 0 ? poolAvailableEpochs : allEpochs;
                }
                
                epochs.forEach(epoch => {
                    const option = document.createElement('option');
                    option.value = epoch;
                    option.textContent = epoch === latestEpochNumber ? `Epoch ${epoch} (latest)` : `Epoch ${epoch}`;
                    poolEpochSelect.appendChild(option);
                });
                
                // Встановлюємо поточну епоху з URL або останню доступну
                const urlParams = new URLSearchParams(window.location.search);
                const epochParam = urlParams.get('epoch');
                if (epochParam && epochs.includes(Number(epochParam))) {
                    poolEpochSelect.value = epochParam;
                } else if (epochs.includes(latestEpochNumber)) {
                    poolEpochSelect.value = latestEpochNumber;
                } else {
                    // Якщо latest не доступна для цього пулу - беремо найновішу доступну
                    poolEpochSelect.value = epochs[0];
                }
                
                // Обробник зміни епохи
                poolEpochSelect.onchange = async function() {
                    const newEpoch = this.value;
                    const params = new URLSearchParams(window.location.search);
                    params.set('epoch', newEpoch);
                    const newUrl = window.location.pathname + '?' + params.toString();
                    window.history.replaceState({}, '', newUrl);
                    
                    // СИНХРОНІЗАЦІЯ: Оновлюємо також головний селектор епохи
                    const mainEpochSelect = document.getElementById('epoch-select');
                    if (mainEpochSelect) {
                        mainEpochSelect.value = newEpoch;
                    }
                    
                    // Block E Phase 3: lazy-load full snapshot if this epoch entry is pseudo.
                    // Validators table needs real per-validator data which pseudo cannot provide.
                    const epochNum = Number(newEpoch);
                    const entry = epochMap.get(epochNum);
                    if (entry && entry.__aggregated) {
                        showEpochLoader(`Loading epoch ${epochNum}...`);
                        try {
                            await loadEpochFull(epochNum);
                        } finally {
                            hideEpochLoader();
                        }
                    }
                    
                    // Оновлюємо дані для нової епохи
                    updatePoolMetrics(poolGroup);
                    // TODO: updatePoolCharts(poolGroup) - буде додано пізніше
                };
            }
            
            // Оновлюємо URL з параметром pool та epoch
            const params = new URLSearchParams(window.location.search);
            params.set('pool', poolGroup);
            
            // Використовуємо poolEpochSelect, а не головний epochSelect
            if (poolEpochSelect && poolEpochSelect.value) {
                const selectedEpoch = poolEpochSelect.value;
                const epochForUrl = (Number(selectedEpoch) === Number(latestEpochNumber)) ? 'latest' : selectedEpoch;
                params.set('epoch', epochForUrl);
            }
            params.delete('validator');
            // Opened from a validator page (?find=<vote>): the table starts filtered to that validator.
            const findVote = params.get('find');
            if (findVote !== null) {
                poolSearchQuery = findVote;
                const findInput = document.getElementById('pool-validators-search');
                if (findInput) findInput.value = findVote;
            }
            const newUrl = `${window.location.pathname}?${params.toString()}`;
            if (viaHistory) window.history.replaceState({}, '', newUrl);
            else window.history.pushState({}, '', newUrl);
            
            // Block E Phase 3: if user opened a non-latest epoch directly via URL,
            // lazy-load its full snapshot so the validators table renders correctly.
            const initialEpoch = poolEpochSelect && poolEpochSelect.value
                ? Number(poolEpochSelect.value)
                : latestEpochNumber;
            const initialEntry = epochMap && epochMap.get(initialEpoch);
            if (initialEntry && initialEntry.__aggregated) {
                showEpochLoader(`Loading epoch ${initialEpoch}...`);
                try {
                    await loadEpochFull(initialEpoch);
                } finally {
                    hideEpochLoader();
                }
            }
            
            // Завантажуємо дані пулу з поточної епохи
            updatePoolMetrics(poolGroup);
            
            // Прокручуємо наверх
            if (!viaHistory || (opts && opts.fresh)) {
                const tableSection = findVote !== null ? document.querySelector('.pool-validators-section') : null;
                if (tableSection) tableSection.scrollIntoView({ block: 'start' });
                else window.scrollTo({ top: 0, behavior: 'smooth' });
            }
        }
        
        // Функція для повернення на головний дашборд
        function showMainDashboard(opts) {
            const viaHistory = !!(opts && opts.history);
            currentPoolGroup = null;
            hideValidatorDetail();
            
            // Показуємо головний вид, приховуємо детальний
            document.getElementById('main-dashboard-view').style.display = 'block';
            document.getElementById('pool-detail-view').style.display = 'none';
            subheaderShowCurrentTab();
            
            // Приховуємо третій рівень breadcrumbs (назва пулу)
            const detailSep = document.querySelector('.breadcrumb-detail-sep');
            const breadcrumbCurrent = document.getElementById('breadcrumb-current');
            if (detailSep) detailSep.style.display = 'none';
            if (breadcrumbCurrent) {
                breadcrumbCurrent.style.display = 'none';
                breadcrumbCurrent.textContent = '';
            }
            
            // ВАЖЛИВО: Відновлюємо gap для main-dashboard-view
            document.getElementById('main-dashboard-view').style.display = 'flex';
            document.getElementById('main-dashboard-view').style.flexDirection = 'column';
            document.getElementById('main-dashboard-view').style.gap = '20px';
            
            // СИНХРОНІЗАЦІЯ ЕПОХИ: Беремо епоху з URL і синхронізуємо головний селектор
            const params = new URLSearchParams(window.location.search);
            const epochParam = params.get('epoch');
            const mainEpochSelect = document.getElementById('epoch-select');
            
            if (epochParam && mainEpochSelect) {
                // Якщо в URL є epoch параметр - синхронізуємо головний селектор
                const epochValue = epochParam === 'latest' ? latestEpochNumber : epochParam;
                if (epochMap.has(Number(epochValue))) {
                    mainEpochSelect.value = epochValue;
                    // Оновлюємо дашборд для цієї епохи
                    // Re-render only when the epoch differs from the one on screen,
                    // so the validators list keeps its place.
                    if (Number(mainRenderedEpoch) !== Number(epochValue)) mainEpochSelect.dispatchEvent(new Event('change'));
                }
            }
            
            // Оновлюємо URL - прибираємо параметр pool, але зберігаємо epoch
            params.delete('pool');
            params.delete('validator');
            params.delete('find');
            const newUrl = params.toString() ? `${window.location.pathname}?${params.toString()}` : window.location.pathname;
            if (viaHistory) window.history.replaceState({}, '', newUrl);
            else window.history.pushState({}, '', newUrl);
            const activeTabLink = document.querySelector('.sp-tab-link.active');
            const activeTab = activeTabLink ? activeTabLink.getAttribute('data-tab') : 'pools';
            const crumbSection = document.getElementById('breadcrumb-section');
            // After Back or Forward the crumb follows the open tab; a click on a crumb sets its own tab right after.
            if (crumbSection && viaHistory) {
                crumbSection.textContent = tabToBreadcrumb[activeTab] || 'Pools';
                crumbSection.dataset.tab = activeTab;
            }
            requestAnimationFrame(drawAllChartsNow);
            if (viaHistory && cvMainScrollY !== null) {
                const y = cvMainScrollY;
                requestAnimationFrame(() => window.scrollTo(0, y));
            }
            cvMainScrollY = null;
        }
        
        // Оновлення метрик пулу з поточних даних
        function updatePoolMetrics(poolGroup) {
            console.log('=== Updating pool metrics for:', poolGroup);
            
            // Знаходимо поточну епоху
            // ВИПРАВЛЕННЯ: Використовуємо селектор епохи на сторінці пулу, якщо він є
            const poolEpochSelect = document.getElementById('pool-epoch-select');
            const mainEpochSelect = document.getElementById('epoch-select');
            
            let currentEpochNumber;
            if (poolEpochSelect && poolEpochSelect.value) {
                // Якщо ми на сторінці пулу, беремо епоху з його селектора
                currentEpochNumber = poolEpochSelect.value;
            } else if (mainEpochSelect && mainEpochSelect.value) {
                // Інакше беремо з головного селектора
                currentEpochNumber = mainEpochSelect.value;
            } else {
                // Або використовуємо останню
                currentEpochNumber = latestEpochNumber;
            }
            
            console.log('Requested epoch:', currentEpochNumber);
            console.log('Latest epoch number:', latestEpochNumber);
            
            let currentEpochData = null;
            
            // ПРАВИЛЬНИЙ ПІДХІД: Використовуємо epochMap який містить всі дані
            // Пробуємо і числовий, і рядковий ключ
            if (epochMap) {
                const numKey = Number(currentEpochNumber);
                const strKey = String(currentEpochNumber);
                
                if (epochMap.has(numKey)) {
                    const rawData = epochMap.get(numKey);
                    currentEpochData = rawData;
                    console.log('Found data in epochMap with numeric key:', numKey);
                } else if (epochMap.has(strKey)) {
                    const rawData = epochMap.get(strKey);
                    currentEpochData = rawData;
                    console.log('Found data in epochMap with string key:', strKey);
                } else {
                    console.log('Data not found in epochMap. Keys available:', Array.from(epochMap.keys()).slice(0, 10));
                }
            }
            
            if (!currentEpochData) {
                // Fallback на allEpochData
                if (allEpochData && allEpochData.length > 0) {
                    currentEpochData = allEpochData.find(e => e && e.metadata && String(e.metadata.epoch) === String(currentEpochNumber));
                    if (currentEpochData) {
                        console.log('Found data in allEpochData for epoch:', currentEpochNumber);
                    }
                }
            }
            
            if (!currentEpochData) {
                console.error('No data found for epoch:', currentEpochNumber);
                console.log('epochMap available:', epochMap ? 'yes' : 'no');
                console.log('epochMap size:', epochMap ? epochMap.size : 0);
                if (epochMap && epochMap.size > 0) {
                    console.log('Available epochs in epochMap:', Array.from(epochMap.keys()).slice(0, 10));
                }
                console.log('allEpochData length:', allEpochData ? allEpochData.length : 0);
                return;
            }
            
            // ВИПРАВЛЕННЯ 4: Відображаємо інформацію про епоху з жовтою плашкою та відсотком
            const epochInfo = document.getElementById('pool-epoch-info');
            // FALLBACK: metadata може бути в currentEpochData.metadata або currentEpochData.data.metadata
            const metadata = currentEpochData.metadata || (currentEpochData.data && currentEpochData.data.metadata) || {};
            
            if (epochInfo && metadata) {
                // Показуємо номер епохи
                const epochValueEl = document.getElementById('pool-epoch-value');
                const pastBadgeEl = document.getElementById('pool-past-epoch-badge');
                const currentBadgeEl = document.getElementById('pool-current-epoch-badge');
                const epochProgressEl = document.getElementById('pool-epoch-progress');
                const timestampEl = document.getElementById('pool-timestamp-value');
                const stalePill = document.getElementById('pool-epoch-stale-pill');
                
                // ВИПРАВЛЕННЯ: Примусово приводимо до Number для коректного порівняння
                const currentNum = Number(currentEpochNumber);
                const latestNum = Number(latestEpochNumber);
                const isLatest = currentNum === latestNum;
                
                console.log('Badge logic - currentEpoch:', currentEpochNumber, '(', typeof currentEpochNumber, ') =', currentNum);
                console.log('Badge logic - latestEpoch:', latestEpochNumber, '(', typeof latestEpochNumber, ') =', latestNum);
                console.log('Badge logic - isLatest:', isLatest);
                
                if (epochValueEl) {
                    // Просто номер епохи
                    epochValueEl.textContent = currentEpochNumber;
                    epochValueEl.style.color = isLatest ? 'var(--header-color)' : 'var(--text-color)';
                }
                
                // Показуємо правильний бейдж
                if (isLatest) {
                    // Поточна епоха - зелений "current"
                    if (currentBadgeEl) currentBadgeEl.style.display = 'inline-flex';
                    if (pastBadgeEl) pastBadgeEl.style.display = 'none';
                    if (stalePill) stalePill.style.display = 'none';
                } else {
                    // Минула епоха - жовтий "past"
                    if (currentBadgeEl) currentBadgeEl.style.display = 'none';
                    if (pastBadgeEl) pastBadgeEl.style.display = 'inline-flex';
                    if (stalePill) stalePill.style.display = 'flex';
                }
                
                // Показуємо відсоток завершення епохи - у дужках
                if (epochProgressEl && metadata.epoch_completed_percent !== undefined) {
                    const completedPercent = metadata.epoch_completed_percent || 0;
                    epochProgressEl.textContent = `(${completedPercent.toFixed(2)}%)`;
                }
                
                // Показуємо час снепшоту
                if (timestampEl) {
                    const timestamp = metadata.timestamp_utc || metadata.timestamp;
                    if (timestamp) {
                        const date = new Date(timestamp);
                        const formatted = date.toLocaleString('en-US', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                            timeZone: 'UTC'
                        }) + ' UTC';
                        timestampEl.textContent = formatted;
                    }
                }
            }
            
            // Дані можуть бути безпосередньо в currentEpochData.validators або в currentEpochData.data.validators
            const validators = currentEpochData.validators || (currentEpochData.data && currentEpochData.data.validators) || [];
            
            if (validators.length === 0) {
                console.error('No validators found in epoch data');
                return;
            }
            
            console.log('Found validators count:', validators.length);
            
            const currentEpochDefs = currentEpochData.pool_definitions ||
                (currentEpochData.data && currentEpochData.data.pool_definitions) || [];
            
            // Прямий підрахунок
            let poolStats = {
                active_lamports: 0,
                activating_lamports: 0,
                deactivating_lamports: 0,
                validator_count: 0
            };
            
            const poolValidatorsList = [];
            let debugFoundGroups = new Set();
            poolScriptInfo = currentEpochData.script_info ||
                (currentEpochData.data && currentEpochData.data.script_info) || null;
            
            validators.forEach(validator => {
                const resolvedGroups = getResolvedGroups(validator, currentEpochDefs);
                if (resolvedGroups.length === 0) return;

                resolvedGroups.forEach(g => debugFoundGroups.add(g.name));

                const groupData = resolvedGroups.find(g => g.name === poolGroup);
                
                if (groupData && meetsStakeThreshold(groupData.active_lamports, groupData.activating_lamports)) {
                    poolStats.active_lamports += groupData.active_lamports || 0;
                    poolStats.activating_lamports += groupData.activating_lamports || 0;
                    poolStats.deactivating_lamports += groupData.deactivating_lamports || 0;
                    poolStats.validator_count++;
                    
                    poolValidatorsList.push({
                        info: validator.info,
                        totals: validator.totals,
                        meta: validator.meta || null,
                        poolStake: groupData
                    });
                }
            });
            
            console.log('Looking for pool:', poolGroup);
            console.log('Found unique groups in data:', Array.from(debugFoundGroups).slice(0, 10), '...');
            console.log('Calculated pool stats:', poolStats);
            console.log('Found validators in pool:', poolStats.validator_count);
            
            // Оновлюємо метрики
            const activeSol = lamportsToSol(poolStats.active_lamports);
            const activatingSol = lamportsToSol(poolStats.activating_lamports);
            const deactivatingSol = lamportsToSol(poolStats.deactivating_lamports);
            
            document.getElementById('pool-metric-stake').textContent = `${formatNumber(activeSol)} SOL`;
            document.getElementById('pool-metric-validators').textContent = poolStats.validator_count;
            document.getElementById('pool-metric-activating').textContent = activatingSol > 0 ? `+${formatNumber(activatingSol)} SOL` : '0 SOL';
            document.getElementById('pool-metric-deactivating').textContent = deactivatingSol > 0 ? `-${formatNumber(deactivatingSol)} SOL` : '0 SOL';
            
            poolValidators = poolValidatorsList;
            
            // Authority keys
            updatePoolAuthorityKeys(poolGroup);
            
            // Оновлюємо таблицю валідаторів
            sortPoolValidators();
            renderPoolValidatorsTable();
            
            // Оновлюємо графіки
            updatePoolCharts(poolGroup, poolValidatorsList);
        }
        
        // Оновлення списку authority keys
        function updatePoolAuthorityKeys(poolGroup) {
            const container = document.getElementById('pool-authority-list');
            container.innerHTML = '';
            
            // Знаходимо всі пули з цієї групи
            const relatedPools = latestPoolDefinitions.filter(p => p.group === poolGroup);
            
            // Розділяємо ключі на Staker та Withdrawer
            const stakerKeys = new Set();
            const withdrawerKeys = new Set();
            
            relatedPools.forEach(pool => {
                if (pool.public_key && pool.public_key !== 'YOUR_NODE_WITHDRAW_AUTHORITY' && 
                    pool.public_key !== 'YOUR_NODE_IDENTITY' && pool.public_key !== 'other_stake_account_keys') {
                    if (pool.type === 'S') {
                        stakerKeys.add(pool.public_key);
                    } else if (pool.type === 'W') {
                        withdrawerKeys.add(pool.public_key);
                    }
                }
            });
            
            const totalKeys = stakerKeys.size + withdrawerKeys.size;
            
            // Bug 9 part 2: if many keys, wrap them in collapsible container
            // (same behavior as main page pool cards for consistency)
            const renderKeyItem = (key, type) => {
                const keyItem = document.createElement('div');
                keyItem.className = 'authority-key-item';
                keyItem.innerHTML = `
                    <span class="key-type">${type}:</span>
                    <span class="key-value">${key}</span>
                    <a href="https://solscan.io/account/${key}#stakeAccounts" target="_blank" rel="noopener">
                        <i class="fas fa-external-link-alt"></i> SolScan
                    </a>
                `;
                return keyItem;
            };
            
            if (totalKeys > KEY_VISIBILITY_THRESHOLD) {
                // Toggle button + collapsible list
                const toggleBtn = document.createElement('button');
                toggleBtn.className = 'pool-keys-toggle authority-keys-toggle';
                toggleBtn.dataset.keyCount = String(totalKeys);
                toggleBtn.innerHTML = `
                    <span class="toggle-text">Show ${totalKeys} Keys</span>
                    <i class="fas fa-chevron-down toggle-icon"></i>
                `;
                container.appendChild(toggleBtn);
                
                const keysList = document.createElement('div');
                keysList.className = 'pool-keys-list authority-keys-collapsible';
                withdrawerKeys.forEach(key => keysList.appendChild(renderKeyItem(key, 'Withdrawer')));
                stakerKeys.forEach(key => keysList.appendChild(renderKeyItem(key, 'Staker')));
                container.appendChild(keysList);
                
                toggleBtn.addEventListener('click', () => {
                    toggleBtn.classList.toggle('active');
                    keysList.classList.toggle('expanded');
                    const textSpan = toggleBtn.querySelector('.toggle-text');
                    textSpan.textContent = toggleBtn.classList.contains('active')
                        ? 'Hide Keys'
                        : `Show ${totalKeys} Keys`;
                });
            } else {
                // Few keys - render them directly (original behavior)
                withdrawerKeys.forEach(key => container.appendChild(renderKeyItem(key, 'Withdrawer')));
                stakerKeys.forEach(key => container.appendChild(renderKeyItem(key, 'Staker')));
            }
        }
        
        // ========================================
        // POOL CHARTS
        // ========================================
        
        // Головна функція оновлення графіків
        // Зберігаємо дані для перемальовування при resize
        let poolChartsData = {
            historyData: null,
            currentValidators: null,
            currentEpoch: null,
            poolName: null
        };
        
        // Debounced resize handler для графіків пулу
        let poolChartsResizeTimeout = null;
        function handlePoolChartsResize() {
            if (poolChartsResizeTimeout) clearTimeout(poolChartsResizeTimeout);
            poolChartsResizeTimeout = setTimeout(() => {
                if (poolChartsData.historyData && document.getElementById('pool-detail-view')?.style.display !== 'none') {
                    renderStakeHistorySparkline(poolChartsData.historyData, poolChartsData.currentEpoch, poolChartsData.poolName);
                    renderValidatorsHistorySparkline(poolChartsData.historyData, poolChartsData.currentEpoch, poolChartsData.poolName);
                    renderEpochDynamicsSparklines(poolChartsData.historyData, poolChartsData.poolName, poolChartsData.currentEpoch);
                }
            }, 150);
        }
        
        // Додаємо resize listener
        window.addEventListener('resize', handlePoolChartsResize);
        
        // Оновлення заголовків графіків з назвою пула
        function updatePoolChartTitles(poolName) {
            const shortName = poolName.length > 25 ? poolName.substring(0, 22) + '...' : poolName;
            
            const titles = {
                'pool-stake-history-title': `Stake History`,
                'pool-validators-history-title': `Validators Count`,
                'pool-stake-distribution-title': `Stake Distribution`,
                'pool-epoch-dynamics-title': `Epoch Dynamics`
            };
            
            for (const [id, baseTitle] of Object.entries(titles)) {
                const el = document.getElementById(id);
                if (el) {
                    const span = el.querySelector('span');
                    if (span) {
                        span.innerHTML = `${baseTitle} <small style="opacity: 0.6; font-weight: 400;">· ${shortName}</small>`;
                    }
                }
            }
        }
        
        function updatePoolCharts(poolGroup, currentValidators) {
            // Збираємо історичні дані по всіх епохах
            const historyData = collectPoolHistoryData(poolGroup);
            
            // Отримуємо поточну епоху для підсвічування
            const poolEpochSelect = document.getElementById('pool-epoch-select');
            const currentEpoch = poolEpochSelect ? Number(poolEpochSelect.value) : latestEpochNumber;
            
            // Отримуємо назву пула
            const poolDef = latestPoolDefinitions.find(p => p.group === poolGroup);
            const poolName = poolDef ? (poolDef.long_name || poolDef.short_name) : poolGroup;
            
            // Оновлюємо заголовки графіків
            updatePoolChartTitles(poolName);
            
            // Зберігаємо дані для resize
            poolChartsData = { historyData, currentValidators, currentEpoch, poolName };
            
            // Рендеримо SVG sparkline графіки
            renderStakeHistorySparkline(historyData, currentEpoch, poolName);
            renderValidatorsHistorySparkline(historyData, currentEpoch, poolName);
            
            // Epoch Dynamics - об'єднаний SVG sparkline
            renderEpochDynamicsSparklines(historyData, poolName, currentEpoch);
            
            // Stake Distribution - SVG donut
            renderStakeDistributionChart(currentValidators, poolSearchQuery);
        }
        
        // Збір історичних даних пулу по всіх епохах
        function collectPoolHistoryData(poolGroup) {
            const history = [];
            
            if (!epochMap || epochMap.size === 0) {
                console.warn('No epoch data available for charts');
                return history;
            }
            
            // Сортуємо епохи від старих до нових
            const sortedEpochs = Array.from(epochMap.keys()).sort((a, b) => Number(a) - Number(b));
            
            sortedEpochs.forEach(epochNum => {
                const epochData = epochMap.get(epochNum);
                if (!epochData) return;
                
                const validators = epochData.validators || (epochData.data && epochData.data.validators) || [];
                const epochDefs = epochData.pool_definitions ||
                    (epochData.data && epochData.data.pool_definitions) || [];
                
                let poolStats = {
                    epoch: Number(epochNum),
                    active_lamports: 0,
                    activating_lamports: 0,
                    deactivating_lamports: 0,
                    validator_count: 0
                };
                
                validators.forEach(validator => {
                    const groupData = getResolvedGroups(validator, epochDefs)
                        .find(g => g.name === poolGroup);
                    
                    if (groupData && meetsStakeThreshold(groupData.active_lamports, groupData.activating_lamports)) {
                        poolStats.active_lamports += groupData.active_lamports || 0;
                        poolStats.activating_lamports += groupData.activating_lamports || 0;
                        poolStats.deactivating_lamports += groupData.deactivating_lamports || 0;
                        poolStats.validator_count++;
                    }
                });
                
                // Додаємо тільки якщо є дані для цього пулу
                if (poolStats.validator_count > 0 || poolStats.active_lamports > 0) {
                    history.push(poolStats);
                }
            });
            
            return history;
        }
        
        // SVG Sparkline для історії стейку (адаптована версія renderInteractiveChart)
        function renderStakeHistorySparkline(historyData, highlightEpoch, poolName = '') {
            const container = document.getElementById('pool-stake-history-chart');
            if (!container) return;
            
            if (historyData.length === 0) {
                container.innerHTML = '<div class="chart-no-data">No historical data available</div>';
                return;
            }
            
            // Перетворюємо дані у формат для sparkline
            const data = historyData.map(d => ({
                epoch: d.epoch,
                value: lamportsToSol(d.active_lamports)
            }));
            
            // Рендеримо sparkline з кліком на pool-epoch-select
            renderPoolSparkline(container, data, highlightEpoch, 'stake', poolName);
        }
        
        // SVG Sparkline для кількості валідаторів
        function renderValidatorsHistorySparkline(historyData, highlightEpoch, poolName = '') {
            const container = document.getElementById('pool-validators-history-chart');
            if (!container) return;
            
            if (historyData.length === 0) {
                container.innerHTML = '<div class="chart-no-data">No historical data available</div>';
                return;
            }
            
            // Перетворюємо дані у формат для sparkline
            const data = historyData.map(d => ({
                epoch: d.epoch,
                value: d.validator_count
            }));
            
            // Рендеримо sparkline з кліком на pool-epoch-select
            renderPoolSparkline(container, data, highlightEpoch, 'validators', poolName);
        }
        
        // Універсальний sparkline для сторінки пулу
        function renderPoolSparkline(container, data, highlightEpoch = null, type = 'stake', poolName = '') {
            if (!container || !data || data.length === 0) {
                if (container) container.innerHTML = '<div class="chart-no-data">No data</div>';
                return;
            }
            
            container.style.display = 'block';
            const formatValue = (val) => {
                if (val >= 1_000_000) return `${(val/1_000_000).toFixed(2)}M`;
                if (val >= 1_000) return `${(val/1_000).toFixed(1)}K`;
                return val.toFixed(0);
            };

            const width = container.clientWidth;
            if (width === 0) {
                if ('ResizeObserver' in window) {
                    const ro = new ResizeObserver((entries) => {
                        if (entries[0]?.contentRect.width > 0) {
                            ro.disconnect();
                            renderPoolSparkline(container, data, highlightEpoch, type, poolName);
                        }
                    });
                    ro.observe(container);
                }
                return;
            }
            
            const height = 90, PADDING = 5;

            const values = data.map(d => d.value);
            const minVal = Math.min(...values);
            const maxVal = Math.max(...values);
            const range = maxVal - minVal === 0 ? 1 : maxVal - minVal;
        
            const points = data.map((d, i) => {
                const x = (i / (data.length - 1 || 1)) * width;
                const y = height - PADDING - ((d.value - minVal) / range) * (height - 2 * PADDING);
                return { x, y, epoch: d.epoch, value: d.value };
            });
        
            // Визначаємо чи це остання епоха - якщо так, не показуємо маркер
            const lastEpoch = data[data.length - 1].epoch;
            const isLastEpoch = highlightEpoch !== null && Number(highlightEpoch) === Number(lastEpoch);
            
            let marker = null;
            if (highlightEpoch !== null && !isLastEpoch) {
                let idx = data.findIndex(d => Number(d.epoch) === Number(highlightEpoch));
                if (idx === -1) {
                    let best = 0, bestDiff = Infinity;
                    data.forEach((d, i) => { 
                        const diff = Math.abs(Number(d.epoch) - Number(highlightEpoch)); 
                        if (diff < bestDiff) { 
                            bestDiff = diff; 
                            best = i; 
                        }
                    });
                    idx = best;
                }
                marker = points[idx];
            }
        
            const pathLineData = points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L ');
            const pathFillData = `M ${points[0].x.toFixed(2)},${height} L ${pathLineData} L ${points[points.length-1].x.toFixed(2)},${height} Z`;
            
            // Градієнти для всіх типів
            const gradientDefs = `
                <defs>
                    <linearGradient id="pool-sparkline-gradient-stake" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="var(--sparkline-gradient-start)" />
                        <stop offset="100%" stop-color="var(--sparkline-gradient-end)" />
                    </linearGradient>
                    <linearGradient id="pool-sparkline-gradient-validators" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="rgba(153, 69, 255, 0.3)" />
                        <stop offset="100%" stop-color="rgba(153, 69, 255, 0)" />
                    </linearGradient>
                    <linearGradient id="pool-sparkline-gradient-activating" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="rgba(20, 241, 149, 0.4)" />
                        <stop offset="100%" stop-color="rgba(20, 241, 149, 0)" />
                    </linearGradient>
                    <linearGradient id="pool-sparkline-gradient-deactivating" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="rgba(255, 107, 107, 0.4)" />
                        <stop offset="100%" stop-color="rgba(255, 107, 107, 0)" />
                    </linearGradient>
                </defs>
            `;
            
            // Стилі залежно від типу
            let fillStyle, lineStyle, dotStyle;
            switch(type) {
                case 'validators':
                    fillStyle = 'fill: url(#pool-sparkline-gradient-validators);';
                    lineStyle = 'stroke: #9945FF;';
                    dotStyle = 'fill: #9945FF;';
                    break;
                case 'activating':
                    fillStyle = 'fill: url(#pool-sparkline-gradient-activating);';
                    lineStyle = 'stroke: #14F195;';
                    dotStyle = 'fill: #14F195;';
                    break;
                case 'deactivating':
                    fillStyle = 'fill: url(#pool-sparkline-gradient-deactivating);';
                    lineStyle = 'stroke: #FF6B6B;';
                    dotStyle = 'fill: #FF6B6B;';
                    break;
                default: // stake
                    fillStyle = 'fill: url(#pool-sparkline-gradient-stake);';
                    lineStyle = '';
                    dotStyle = '';
            }
        
            container.innerHTML = `
                <div class="chart-tooltip"></div>
                <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="overflow: visible; cursor: pointer;">
                    ${gradientDefs}
                    <path d="${pathFillData}" class="chart-path-fill" style="${fillStyle}" />
                    <path d="M ${pathLineData}" class="chart-path-line" style="${lineStyle}" />
                    ${marker ? `<line class="selected-epoch-line" x1="${marker.x}" x2="${marker.x}" y1="0" y2="${height}"></line>` : ''}
                    ${marker ? `<circle class="selected-epoch-dot" cx="${marker.x}" cy="${marker.y}" r="4.5" style="${dotStyle}"></circle>`: ''}
                    <line class="tracker-line-svg" x1="-999" x2="-999" y1="0" y2="${height}"></line>
                    <circle class="tracker-dot-svg" cx="-999" cy="-999" r="4.5" style="${dotStyle}"></circle>
                </svg>
                <div class="chart-range-labels">
                    <span>${data[0].epoch}: <span class="value">${formatValue(data[0].value)}</span></span>
                    <span>${data[data.length - 1].epoch}: <span class="value">${formatValue(data[data.length - 1].value)}</span></span>
                </div>`;
            
            // Додаємо бейдж "Epoch XXX selected" якщо є маркер
            if (marker) {
                const badge = document.createElement('div');
                badge.className = 'selected-epoch-badge';
                badge.innerHTML = `<span class="ep">Epoch ${marker.epoch}</span><span class="sub">selected</span>`;
                badge.style.visibility = 'hidden';
                container.appendChild(badge);
                
                const badgeHeight = badge.offsetHeight || 36;
                const badgeWidth = badge.offsetWidth || 88;
                const offsetAbove = 7;
                const offsetBelow = 38;
                
                let topPosition;
                if (marker.y < height / 2) {
                    topPosition = marker.y + offsetBelow;
                } else {
                    topPosition = marker.y - badgeHeight - offsetAbove;
                }
                
                // Обмежуємо позицію по X щоб бейдж не виходив за межі
                const minLeft = badgeWidth / 2 + 5;
                const maxLeft = width - badgeWidth / 2 - 5;
                const clampedX = Math.max(minLeft, Math.min(maxLeft, marker.x));
                
                badge.style.top = `${topPosition}px`;
                badge.style.left = `${clampedX}px`;
                badge.style.transform = 'translateX(-50%)';
                
                badge.style.visibility = 'visible';
            }
            
            // Анімація малювання лінії
            const line = container.querySelector('.chart-path-line');
            if (line) { 
                const length = line.getTotalLength(); 
                line.style.strokeDasharray = length; 
                line.style.strokeDashoffset = length; 
            }
        
            // Інтерактивність
            const svg = container.querySelector('svg');
            if (!svg) return;
            
            const tooltip = container.querySelector('.chart-tooltip');
            const trackerLine = container.querySelector('.tracker-line-svg');
            const trackerDot = container.querySelector('.tracker-dot-svg');
            
            // Початково приховуємо елементи
            tooltip.style.opacity = '0';
            trackerLine.style.opacity = '0';
            trackerDot.style.opacity = '0';
            
            // Формат tooltip залежно від типу
            const tooltipSuffix = type === 'validators' ? ' validators' : ' SOL';
            
            // Функція для отримання координат миші в системі координат SVG
            function getSVGCoords(e) {
                const CTM = svg.getScreenCTM();
                if (!CTM) return { x: 0, y: 0 };
                return {
                    x: (e.clientX - CTM.e) / CTM.a,
                    y: (e.clientY - CTM.f) / CTM.d
                };
            }
            
            svg.addEventListener('mousemove', (e) => {
                const coords = getSVGCoords(e);
                const mouseX = coords.x;
                
                let closestIndex = 0, minDistance = Infinity;
                points.forEach((p, i) => { 
                    const d = Math.abs(p.x - mouseX); 
                    if (d < minDistance) { 
                        minDistance = d; 
                        closestIndex = i; 
                    } 
                });
                const point = points[closestIndex];
                if (point) {
                    // Показуємо елементи
                    tooltip.style.opacity = '1';
                    trackerLine.style.opacity = '1';
                    trackerDot.style.opacity = '1';
                    
                    // Позиціонуємо елементи в координатах viewBox
                    tooltip.style.left = `${point.x}px`;
                    tooltip.style.top = `${point.y - 25}px`;
                    const formattedValue = type === 'validators' 
                        ? point.value 
                        : new Intl.NumberFormat('en-US').format(point.value);
                    tooltip.innerHTML = `<span class="epoch">Epoch ${point.epoch}:</span> ${formattedValue}${tooltipSuffix}`;
                    trackerLine.setAttribute('x1', point.x);
                    trackerLine.setAttribute('x2', point.x);
                    trackerDot.setAttribute('cx', point.x);
                    trackerDot.setAttribute('cy', point.y);
                }
            });
            
            // Приховуємо при виході миші
            container.addEventListener('mouseleave', () => {
                tooltip.style.opacity = '0';
                trackerLine.style.opacity = '0';
                trackerDot.style.opacity = '0';
            });

            // Клік змінює епоху на сторінці пулу
            svg.addEventListener('click', (e) => {
                const coords = getSVGCoords(e);
                const mouseX = coords.x;
                
                let closestIndex = 0, minDistance = Infinity;
                points.forEach((p, i) => {
                    const d = Math.abs(p.x - mouseX);
                    if (d < minDistance) { 
                        minDistance = d; 
                        closestIndex = i; 
                    }
                });
                const point = points[closestIndex];
                if (point) {
                    const poolEpochSelect = document.getElementById('pool-epoch-select');
                    if (poolEpochSelect && poolEpochSelect.value !== String(point.epoch)) {
                        poolEpochSelect.value = point.epoch;
                        poolEpochSelect.dispatchEvent(new Event('change'));
                    }
                }
            });
        }
        
        // Кругова діаграма розподілу стейку
        
        // Генерація кольору з vote key (детерміновано - один vote key = один колір завжди)
        function voteKeyToColor(voteKey) {
            let hash = 0;
            for (let i = 0; i < voteKey.length; i++) {
                hash = voteKey.charCodeAt(i) + ((hash << 5) - hash);
                hash = hash ^ (voteKey.charCodeAt(i) << (i % 16));
            }
            const hue = Math.abs(hash) % 360;
            const saturation = 65 + (Math.abs(hash >> 8) % 20); // 65-85%
            const lightness = 55 + (Math.abs(hash >> 16) % 15); // 55-70%
            return { hue, saturation, lightness };
        }
        
        // Генерація градієнта для сегмента (більш помітний 3D ефект)
        function createSegmentGradient(voteKey, index) {
            const { hue, saturation, lightness } = voteKeyToColor(voteKey);
            return {
                color1: `hsl(${hue}, ${saturation}%, ${Math.min(85, lightness + 15)}%)`, // світліший край
                color2: `hsl(${hue}, ${saturation + 5}%, ${Math.max(35, lightness - 12)}%)`, // темніший край
                mainColor: `hsl(${hue}, ${saturation}%, ${lightness}%)`
            };
        }
        
        // Стан прихованих валідаторів для Stake Distribution
        let hiddenValidatorKeys = new Set();
        
        // Скидання прихованих валідаторів
        function resetHiddenValidators() {
            hiddenValidatorKeys.clear();
        }
        
        // Stake Distribution - SVG donut з синхронізацією з пошуком
        function renderStakeDistributionChart(validators, searchQuery = '', animate = true) {
            const container = document.getElementById('pool-stake-distribution-chart');
            const legendContainer = document.getElementById('stake-distribution-legend');
            const subtitleEl = document.getElementById('stake-distribution-subtitle');
            const centerEl = document.getElementById('stake-distribution-center');
            
            if (!container || !legendContainer) return;
            
            // Фільтруємо за пошуком якщо є (включаючи identity_pubkey)
            let filteredValidators = validators || [];
            if (searchQuery) {
                // Same matcher as the pool table and the validators list.
                const terms = splitSearchTerms(searchQuery);
                filteredValidators = terms.length === 0 ? filteredValidators : filteredValidators.filter(v => {
                    const text = validatorSearchText(v).full;
                    return terms.some(term => text.includes(term));
                });
            }
            
            // Перевірка на порожні дані
            if (filteredValidators.length === 0) {
                if (centerEl) centerEl.style.display = 'none';
                container.innerHTML = `
                    <div class="chart-no-data-container">
                        <div class="chart-no-data-icon"><i class="fas fa-search"></i></div>
                        <div class="chart-no-data-text">No validators matching query</div>
                    </div>`;
                legendContainer.innerHTML = '';
                if (subtitleEl) subtitleEl.textContent = searchQuery ? '0 matching query' : '';
                return;
            }
            
            // Завжди сортуємо по pool stake (від більшого до меншого)
            const sorted = [...filteredValidators].sort((a, b) => 
                (b.poolStake?.active_lamports || 0) - (a.poolStake?.active_lamports || 0)
            );
            
            // Беремо топ-20 та групуємо інших
            const MAX_ITEMS = 20;
            const topValidators = sorted.slice(0, MAX_ITEMS);
            const others = sorted.slice(MAX_ITEMS);
            
            // Готуємо всі дані (включаючи приховані)
            const allChartData = topValidators.map((v, i) => {
                const gradient = createSegmentGradient(v.info?.vote_pubkey || Math.random().toString(), i);
                return {
                    name: cleanText(v.info?.name) || shortenPubkey(v.info?.vote_pubkey),
                    voteKey: v.info?.vote_pubkey || '',
                    value: lamportsToSol(v.poolStake?.active_lamports || 0),
                    color: gradient.mainColor,
                    gradient,
                    hidden: hiddenValidatorKeys.has(v.info?.vote_pubkey)
                };
            });
            
            // Додаємо "Others" якщо є
            if (others.length > 0) {
                const othersTotal = others.reduce((sum, v) => sum + (v.poolStake?.active_lamports || 0), 0);
                allChartData.push({
                    name: `Others (${others.length})`,
                    voteKey: 'others',
                    value: lamportsToSol(othersTotal),
                    color: '#6B7280',
                    gradient: { color1: '#8B9298', color2: '#5B6168', mainColor: '#6B7280' },
                    hidden: hiddenValidatorKeys.has('others')
                });
            }
            
            // Фільтруємо видимі для діаграми
            const visibleData = allChartData.filter(d => !d.hidden);
            const total = visibleData.reduce((sum, d) => sum + d.value, 0);
            
            // Чи є приховані валідатори
            const hasHidden = hiddenValidatorKeys.size > 0;
            
            if (total === 0) {
                if (centerEl) centerEl.style.display = 'none';
                container.innerHTML = `
                    <div class="chart-no-data-container">
                        <div class="chart-no-data-text">No stake data</div>
                    </div>`;
                // Показуємо Reset кнопку якщо є приховані валідатори
                if (hasHidden) {
                    legendContainer.innerHTML = `
                        <div class="legend-reset" title="Show all validators">
                            <i class="fas fa-undo"></i> Reset
                        </div>
                    `;
                    // Додаємо обробник для Reset
                    const resetBtn = legendContainer.querySelector('.legend-reset');
                    if (resetBtn) {
                        resetBtn.addEventListener('click', () => {
                            resetHiddenValidators();
                            renderStakeDistributionChart(validators, searchQuery);
                        });
                    }
                } else {
                    legendContainer.innerHTML = '';
                }
                return;
            }
            
            // Оновлюємо subtitle
            if (subtitleEl) {
                if (searchQuery) {
                    const matchText = others.length > 0 
                        ? `${topValidators.length} + ${others.length} others`
                        : `${topValidators.length}`;
                    subtitleEl.textContent = `Showing ${matchText} matching query`;
                } else {
                    subtitleEl.textContent = `Top ${Math.min(MAX_ITEMS, sorted.length)} by pool stake`;
                }
            }
            
            // Генеруємо SVG donut
            const size = 200;
            const strokeWidth = 44;
            const radius = (size - strokeWidth) / 2;
            const circumference = 2 * Math.PI * radius;
            const cx = size / 2;
            const cy = size / 2;
            // Внутрішній діаметр (порожній простір в центрі)
            const innerDiameter = size - strokeWidth * 2;
            
            // Логотип пулу в центрі - коло впритул до діаграми
            if (centerEl) {
                const poolDef = latestPoolDefinitions.find(p => p.group === currentPoolGroup);
                const logoUri = poolDef?.logo_uri || poolDef?.image;
                if (total > 0) {
                    // Center wrapper fills the entire inner space of the donut.
                    // Its border continues from the donut ring inner edge, with
                    // no visible gap. Logo padding (12%) is handled inside the
                    // wrapper by the img's CSS, not by shrinking the wrapper.
                    const logoSize = innerDiameter;
                    centerEl.style.width = `${logoSize}px`;
                    centerEl.style.height = `${logoSize}px`;
                    if (isValidHttpUrl(logoUri)) {
                        // Block B: theme-variant resolution for donut center image
                        const isDarkDonut = document.body.classList.contains('dark-theme-body');
                        const resolvedDonut = resolveLogoUrlSync(logoUri, isDarkDonut, 256);
                        // A failed sprite is replaced by the flat logo (the capture
                        // listener marks it); only a failed flat logo hides the centre.
                        centerEl.innerHTML = `<img src="${resolvedDonut}" data-logo-default="${logoUri}" data-logo-iso="256" alt="" draggable="false" onerror="if(this.dataset.isoFallback){delete this.dataset.isoFallback;return;}this.parentElement.style.display='none'">`;
                    } else {
                        // Fallback SVG for pools without image (e.g. OTHER aggregate).
                        // Wrapped in svg-logo div so existing CSS can size it properly.
                        const otherSprite = currentPoolGroup === 'OTHER' ? otherIsoImg(256) : '';
                        centerEl.innerHTML = otherSprite || `<div class="donut-svg-fallback">${OTHER_GROUP_SVG}</div>`;
                    }
                    centerEl.style.display = 'flex';
                } else {
                    centerEl.style.display = 'none';
                }
            }
            
            // Розраховуємо сегменти з реальним gap між ними
            const gapDegrees = 1.5; // градуси для видимого gap
            const totalGapDegrees = visibleData.length * gapDegrees;
            const availableDegrees = 360 - totalGapDegrees;
            
            let currentAngle = 0;
            const segments = visibleData.map((d, i) => {
                const percentage = d.value / total;
                const segmentDegrees = percentage * availableDegrees;
                const startAngle = currentAngle;
                const endAngle = currentAngle + segmentDegrees;
                currentAngle = endAngle + gapDegrees;
                
                return {
                    ...d,
                    percentage,
                    startAngle,
                    endAngle,
                    visibleIndex: i
                };
            });
            
            // Генеруємо градієнти для кожного сегмента
            const chartId = `donut-${Date.now()}`;
            const gradientDefs = segments.map((seg, i) => `
                <linearGradient id="${chartId}-grad-${i}" gradientTransform="rotate(${45 + seg.startAngle})">
                    <stop offset="0%" stop-color="${seg.gradient.color1}" />
                    <stop offset="100%" stop-color="${seg.gradient.color2}" />
                </linearGradient>
            `).join('');
            
            // Функція для створення arc path
            function describeArc(cx, cy, r, startAngle, endAngle, strokeWidth) {
                const innerR = r - strokeWidth / 2;
                const outerR = r + strokeWidth / 2;
                
                const startRad = (startAngle - 90) * Math.PI / 180;
                const endRad = (endAngle - 90) * Math.PI / 180;
                
                const x1Outer = cx + outerR * Math.cos(startRad);
                const y1Outer = cy + outerR * Math.sin(startRad);
                const x2Outer = cx + outerR * Math.cos(endRad);
                const y2Outer = cy + outerR * Math.sin(endRad);
                
                const x1Inner = cx + innerR * Math.cos(endRad);
                const y1Inner = cy + innerR * Math.sin(endRad);
                const x2Inner = cx + innerR * Math.cos(startRad);
                const y2Inner = cy + innerR * Math.sin(startRad);
                
                const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;
                
                return `M ${x1Outer} ${y1Outer} 
                        A ${outerR} ${outerR} 0 ${largeArc} 1 ${x2Outer} ${y2Outer}
                        L ${x1Inner} ${y1Inner}
                        A ${innerR} ${innerR} 0 ${largeArc} 0 ${x2Inner} ${y2Inner}
                        Z`;
            }
            
            // SVG з сегментами як path (без артефактів)
            const segmentPaths = segments.map((seg, i) => `
                <path 
                    class="donut-segment" 
                    data-votekey="${seg.voteKey}"
                    data-index="${i}"
                    d="${describeArc(cx, cy, radius, seg.startAngle, seg.endAngle, strokeWidth)}"
                    fill="url(#${chartId}-grad-${i})"
                    style="cursor: pointer;"
                />
            `).join('');
            
            const animateClass = animate ? 'donut-animate' : '';
            
            container.innerHTML = `
                <div class="distribution-tooltip"></div>
                <svg viewBox="0 0 ${size} ${size}" class="donut-svg ${animateClass}">
                    <defs>
                        ${gradientDefs}
                    </defs>
                    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="var(--border-color)" stroke-width="${strokeWidth}" opacity="0.1"/>
                    ${segmentPaths}
                </svg>
            `;
            
            // Генеруємо легенду (всі елементи, включаючи приховані)
            const formatValue = (val) => {
                if (val >= 1_000_000) return `${(val/1_000_000).toFixed(1)}M`;
                if (val >= 1_000) return `${(val/1_000).toFixed(0)}K`;
                return val.toFixed(0);
            };
            
            // Кнопка Reset якщо є приховані
            const resetBtn = hasHidden ? `
                <div class="legend-reset" title="Show all validators">
                    <i class="fas fa-undo"></i> Reset
                </div>
            ` : '';
            
            legendContainer.innerHTML = resetBtn + allChartData.map(item => {
                const seg = segments.find(s => s.voteKey === item.voteKey);
                const percentage = seg ? (seg.percentage * 100).toFixed(1) : '0.0';
                return `
                    <div class="legend-item ${item.hidden ? 'disabled' : ''}" data-votekey="${escapeHtml(item.voteKey)}">
                        <span class="legend-color" style="background-color: ${item.color};"></span>
                        <span class="legend-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                        <span class="legend-value">${item.hidden ? '-' : percentage + '%'}</span>
                    </div>
                `;
            }).join('');
            
            // Інтерактивність
            const tooltip = container.querySelector('.distribution-tooltip');
            const svgSegments = container.querySelectorAll('.donut-segment');
            const legendItems = legendContainer.querySelectorAll('.legend-item');
            const resetButton = legendContainer.querySelector('.legend-reset');
            
            // Reset button handler
            if (resetButton) {
                resetButton.addEventListener('click', () => {
                    resetHiddenValidators();
                    renderStakeDistributionChart(validators, searchQuery);
                });
            }
            
            function showTooltip(seg, x, y) {
                tooltip.innerHTML = `
                    <div class="tooltip-name" style="color: ${seg.color};">${escapeHtml(seg.name)}</div>
                    <div class="tooltip-value">${formatValue(seg.value)} SOL (${(seg.percentage * 100).toFixed(1)}%)</div>
                `;
                tooltip.style.opacity = '1';
                tooltip.style.left = `${x}px`;
                tooltip.style.top = `${y}px`;
            }
            
            function hideTooltip() {
                tooltip.style.opacity = '0';
            }
            
            function highlightSegment(voteKey) {
                svgSegments.forEach(s => {
                    s.style.opacity = s.dataset.votekey === voteKey ? '1' : '0.4';
                });
            }
            
            function resetHighlight() {
                svgSegments.forEach(s => s.style.opacity = '1');
            }
            
            function toggleValidator(voteKey) {
                if (hiddenValidatorKeys.has(voteKey)) {
                    hiddenValidatorKeys.delete(voteKey);
                } else {
                    hiddenValidatorKeys.add(voteKey);
                }
                // Перебудовуємо діаграму БЕЗ анімації (animate = false)
                renderStakeDistributionChart(validators, searchQuery, false);
            }
            
            // Events для SVG сегментів
            svgSegments.forEach(seg => {
                const voteKey = seg.dataset.votekey;
                const segData = segments.find(s => s.voteKey === voteKey);
                
                seg.addEventListener('mouseenter', (e) => {
                    highlightSegment(voteKey);
                    if (segData) {
                        const rect = container.getBoundingClientRect();
                        showTooltip(segData, e.clientX - rect.left, e.clientY - rect.top - 40);
                    }
                });
                seg.addEventListener('mousemove', (e) => {
                    const rect = container.getBoundingClientRect();
                    tooltip.style.left = `${e.clientX - rect.left}px`;
                    tooltip.style.top = `${e.clientY - rect.top - 40}px`;
                });
                seg.addEventListener('mouseleave', () => {
                    resetHighlight();
                    hideTooltip();
                });
                seg.addEventListener('click', () => {
                    toggleValidator(voteKey);
                });
            });
            
            // Events для легенди
            legendItems.forEach(item => {
                const voteKey = item.dataset.votekey;
                
                item.addEventListener('mouseenter', () => {
                    if (!hiddenValidatorKeys.has(voteKey)) {
                        highlightSegment(voteKey);
                    }
                });
                item.addEventListener('mouseleave', () => {
                    resetHighlight();
                });
                item.addEventListener('click', () => {
                    toggleValidator(voteKey);
                });
            });
        }
        
        // Графік динаміки епохи (activating/deactivating) - об'єднаний SVG sparkline
        function renderEpochDynamicsSparklines(historyData, poolName = '', highlightEpoch = null) {
            const block = document.querySelector('.epoch-dynamics-block');
            const container = document.getElementById('pool-epoch-dynamics-chart');
            
            if (!block || !container) return;
            
            // Перевіряємо чи є дані для відображення
            const hasActivatingData = historyData.some(d => d.activating_lamports > 0);
            const hasDeactivatingData = historyData.some(d => d.deactivating_lamports > 0);
            
            if (historyData.length < 2 || (!hasActivatingData && !hasDeactivatingData)) {
                block.classList.add('no-data');
                return;
            }
            
            block.classList.remove('no-data');
            container.style.display = 'block';
            
            const formatValue = (val) => {
                if (val >= 1_000_000) return `${(val/1_000_000).toFixed(2)}M`;
                if (val >= 1_000) return `${(val/1_000).toFixed(1)}K`;
                return val.toFixed(0);
            };
            
            const width = container.clientWidth;
            if (width === 0) {
                if ('ResizeObserver' in window) {
                    const ro = new ResizeObserver((entries) => {
                        if (entries[0]?.contentRect.width > 0) {
                            ro.disconnect();
                            renderEpochDynamicsSparklines(historyData, poolName, highlightEpoch);
                        }
                    });
                    ro.observe(container);
                }
                return;
            }
            
            const height = 140; // Загальна висота (70 зверху + 70 знизу)
            const halfHeight = height / 2;
            const PADDING = 5;
            
            // Готуємо дані
            const activatingValues = historyData.map(d => lamportsToSol(d.activating_lamports || 0));
            const deactivatingValues = historyData.map(d => lamportsToSol(d.deactivating_lamports || 0));
            
            // Визначаємо масштаб залежно від режиму
            let maxActivating, maxDeactivating;
            if (epochDynamicsScaleMode === 'unified') {
                // Однаковий масштаб - використовуємо спільний максимум
                const maxValue = Math.max(...activatingValues, ...deactivatingValues, 1);
                maxActivating = maxValue;
                maxDeactivating = maxValue;
            } else {
                // Окремий масштаб для кожного графіка
                maxActivating = Math.max(...activatingValues, 1);
                maxDeactivating = Math.max(...deactivatingValues, 1);
            }
            
            // Точки для activating (від центру вгору)
            const activatingPoints = historyData.map((d, i) => {
                const x = (i / (historyData.length - 1 || 1)) * width;
                const val = lamportsToSol(d.activating_lamports || 0);
                const y = halfHeight - PADDING - (val / maxActivating) * (halfHeight - 2 * PADDING);
                return { x, y, epoch: d.epoch, activating: val, deactivating: lamportsToSol(d.deactivating_lamports || 0) };
            });
            
            // Точки для deactivating (від центру вниз)
            const deactivatingPoints = historyData.map((d, i) => {
                const x = (i / (historyData.length - 1 || 1)) * width;
                const val = lamportsToSol(d.deactivating_lamports || 0);
                const y = halfHeight + PADDING + (val / maxDeactivating) * (halfHeight - 2 * PADDING);
                return { x, y };
            });
            
            // Визначаємо маркер обраної епохи
            const lastEpoch = historyData[historyData.length - 1].epoch;
            const currentEpoch = highlightEpoch || poolChartsData.currentEpoch;
            const isLastEpoch = currentEpoch !== null && Number(currentEpoch) === Number(lastEpoch);
            
            let marker = null;
            let markerIdx = -1;
            if (currentEpoch !== null && !isLastEpoch) {
                markerIdx = historyData.findIndex(d => Number(d.epoch) === Number(currentEpoch));
                if (markerIdx === -1) {
                    let best = 0, bestDiff = Infinity;
                    historyData.forEach((d, i) => {
                        const diff = Math.abs(Number(d.epoch) - Number(currentEpoch));
                        if (diff < bestDiff) { bestDiff = diff; best = i; }
                    });
                    markerIdx = best;
                }
                marker = activatingPoints[markerIdx];
            }
            
            // Path для activating
            const activatingPathLine = activatingPoints.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L ');
            const activatingPathFill = `M ${activatingPoints[0].x.toFixed(2)},${halfHeight} L ${activatingPathLine} L ${activatingPoints[activatingPoints.length-1].x.toFixed(2)},${halfHeight} Z`;
            
            // Path для deactivating
            const deactivatingPathLine = deactivatingPoints.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' L ');
            const deactivatingPathFill = `M ${deactivatingPoints[0].x.toFixed(2)},${halfHeight} L ${deactivatingPathLine} L ${deactivatingPoints[deactivatingPoints.length-1].x.toFixed(2)},${halfHeight} Z`;
            
            const gradientDefs = `
                <defs>
                    <linearGradient id="epoch-gradient-activating" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="rgba(20, 241, 149, 0.5)" />
                        <stop offset="100%" stop-color="rgba(20, 241, 149, 0.05)" />
                    </linearGradient>
                    <linearGradient id="epoch-gradient-deactivating" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stop-color="rgba(255, 107, 107, 0.05)" />
                        <stop offset="100%" stop-color="rgba(255, 107, 107, 0.5)" />
                    </linearGradient>
                </defs>
            `;
            
            container.innerHTML = `
                <div class="chart-tooltip epoch-dynamics-tooltip"></div>
                <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="overflow: visible; cursor: pointer;">
                    ${gradientDefs}
                    <line class="epoch-center-line" x1="0" y1="${halfHeight}" x2="${width}" y2="${halfHeight}"></line>
                    <path d="${activatingPathFill}" class="chart-path-fill" style="fill: url(#epoch-gradient-activating);" />
                    <path d="M ${activatingPathLine}" class="chart-path-line" style="stroke: #14F195;" />
                    <path d="${deactivatingPathFill}" class="chart-path-fill" style="fill: url(#epoch-gradient-deactivating);" />
                    <path d="M ${deactivatingPathLine}" class="chart-path-line" style="stroke: #FF6B6B;" />
                    ${marker ? `<line class="selected-epoch-line" x1="${marker.x}" x2="${marker.x}" y1="0" y2="${height}"></line>` : ''}
                    ${marker ? `<circle class="selected-epoch-dot" cx="${marker.x}" cy="${marker.y}" r="4" style="fill: #14F195;"></circle>` : ''}
                    ${marker && markerIdx >= 0 ? `<circle class="selected-epoch-dot" cx="${marker.x}" cy="${deactivatingPoints[markerIdx].y}" r="4" style="fill: #FF6B6B;"></circle>` : ''}
                    <line class="tracker-line-svg" x1="-999" x2="-999" y1="0" y2="${height}"></line>
                    <circle class="tracker-dot-svg tracker-dot-activating" cx="-999" cy="-999" r="4" style="fill: #14F195;"></circle>
                    <circle class="tracker-dot-svg tracker-dot-deactivating" cx="-999" cy="-999" r="4" style="fill: #FF6B6B;"></circle>
                </svg>
                <div class="chart-range-labels">
                    <span>${historyData[0].epoch}</span>
                    <span>${historyData[historyData.length - 1].epoch}</span>
                </div>`;
            
            // Додаємо бейдж "Epoch XXX selected"
            if (marker) {
                const badge = document.createElement('div');
                badge.className = 'selected-epoch-badge';
                badge.innerHTML = `<span class="ep">Epoch ${marker.epoch}</span><span class="sub">selected</span>`;
                container.appendChild(badge);
                
                // Позиціонуємо бейдж
                const badgeWidth = 85;
                const minLeft = badgeWidth / 2 + 5;
                const maxLeft = width - badgeWidth / 2 - 5;
                const clampedX = Math.max(minLeft, Math.min(maxLeft, marker.x));
                badge.style.left = `${clampedX}px`;
                badge.style.top = `${marker.y - 25}px`;
            }
            
            // Інтерактивність
            const svg = container.querySelector('svg');
            const tooltip = container.querySelector('.chart-tooltip');
            const trackerLine = container.querySelector('.tracker-line-svg');
            const trackerDotAct = container.querySelector('.tracker-dot-activating');
            const trackerDotDeact = container.querySelector('.tracker-dot-deactivating');
            
            tooltip.style.opacity = '0';
            trackerLine.style.opacity = '0';
            trackerDotAct.style.opacity = '0';
            trackerDotDeact.style.opacity = '0';
            
            function getSVGCoords(e) {
                const CTM = svg.getScreenCTM();
                if (!CTM) return { x: 0, y: 0 };
                return {
                    x: (e.clientX - CTM.e) / CTM.a,
                    y: (e.clientY - CTM.f) / CTM.d
                };
            }
            
            svg.addEventListener('mousemove', (e) => {
                const coords = getSVGCoords(e);
                const mouseX = coords.x;
                
                let closestIndex = 0, minDistance = Infinity;
                activatingPoints.forEach((p, i) => {
                    const d = Math.abs(p.x - mouseX);
                    if (d < minDistance) { minDistance = d; closestIndex = i; }
                });
                
                const point = activatingPoints[closestIndex];
                const deactPoint = deactivatingPoints[closestIndex];
                
                tooltip.style.opacity = '1';
                trackerLine.style.opacity = '1';
                trackerDotAct.style.opacity = '1';
                trackerDotDeact.style.opacity = '1';
                
                trackerLine.setAttribute('x1', point.x);
                trackerLine.setAttribute('x2', point.x);
                trackerDotAct.setAttribute('cx', point.x);
                trackerDotAct.setAttribute('cy', point.y);
                trackerDotDeact.setAttribute('cx', deactPoint.x);
                trackerDotDeact.setAttribute('cy', deactPoint.y);
                
                tooltip.innerHTML = `
                    <div class="epoch"><strong>Epoch ${point.epoch}</strong></div>
                    <div class="activating-line"><span class="dot" style="background:#14F195;"></span> Activating: ${formatValue(point.activating)} SOL</div>
                    <div class="deactivating-line"><span class="dot" style="background:#FF6B6B;"></span> Deactivating: ${formatValue(point.deactivating)} SOL</div>
                `;
                
                const rect = container.getBoundingClientRect();
                const tooltipRect = tooltip.getBoundingClientRect();
                let left = point.x;
                if (left < tooltipRect.width / 2 + 10) left = tooltipRect.width / 2 + 10;
                if (left > width - tooltipRect.width / 2 - 10) left = width - tooltipRect.width / 2 - 10;
                
                tooltip.style.left = `${left}px`;
                tooltip.style.top = `${halfHeight - 50}px`;
            });
            
            container.addEventListener('mouseleave', () => {
                tooltip.style.opacity = '0';
                trackerLine.style.opacity = '0';
                trackerDotAct.style.opacity = '0';
                trackerDotDeact.style.opacity = '0';
            });
            
            // Клік для вибору епохи
            svg.addEventListener('click', (e) => {
                const coords = getSVGCoords(e);
                const mouseX = coords.x;
                
                let closestIndex = 0, minDistance = Infinity;
                activatingPoints.forEach((p, i) => {
                    const d = Math.abs(p.x - mouseX);
                    if (d < minDistance) { minDistance = d; closestIndex = i; }
                });
                
                const selectedEpoch = activatingPoints[closestIndex].epoch;
                const epochSelect = document.getElementById('pool-epoch-select');
                if (epochSelect) {
                    epochSelect.value = selectedEpoch;
                    epochSelect.dispatchEvent(new Event('change'));
                }
            });
        }
        
        // Сортування валідаторів пулу
        function sortPoolValidators() {
            poolValidators.sort((a, b) => {
                let result;
                switch (poolDetailSortMode) {
                    case 'pool-stake':
                        result = (b.poolStake.active_lamports || 0) - (a.poolStake.active_lamports || 0);
                        break;
                    case 'total-stake':
                        result = (b.totals.total_active_lamports || 0) - (a.totals.total_active_lamports || 0);
                        break;
                    case 'activating':
                        result = (b.poolStake.activating_lamports || 0) - (a.poolStake.activating_lamports || 0);
                        break;
                    case 'deactivating':
                        result = (b.poolStake.deactivating_lamports || 0) - (a.poolStake.deactivating_lamports || 0);
                        break;
                    case 'name':
                        const nameA = (a.info.name || a.info.vote_pubkey || '').toLowerCase();
                        const nameB = (b.info.name || b.info.vote_pubkey || '').toLowerCase();
                        result = nameA.localeCompare(nameB);
                        break;
                    default:
                        result = 0;
                }
                // Якщо порядок asc - інвертуємо результат
                return poolDetailSortOrder === 'asc' ? -result : result;
            });
        }
        
        // Отримуємо відфільтрованих валідаторів
        function getFilteredPoolValidators() {
            const terms = splitSearchTerms(poolSearchQuery);
            if (terms.length === 0) return poolValidators;
            // Same matcher as the validators list: name, keys, client, version,
            // "delinquent"; terms joined by "+" are alternatives.
            return poolValidators.filter(v => {
                const text = validatorSearchText(v).full;
                return terms.some(term => text.includes(term));
            });
        }
        
        // Оновлення інфо-блоку для валідаторів пулу
        function updatePoolValidatorsInfoNotes() {
            const container = document.getElementById('pool-validators-info-notes');
            if (!container || !currentPoolGroup) return;
            
            const poolDef = latestPoolDefinitions.find(p => p.group === currentPoolGroup);
            const poolName = poolDef ? (poolDef.long_name || poolDef.short_name) : currentPoolGroup;
            
            // Отримуємо поточну епоху
            const poolEpochSelect = document.getElementById('pool-epoch-select');
            const currentEpoch = poolEpochSelect ? poolEpochSelect.value : latestEpochNumber;
            const isStale = Number(currentEpoch) !== Number(latestEpochNumber);
            
            const minStakeSol = lamportsToSol(MIN_ACTIVE_STAKE);
            
            container.innerHTML = `
                <div class="info-line">
                    <i class="fas fa-info-circle"></i>
                    <span>Validators in <strong>${escapeHtml(poolName)}</strong> with at least <strong>${minStakeSol} SOL</strong> of active or activating stake from this pool</span>
                </div>
                <div class="info-line">
                    <i class="fas fa-sync-alt"></i>
                    <span>Live data is refreshed continuously throughout the epoch. Complete snapshots are archived several times per epoch and at every epoch boundary.</span>
                </div>
                ${isStale ? `
                <div class="info-line">
                    <i class="fas fa-hourglass-half" style="color: #f0ad4e;"></i>
                    <span>You are viewing data from <strong>epoch ${currentEpoch}</strong>, latest is <span class="epoch-link">${latestEpochNumber}</span></span>
                </div>
                ` : ''}
            `;
        }
        
        // Оновлення статистики валідаторів пулу
        function updatePoolValidatorsStats() {
            const container = document.getElementById('pool-validators-stats-summary');
            if (!container || !currentPoolGroup) return;
            
            const poolDef = latestPoolDefinitions.find(p => p.group === currentPoolGroup);
            const poolImage = poolDef?.image || '';
            const poolLongName = poolDef ? (poolDef.long_name || poolDef.short_name || currentPoolGroup) : currentPoolGroup;
            
            const filteredValidators = getFilteredPoolValidators();
            const totalCount = poolValidators.length;
            const visibleCount = filteredValidators.length;
            
            // Отримуємо поточну епоху
            const poolEpochSelect = document.getElementById('pool-epoch-select');
            const currentEpoch = poolEpochSelect ? poolEpochSelect.value : latestEpochNumber;
            const isStale = Number(currentEpoch) !== Number(latestEpochNumber);
            const epochNote = isStale ? `<span class="epoch-inline-note">in epoch ${currentEpoch}</span>` : '';
            
            // Рахуємо суми тільки для Pool Stake цього пулу
            const totalPoolStake = filteredValidators.reduce((sum, v) => 
                sum + (v?.poolStake?.active_lamports || 0), 0);
            const totalActivatingStake = filteredValidators.reduce((sum, v) => 
                sum + (v?.poolStake?.activating_lamports || 0), 0);
            const totalDeactivatingStake = filteredValidators.reduce((sum, v) => 
                sum + (v?.poolStake?.deactivating_lamports || 0), 0);
            
            // Block B: resolve logo for current theme (stat card variant)
            const isDarkStatCard = document.body.classList.contains('dark-theme-body');
            const resolvedStatImage = resolveLogoUrlSync(poolImage, isDarkStatCard, 96);
            // Іконка пулу або fallback
            const poolIconHtml = isValidHttpUrl(poolImage) ? 
                `<img src="${resolvedStatImage}" data-logo-default="${poolImage}" data-logo-iso="96" alt="${poolLongName}">` :
                `<i class="fas fa-users"></i>`;
            
            // Текст для filtered стану - лаконічно показуємо кількість
            const isFiltered = poolSearchQuery && visibleCount < totalCount;
            const forCountText = isFiltered ? ` · ${visibleCount} shown` : '';
            
            container.innerHTML = `
                <div class="pool-validators-stat-card">
                    <div class="stat-icon">${poolIconHtml}</div>
                    <div class="stat-info">
                        <div class="stat-value">${visibleCount}</div>
                        <div class="stat-label">Validators in <strong>${poolLongName}</strong>${poolSearchQuery ? ` (of ${totalCount})` : ''} ${epochNote}</div>
                    </div>
                </div>
                <div class="pool-validators-stat-card">
                    <div class="stat-icon stat-icon-plain"><i class="fas fa-chart-pie"></i></div>
                    <div class="stat-info">
                        <div class="stat-value">${formatNumber(lamportsToSol(totalPoolStake), 1)}</div>
                        <div class="stat-label"><strong>${poolLongName}</strong> Stake${forCountText} ${epochNote}</div>
                    </div>
                </div>
                <div class="pool-validators-stat-card">
                    <div class="stat-icon stat-icon-plain"><i class="fas fa-arrow-trend-up" style="color: #28a745;"></i></div>
                    <div class="stat-info">
                        <div class="stat-value">${formatNumber(lamportsToSol(totalActivatingStake), 1)}</div>
                        <div class="stat-label">Activating${forCountText} ${epochNote}</div>
                    </div>
                </div>
                <div class="pool-validators-stat-card">
                    <div class="stat-icon stat-icon-plain"><i class="fas fa-arrow-trend-down" style="color: #dc3545;"></i></div>
                    <div class="stat-info">
                        <div class="stat-value">${formatNumber(lamportsToSol(totalDeactivatingStake), 1)}</div>
                        <div class="stat-label">Deactivating${forCountText} ${epochNote}</div>
                    </div>
                </div>
            `;
        }
        
        // Оновлення панелі сортування для валідаторів пулу
        function updatePoolValidatorsSortBar() {
            const sortBar = document.getElementById('pool-validators-sort-bar');
            if (!sortBar || !currentPoolGroup) return;
            
            const poolDef = latestPoolDefinitions.find(p => p.group === currentPoolGroup);
            const poolImage = poolDef?.image || '';
            const poolLongName = poolDef ? (poolDef.long_name || poolDef.short_name || currentPoolGroup) : currentPoolGroup;
            
            // Отримуємо поточну епоху
            const poolEpochSelect = document.getElementById('pool-epoch-select');
            const currentEpoch = poolEpochSelect ? poolEpochSelect.value : latestEpochNumber;
            const isStale = Number(currentEpoch) !== Number(latestEpochNumber);
            
            const pastEpochBadge = isStale ? `
                <span class="pool-validators-sort-badge">
                    <i class="fas fa-hourglass-half"></i> Past Epoch: ${currentEpoch}
                </span>
            ` : '';
            
            // Block B: resolve logo for current theme (sort button variant)
            const isDarkSortBar = document.body.classList.contains('dark-theme-body');
            const resolvedSortImage = resolveLogoUrlSync(poolImage, isDarkSortBar);
            // Іконка пулу для кнопки Pool Stake
            const poolIconHtml = isValidHttpUrl(poolImage) ? 
                `<img src="${resolvedSortImage}" data-logo-default="${poolImage}" class="pool-icon" alt="${poolLongName}">` : 
                `<i class="fas fa-layer-group"></i>`;
            
            // Функція для отримання іконки напрямку
            const getSortArrow = (sortKey) => {
                if (poolDetailSortMode === sortKey) {
                    return poolDetailSortOrder === 'desc' ? 
                        '<i class="fas fa-caret-down sort-arrow"></i>' : 
                        '<i class="fas fa-caret-up sort-arrow"></i>';
                }
                return '';
            };
            
            // Порядок: Total Stake → Pool Stake (active) → Activating in Pool → Deactivating in Pool
            sortBar.innerHTML = `
                <span class="label">Sort by:</span>
                <button class="pool-validators-sort-btn ${poolDetailSortMode === 'total-stake' ? 'active' : ''}" 
                        data-sort="total-stake">
                    <i class="fas fa-database"></i> Total Stake ${getSortArrow('total-stake')}
                </button>
                <button class="pool-validators-sort-btn ${poolDetailSortMode === 'pool-stake' ? 'active' : ''}" 
                        data-sort="pool-stake">
                    ${poolIconHtml} <strong>${poolLongName}</strong> Stake ${getSortArrow('pool-stake')}
                </button>
                <button class="pool-validators-sort-btn ${poolDetailSortMode === 'activating' ? 'active' : ''}" 
                        data-sort="activating">
                    <i class="fas fa-arrow-trend-up"></i> Activating ${getSortArrow('activating')}
                </button>
                <button class="pool-validators-sort-btn ${poolDetailSortMode === 'deactivating' ? 'active' : ''}" 
                        data-sort="deactivating">
                    <i class="fas fa-arrow-trend-down"></i> Deactivating ${getSortArrow('deactivating')}
                </button>
                ${pastEpochBadge}
            `;
            
            // Додаємо обробники для кнопок сортування
            sortBar.querySelectorAll('.pool-validators-sort-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const sortKey = btn.dataset.sort;
                    if (poolDetailSortMode === sortKey) {
                        // Якщо той самий режим - перемикаємо напрямок
                        poolDetailSortOrder = poolDetailSortOrder === 'desc' ? 'asc' : 'desc';
                    } else {
                        // Новий режим - починаємо з desc
                        poolDetailSortMode = sortKey;
                        poolDetailSortOrder = 'desc';
                    }
                    sortPoolValidators();
                    updatePoolValidatorsSortBar();
                    renderPoolValidatorsTable();
                });
            });
        }
        
        // Рендер таблиці валідаторів пулу
        function renderPoolValidatorsTable() {
            // Rank of every validator by its stake in this pool (kept when the table is filtered).
            const poolRankByVote = new Map();
            poolValidators.slice()
                .sort((a, b) => (b.poolStake?.active_lamports || 0) - (a.poolStake?.active_lamports || 0))
                .forEach((v, i) => { if (v.info) poolRankByVote.set(v.info.vote_pubkey, i + 1); });
            const container = document.getElementById('pool-validators-table');
            if (!container) return;
            
            // Оновлюємо інфо-блоки та статистику
            updatePoolValidatorsInfoNotes();
            updatePoolValidatorsStats();
            updatePoolValidatorsSortBar();
            
            // Оновлюємо стан пошуку
            const searchContainer = document.getElementById('pool-validators-search-container');
            if (searchContainer) {
                if (poolSearchQuery) {
                    searchContainer.classList.add('has-value');
                } else {
                    searchContainer.classList.remove('has-value');
                }
            }
            
            // Фільтруємо по пошуку
            const displayValidators = getFilteredPoolValidators();
            
            if (displayValidators.length === 0) {
                container.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--secondary-text-color);">No validators found</div>';
                return;
            }
            
            // Отримуємо інформацію про пул
            const poolDef = latestPoolDefinitions.find(p => p.group === currentPoolGroup);
            const poolImage = poolDef?.image || '';
            const poolShortName = poolDef ? (poolDef.short_name || currentPoolGroup) : currentPoolGroup;
            
            // Pool icon for the stake column header. Goes through the same
            // theme-variant resolution as the rest of the dashboard so
            // light/dark logo variants apply here too. Without
            // data-logo-default the refreshAllPoolLogos pass would miss
            // this img on theme change.
            const isDarkTableHeader = document.body.classList.contains('dark-theme-body');
            const resolvedTableHeader = isValidHttpUrl(poolImage) ? resolveLogoUrlSync(poolImage, isDarkTableHeader) : '';
            const poolIconSmall = resolvedTableHeader ?
                `<img src="${resolvedTableHeader}" data-logo-default="${poolImage}" class="table-pool-icon" alt="${poolShortName}">` :
                `<i class="fas fa-layer-group table-icon-fallback"></i>`;
            
            // Функція для отримання індикатора сортування з напрямком
            const getSortIndicator = (sortKey) => {
                if (poolDetailSortMode === sortKey) {
                    const icon = poolDetailSortOrder === 'desc' ? 'fa-caret-down' : 'fa-caret-up';
                    return `<i class="fas ${icon} pv-sort-indicator active"></i>`;
                }
                return '<i class="fas fa-sort pv-sort-indicator"></i>';
            };
            
            // Для стовпця Stake показуємо обидва режими (total і pool)
            const getStakeSortIndicator = () => {
                const isTotal = poolDetailSortMode === 'total-stake';
                const isPool = poolDetailSortMode === 'pool-stake';
                if (isTotal || isPool) {
                    const icon = poolDetailSortOrder === 'desc' ? 'fa-caret-down' : 'fa-caret-up';
                    return `<i class="fas ${icon} pv-sort-indicator active"></i>`;
                }
                return '<i class="fas fa-sort pv-sort-indicator"></i>';
            };
            
            // Визначаємо data-sort для стовпця Stake (циклічне перемикання)
            const getStakeSortKey = () => {
                // Цикл: pool-stake desc → pool-stake asc → total-stake desc → total-stake asc → pool-stake desc
                if (poolDetailSortMode === 'pool-stake' && poolDetailSortOrder === 'desc') return 'pool-stake-asc';
                if (poolDetailSortMode === 'pool-stake' && poolDetailSortOrder === 'asc') return 'total-stake-desc';
                if (poolDetailSortMode === 'total-stake' && poolDetailSortOrder === 'desc') return 'total-stake-asc';
                if (poolDetailSortMode === 'total-stake' && poolDetailSortOrder === 'asc') return 'pool-stake-desc';
                return 'pool-stake-desc';
            };
            
            // Створюємо таблицю - з клікабельними заголовками
            let html = `
                <div class="pool-validators-list">
                    <div class="pool-validators-header">
                        <div class="pv-col pv-col-validator pv-col-sortable" data-sort="name" title="Sort by name">
                            <span>Validator</span> ${getSortIndicator('name')}
                        </div>
                        <div class="pv-col pv-col-stake pv-col-sortable" data-sort="${getStakeSortKey()}" title="Sort by stake">
                            <span>Stake</span> ${getStakeSortIndicator()}
                        </div>
                        <div class="pv-col pv-col-activating pv-col-sortable" data-sort="activating" title="Sort by activating">
                            <span>Activating</span> ${getSortIndicator('activating')}
                        </div>
                        <div class="pv-col pv-col-deactivating pv-col-sortable" data-sort="deactivating" title="Sort by deactivating">
                            <span>Deactivating</span> ${getSortIndicator('deactivating')}
                        </div>
                    </div>
            `;
            
            displayValidators.forEach(validator => {
                const rawName = cleanText(validator.info.name).trim();
                const realName = hasRealName(rawName);
                const name = realName ? rawName : shortenPubkey(rawName || validator.info.vote_pubkey);
                const nameHtml = escapeHtml(name);
                const vHref = escapeHtml(validatorHref(validator.info.vote_pubkey,
                    (document.getElementById('pool-epoch-select') || {}).value));
                
                // Stake values
                const totalStake = lamportsToSol(validator.totals.total_active_lamports || 0);
                const poolStake = lamportsToSol(validator.poolStake.active_lamports || 0);
                
                // Activating values (Total та Pool)
                const totalActivating = lamportsToSol(validator.totals.total_activating_lamports || 0);
                const poolActivating = lamportsToSol(validator.poolStake.activating_lamports || 0);
                
                // Deactivating values (Total та Pool)
                const totalDeactivating = lamportsToSol(validator.totals.total_deactivating_lamports || 0);
                const poolDeactivating = lamportsToSol(validator.poolStake.deactivating_lamports || 0);
                
                // Avatar
                const rawImageUrl = validator.info?.icon_url || '';
                const imageUrl = isValidHttpUrl(rawImageUrl) ? rawImageUrl : '';
                const identityPubkey = validator.info?.identity_pubkey || '';
                const votePubkey = validator.info?.vote_pubkey || '';
                const isKnownBroken = brokenImages.has(imageUrl);
                const isDelinquent = !!(validator.meta && validator.meta.delinquent === true);
                
                const avatarHtml = (imageUrl && !isKnownBroken) ?
                    `<div class="validator-image-wrapper">
                        <img class="validator-image" src="${escapeHtml(imageUrl)}" alt="${nameHtml}" loading="lazy"
                            data-fb-name="${nameHtml}" data-fb-key="${escapeHtml(identityPubkey)}">
                    </div>` :
                    `<div class="validator-image-wrapper">
                        ${createFallbackImage(name, identityPubkey)}
                    </div>`;
                
                html += `
                    <div class="pool-validator-row${isDelinquent ? ' is-delinquent' : ''}">
                        <div class="pv-col pv-col-validator">
                            <div class="pv-validator-info">
                                <span class="pv-rank" data-cv-tip="Rank by stake in this pool, of ${poolValidators.length}">#${poolRankByVote.get(validator.info.vote_pubkey) || '-'}</span>
                                <a class="cv-vlink cv-vlink-avatar" data-cv-nav href="${vHref}" tabindex="-1" aria-hidden="true">${avatarHtml}</a>
                                <div class="pv-validator-details">
                                    <div class="pv-validator-name cv-name-line" title="${nameHtml}">
                                        <a class="cv-name-text cv-vlink" data-cv-nav href="${vHref}">${nameHtml}${CV_GO_SVG}</a>
                                        ${realName ? copyButtonHtml(rawName, 'Copy name') : ''}
                                    </div>
                                    <div class="pv-validator-pubkey cv-keys">${identityPubkey ? keyTokenHtml('ID', identityPubkey) : ''}${votePubkey ? keyTokenHtml('Vote', votePubkey) : ''}</div>
                                    ${buildMetaChipsHtml(validator.meta, poolScriptInfo)}
                                </div>
                            </div>
                        </div>
                        <div class="pv-col pv-col-stake">
                            <div class="pv-value-row">
                                <i class="fas fa-database pv-icon pv-icon-total"></i>
                                <span class="pv-value">${formatCompact(totalStake)} SOL</span>
                            </div>
                            <div class="pv-value-row pv-value-pool">
                                ${poolIconSmall}
                                <span class="pv-value pv-value-highlight">${formatCompact(poolStake)} SOL</span>
                            </div>
                        </div>
                        <div class="pv-col pv-col-activating">
                            <div class="pv-value-single">
                                ${poolIconSmall}
                                ${poolActivating > 0 ? '<i class="fas fa-arrow-trend-up pv-trend-icon pv-trend-up"></i>' : ''}
                                <span class="pv-value ${poolActivating > 0 ? 'pv-positive' : ''}">${poolActivating > 0 ? formatCompact(poolActivating) + ' SOL' : '0'}</span>
                            </div>
                        </div>
                        <div class="pv-col pv-col-deactivating">
                            <div class="pv-value-single">
                                ${poolIconSmall}
                                ${poolDeactivating > 0 ? '<i class="fas fa-arrow-trend-down pv-trend-icon pv-trend-down"></i>' : ''}
                                <span class="pv-value ${poolDeactivating > 0 ? 'pv-negative' : ''}">${poolDeactivating > 0 ? formatCompact(poolDeactivating) + ' SOL' : '0'}</span>
                            </div>
                        </div>
                    </div>
                `;
            });
            
            html += `</div>`;
            
            container.innerHTML = html;
            container.querySelectorAll('img.validator-image').forEach(img => {
                if (img.complete && img.naturalHeight === 0) {
                    window.handleValidatorImage(img, img.dataset.fbName || '', img.dataset.fbKey || '');
                }
            });
            
            // Обробники кліків на заголовки для сортування
            container.querySelectorAll('.pv-col-sortable').forEach(col => {
                col.addEventListener('click', () => {
                    const sortKey = col.dataset.sort;
                    if (!sortKey) return;
                    
                    // Для стовпця Stake - циклічне перемикання між 4 режимами
                    if (sortKey.startsWith('pool-stake') || sortKey.startsWith('total-stake')) {
                        // Парсимо ключ формату "pool-stake-desc" або "total-stake-asc"
                        const parts = sortKey.split('-');
                        const newMode = parts.slice(0, 2).join('-'); // "pool-stake" або "total-stake"
                        const newOrder = parts[2] || 'desc'; // "desc" або "asc"
                        
                        poolDetailSortMode = newMode;
                        poolDetailSortOrder = newOrder;
                    } else {
                        // Для інших стовпців - toggle напрямку або встановлення режиму
                        if (poolDetailSortMode === sortKey) {
                            // Якщо той самий режим - перемикаємо напрямок
                            poolDetailSortOrder = poolDetailSortOrder === 'desc' ? 'asc' : 'desc';
                        } else {
                            // Новий режим - починаємо з desc
                            poolDetailSortMode = sortKey;
                            poolDetailSortOrder = 'desc';
                        }
                    }
                    
                    sortPoolValidators();
                    renderPoolValidatorsTable();
                    // Оновлюємо Sort by bar щоб синхронізувати
                    updatePoolValidatorsSortBar();
                });
            });
        }
        
        // Обробники подій для breadcrumbs (перевіряємо наявність елементів)
        const breadcrumbHome = document.getElementById('breadcrumb-home');
        if (breadcrumbHome) {
            breadcrumbHome.addEventListener('click', (e) => {
                e.preventDefault();
                showMainDashboard();
                // Активуємо вкладку Pools (головна)
                activateTab('pools');
            });
        }
        
        const breadcrumbSection = document.getElementById('breadcrumb-section');
        if (breadcrumbSection) {
            breadcrumbSection.addEventListener('click', (e) => {
                e.preventDefault();
                showMainDashboard();
                // Активуємо вкладку з data-tab
                const tab = breadcrumbSection.dataset.tab || 'pools';
                activateTab(tab);
                // Скролимо до вкладок
                const tabsNav = document.querySelector('.sp-tabs-nav');
                if (tabsNav) {
                    tabsNav.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        }
        
        // Пошук в детальному виді пулу
        const poolSearchInput = document.getElementById('pool-validators-search');
        if (poolSearchInput) {
            poolSearchInput.addEventListener('input', debounce((e) => {
                poolSearchQuery = e.target.value;
                renderPoolValidatorsTable();
                // Оновлюємо Stake Distribution при пошуку
                renderStakeDistributionChart(poolValidators, poolSearchQuery);
            }, 250));
        }
        
        // Кнопка очищення пошуку
        const poolSearchClear = document.getElementById('pool-validators-search-clear');
        if (poolSearchClear) {
            poolSearchClear.addEventListener('click', () => {
                poolSearchQuery = '';
                const input = document.getElementById('pool-validators-search');
                if (input) input.value = '';
                renderPoolValidatorsTable();
                // Оновлюємо Stake Distribution при очищенні пошуку
                renderStakeDistributionChart(poolValidators, poolSearchQuery);
            });
        }
        
        // Обробник для toggle масштабу Epoch Dynamics
        const epochScaleToggle = document.getElementById('epoch-dynamics-scale-toggle');
        if (epochScaleToggle) {
            // Оновлюємо відображення кнопки відповідно до поточного режиму
            const updateScaleToggleUI = () => {
                const label = epochScaleToggle.querySelector('.toggle-label');
                if (label) {
                    label.textContent = epochDynamicsScaleMode === 'unified' ? 'Unified' : 'Separate';
                }
                epochScaleToggle.classList.toggle('active', epochDynamicsScaleMode === 'separate');
            };
            updateScaleToggleUI();
            
            epochScaleToggle.addEventListener('click', () => {
                // Перемикаємо режим
                epochDynamicsScaleMode = epochDynamicsScaleMode === 'unified' ? 'separate' : 'unified';
                safeStorage.setItem('epochDynamicsScaleMode', epochDynamicsScaleMode);
                updateScaleToggleUI();
                
                // Перемальовуємо графік
                if (poolChartsData.historyData) {
                    renderEpochDynamicsSparklines(poolChartsData.historyData, poolChartsData.poolName, poolChartsData.currentEpoch);
                }
            });
        }
        
        // Обробник для info icon tooltip на mobile (toggle по кліку)
        const scaleInfoIcon = document.getElementById('scale-info-icon');
        if (scaleInfoIcon) {
            scaleInfoIcon.addEventListener('click', (e) => {
                e.stopPropagation();
                scaleInfoIcon.classList.toggle('active');
            });
            // Закриваємо tooltip при кліку поза ним
            document.addEventListener('click', (e) => {
                if (!scaleInfoIcon.contains(e.target)) {
                    scaleInfoIcon.classList.remove('active');
                }
            });
        }
        
        // Додаємо обробник для кліку на картки пулів - ТІЛЬКИ навігація.
        // Bug 9 fix: duplicate pool-keys-toggle and desc-wrap logic was cancelling itself
        // (toggle called twice on capture+bubble phases). Keeping toggle/desc logic only
        // in the first grid listener above.
        grid.addEventListener('click', (event) => {
            const poolCard = event.target.closest('.sp-pool-card');
            const cardHeader = event.target.closest('.card-header');
            
            if (poolCard && cardHeader && !event.target.closest('button') && !event.target.closest('a')) {
                const poolGroup = poolCard.dataset.poolGroup;
                if (poolGroup) {
                    event.preventDefault();
                    showPoolDetail(poolGroup);
                    return;
                }
            }
        }, true);
        
        // ОРИГІНАЛЬНИЙ КОД: Обробник для keydown
        grid.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('desc-wrap')) {
                e.preventDefault();
                const wrap = e.target;
                if (wrap.dataset.collapsible === '1') {
                    const isCollapsed = wrap.classList.toggle('collapsed');
                    wrap.setAttribute('aria-expanded', String(!isCollapsed));
                }
            }
        });
        
        // Bug 9 fix: removed document-level desc-wrap click handler.
        // The desc-wrap toggle is already handled by the grid-level listener above,
        // so duplicating it at document level caused the toggle to fire multiple times
        // and eat the user's click. Description collapse is fully handled upstream.
        
        // Перевіряємо URL при завантаженні для показу пулу
        const urlParams = new URLSearchParams(window.location.search);
        const poolParam = urlParams.get('pool');
        cvShowPool = showPoolDetail;
        cvShowMain = showMainDashboard;
        cvVdInit();
        if (searchQuery) cvEnsureIndexForSearch(searchQuery);
        if (urlState.validator) {
            // activateTab() above rewrote the epoch parameter: restore the link as it came.
            window.history.replaceState({}, '', validatorHref(urlState.validator, urlState.epoch));
            cvRenderRoute(true);
        } else if (poolParam) {
            setTimeout(() => {
                showPoolDetail(poolParam, { history: true, fresh: true });
            }, 100);
        }
        
        // ВИПРАВЛЕННЯ: Обробка кнопки "назад" браузера
        window.addEventListener('popstate', function() {
            cvRenderRoute(false);
        });
        
        
        window.addEventListener('resize', refreshDescCollapsers);
        window.addEventListener('resize', redrawAllChartsDebounced);
        window.addEventListener('scroll', window.hidePoolTooltip, { passive: true });
    }

    // Запускаємо основну функцію. Будь-який неперехоплений виняток
    // показуємо користувачу замість тихого зависання на "Loading data... 0%".
    main().catch(err => {
        console.error('[stake-dashboard] main() crashed:', err);
        const dash = document.getElementById('stake-pool-dashboard');
        if (dash) {
            dash.innerHTML = '<div style="text-align:center; padding: 40px 20px; color: #fff; max-width: 600px; margin: 0 auto;">' +
                '<h3 style="color:#ff6b6b; margin-bottom: 16px;">StakeMap could not start</h3>' +
                '<p style="color:#ccc; line-height: 1.6;">Something went wrong while loading the page:</p>' +
                '<pre style="background:#222;color:#f88;padding:12px;border-radius:6px;text-align:left;overflow:auto;font-size:12px;">' +
                  (err && err.message ? err.message : String(err)) +
                '</pre>' +
                '<p style="color:#ccc;"><a href="javascript:location.reload()" style="color:#4a90ff;">Refresh page</a> or open browser console (F12) for details.</p>' +
                '</div>';
        }
        const loader = document.getElementById('sofzp-loader-overlay');
        if (loader) loader.classList.add('hidden');
    });
});