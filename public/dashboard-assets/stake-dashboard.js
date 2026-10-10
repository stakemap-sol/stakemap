document.addEventListener('DOMContentLoaded', function () {
    // ============================================
    // CONSTANTS AND CONFIGURATION
    // ============================================
    // Dashboard release version, shown in the info line. The wrapper page
    // (src/pages/index.astro) parses this exact
    // line at build time for the JSON-LD softwareVersion: keep the format.
    const DASHBOARD_VERSION = '3.2.0';
    const FALLBACK_JSON_URL = 'https://raw.githubusercontent.com/stakemap-sol/Solana-Stake-Pools-Research/main/stakepool-data/mainnet-beta/820/mainnet-beta-4.json';
    const MANIFEST_URL = 'https://raw.githubusercontent.com/stakemap-sol/Solana-Stake-Pools-Research/main/stakepool-data/mainnet-beta/manifest.json';
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
    // A pool card has this many places for key signs: all the keys when they
    // fit, otherwise one place goes to the number of the rest (they are on
    // the pool page).
    const CARD_KEYS_SHOWN = 5;
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
    // The data repo can sit under two owners inside one manifest: files
    // published before its move to the organisation keep the earlier owner
    // in their URLs, newer files carry the new one. Both map to the same
    // path on the data API.
    const DATA_REPO_OWNERS = ['SOFZP', 'stakemap-sol'];
    function dataMirrorUrl(url) {
        if (typeof url !== 'string') return null;
        const githubBase = MANIFEST_URL.replace(/[^/]*$/, '');
        const mirrorBase = LIVE_DATA_URL_DEFAULT.replace(/[^/]*$/, '');
        const bases = [githubBase];
        DATA_REPO_OWNERS.forEach((owner) => {
            const b = githubBase.replace(/^(https:\/\/raw\.githubusercontent\.com\/)[^/]+\//, '$1' + owner + '/');
            if (bases.indexOf(b) === -1) bases.push(b);
        });
        for (let i = 0; i < bases.length; i++) {
            if (url.indexOf(bases[i]) === 0) return mirrorBase + url.slice(bases[i].length);
        }
        return null;
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

    // sessionStorage cache for the small answers of the data pipeline (the
    // manifest); larger ones (the aggregated history, a snapshot) are only
    // parsed. Cache TTL is 90 seconds, which is well below the typical
    // interval at which Block E pre-aggregation runs, so a cached read should
    // always reflect a recent cluster scan.
    //
    // Why sessionStorage and not localStorage: per-tab is appropriate here,
    // we do not want a multi-day-old payload from a tab opened last week to
    // override a fresh load. Browser will also evict on tab close which is
    // exactly the lifetime we want.
    const CACHE_TTL_MS = 90 * 1000;
    const CACHE_PREFIX = 'cv:cache:';
    const CACHE_MAX_CHARS = 500000;

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
        // The text of the answer is parsed once. Only a small answer (the
        // manifest) goes into the cache: the history and a snapshot are
        // megabytes each, never fit the quota of the storage, and making a
        // second copy of their text on every load cost time and memory.
        const text = await resp.text();
        const data = JSON.parse(text);
        if (text.length <= CACHE_MAX_CHARS) {
            safeStorage.setItem(cacheKey, '{"ts":' + Date.now() + ',"data":' + text + '}', 'session');
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
    // Total active stake of the epoch on screen (the share of a pool is taken from it).
    let cvNetworkActive = 0;
    let currentSortMode = 'category';
    // (a second click on a measure flips it to smallest first)
    let currentSortAsc = false;
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
    // (the rows of the list on screen, and the list they were counted for)
    let poolRowsVisible = VALIDATORS_PER_PAGE;
    let poolRowsFor = '';
    let poolIndexAsked = false;   // the validators index is on its way for the ages of the list
    let poolDetailSortMode = 'pool-stake';
    let poolDetailSortOrder = 'desc'; // 'desc' = від більшого до меншого, 'asc' = навпаки
    // The validators of a pool: a list of rows or a map of bubbles (the
    // choice is kept), the map on screen, and the active stake of the pool
    // the shares in the tooltips of the bubbles are counted from.
    let poolValidatorsView = safeStorage.getItem('poolValidatorsView') === 'bubbles' ? 'bubbles' : 'list';
    let poolBubblesMap = null;
    let poolBubblesTotal = 0;
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
    
    // A SOL amount in two forms for a stat card: the full number, and a short
    // one that narrow screens show instead (441.74M). The tooltip with the
    // full number opens only while the short form is on screen.
    const shortSol = (sol) => sol >= 1e6 ? (sol / 1e6).toFixed(2) + 'M'
        : (sol >= 1e3 ? (sol / 1e3).toFixed(1) + 'K' : formatNumber(sol, 2));
    const numPairHtml = (sol, digits) => '<span class="cv-num-full">' + formatNumber(sol, digits) +
        '</span><span class="cv-num-short">' + shortSol(sol) + '</span>';
    // Stat cards carry the isometric icons of the StakeMap set: one file per
    // meaning, the same in both themes.
    const cardIco = (name, extraClass) => '<img class="cv-ico' + (extraClass ? ' ' + extraClass : '') +
        '" src="/brand/icons/' + name + '.webp" alt="" aria-hidden="true" width="48" height="48" decoding="async">';
    const shortTipAttr = (label, sol) => ' data-cv-tip="' + label + ': ' + formatNumber(sol, 2) +
        ' SOL" data-cv-tip-when="short"';
    // Small cells under the chart of a card: the sign of a measure, its
    // value and a small name. An odd last cell takes the whole row.
    // cells: [{ icon, label, value, tip, zero, cls }]
    function microCellsHtml(cells) {
        return '<div class="cv-cells">' + cells.map(c => '<div class="cv-cell' + (c.zero ? ' is-zero' : '') + '"' +
            (c.tip ? ' data-cv-tip="' + escapeHtml(c.tip) + '"' : '') + '>' + cardIco(c.icon) + '<span class="cv-cell-text"><b' +
            (c.cls ? ' class="' + c.cls + '"' : '') + '>' + c.value + '</b><small>' + c.label + '</small></span></div>').join('') + '</div>';
    }
    // A SOL amount as a card shows it: short from ten thousand SOL (26.67M,
    // 385.4K), whole SOL from a thousand (9,056), two decimals below.
    // exact: the text is the whole amount, so no tooltip has to repeat it.
    function cardSol(sol) {
        if (sol >= 1e4) return { text: shortSol(sol), exact: false };
        if (sol >= 1e3) return { text: formatNumber(sol, 0), exact: false };
        return { text: formatNumber(sol, 2), exact: true };
    }
    // The cell of stake on the move: a short number (the exact amount is in
    // its tooltip), muted when there is none. On a past epoch the tooltip
    // names the epoch.
    function flowCell(icon, label, lamports, epoch) {
        const sol = lamportsToSol(lamports || 0);
        const zero = !(sol >= 0.005);
        const past = epoch !== null && epoch !== undefined;
        const shown = cardSol(sol);
        return { icon, label, zero, value: zero ? '0' : shown.text,
            // (in a card the amount on the move has the colour of its direction;
            // the tiles of a pool-page row draw their own markup and stay plain)
            cls: zero ? '' : (icon === 'activating' ? 'cv-vd-pos' : (icon === 'deactivating' ? 'cv-vd-neg' : '')),
            tip: (past || !shown.exact) ? label + (past ? ' in epoch ' + epoch : '') + ': ' + formatNumber(sol, 2) + ' SOL' : '' };
    }
    // The two head cells of a card: a larger sign, the main number, its name.
    // heads: [{ icon, label, value, tip }]
    function headCellsHtml(heads) {
        return '<div class="cv-heads">' + heads.map(c => '<div class="cv-head"' + (c.tip ? ' data-cv-tip="' + escapeHtml(c.tip) + '"' : '') + '>' +
            cardIco(c.icon) + '<span class="cv-cell-text"><b>' + c.value + '</b><small>' + c.label + '</small></span></div>').join('') + '</div>';
    }
    // A share as text: one decimal from 10%, two below, "<0.01%" for a trace.
    function shareText(pct) {
        if (!(pct > 0)) return '0%';
        if (pct < 0.01) return '&lt;0.01%';
        if (pct >= 99.95) return '100%';
        return (pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)) + '%';
    }
    // One sort bar for every list of the site: a small sign instead of the
    // word "Sort", then the options. The active option of a measure carries
    // a caret, and a second click on it flips the direction.
    // items: [{ attr, icon | lead, label, active, dir (it has a direction) }]
    function sortBarHtml(items, dir, tail) {
        return '<div class="cv-sort-row" data-cv-scroll="x"><span class="cv-sort-sign" data-cv-tip="Sort"><i class="fas fa-arrow-down-wide-short" aria-hidden="true"></i></span>' +
            items.map(it => '<button type="button" class="sort-btn' + (it.active ? ' active' : '') + '"' + (it.attr || '') + '>' +
                (it.lead || '<i class="fas ' + it.icon + '" aria-hidden="true"></i>') + '<span>' + it.label + '</span>' +
                (it.active && it.dir ? '<i class="fas ' + (dir === 'asc' ? 'fa-caret-up' : 'fa-caret-down') + ' sort-arrow" aria-hidden="true"></i>' : '') +
                '</button>').join('') + '</div>' + scrollArrowsHtml('x') + (tail || '');
    }
    // ---------- scroll hints ----------
    // A box that scrolls without a visible scrollbar (data-cv-scroll="x" or
    // "y") says so with small arrows over its faded edges: one at the far
    // edge while content waits there, one at the near edge once the box has
    // moved. A tap on an arrow moves the box by most of its size, or to the
    // very end when little is left after that. The two arrows are the
    // elements that follow the box.
    function scrollArrowsHtml(axis) {
        const icons = axis === 'y' ? ['fa-chevron-down', 'fa-chevron-up'] : ['fa-chevron-right', 'fa-chevron-left'];
        return '<button type="button" class="cv-scroll-arrow cv-scroll-next" tabindex="-1" aria-hidden="true"><i class="fas ' + icons[0] + '"></i></button>' +
            '<button type="button" class="cv-scroll-arrow cv-scroll-prev" tabindex="-1" aria-hidden="true"><i class="fas ' + icons[1] + '"></i></button>';
    }
    function scrollHintSync(box) {
        if (!box) return;
        const y = box.getAttribute('data-cv-scroll') === 'y';
        const size = y ? box.clientHeight : box.clientWidth;
        if (!size) return;
        const pos = y ? box.scrollTop : box.scrollLeft;
        const rest = (y ? box.scrollHeight : box.scrollWidth) - size - pos;
        box.classList.toggle('has-more', rest > 2);
        box.classList.toggle('has-less', pos > 2);
    }
    const scrollHintWatch = ('ResizeObserver' in window) ? new ResizeObserver(entries => entries.forEach(en => scrollHintSync(en.target))) : null;
    const scrollHintSeen = new WeakSet();
    // Call after the box got its content (and again whenever the content changes).
    function scrollHint(box) {
        if (!box) return;
        if (scrollHintWatch && !scrollHintSeen.has(box)) {
            scrollHintSeen.add(box);
            scrollHintWatch.observe(box);
        }
        scrollHintSync(box);
    }
    // (a scroll event does not bubble, but the document sees it on the way down)
    document.addEventListener('scroll', (e) => {
        const box = e.target;
        if (box && box.nodeType === 1 && box.hasAttribute('data-cv-scroll')) scrollHintSync(box);
    }, { capture: true, passive: true });
    document.addEventListener('click', (e) => {
        const arrow = e.target && e.target.closest ? e.target.closest('.cv-scroll-arrow') : null;
        if (!arrow) return;
        let box = arrow.previousElementSibling;
        while (box && !box.hasAttribute('data-cv-scroll')) box = box.previousElementSibling;
        if (!box) return;
        const y = box.getAttribute('data-cv-scroll') === 'y';
        const size = y ? box.clientHeight : box.clientWidth;
        const pos = y ? box.scrollTop : box.scrollLeft;
        const back = arrow.classList.contains('cv-scroll-prev');
        const rest = back ? pos : (y ? box.scrollHeight : box.scrollWidth) - size - pos;
        const step = Math.round(size * 0.6);
        const by = (rest - step < 48 ? rest : step) * (back ? -1 : 1);
        box.scrollBy(y ? { top: by, behavior: 'smooth' } : { left: by, behavior: 'smooth' });
    });
    // On phones the options of a sort bar are one row that scrolls sideways,
    // and the active option stays in sight.
    function sortBarSync(row, showActive) {
        if (!row || !row.clientWidth) return;
        const active = showActive ? row.querySelector('.sort-btn.active') : null;
        if (active && row.scrollWidth > row.clientWidth + 2) {
            const box = row.getBoundingClientRect();
            const a = active.getBoundingClientRect();
            if (a.left < box.left + 4) row.scrollLeft += a.left - box.left - 28;
            else if (a.right > box.right - 4) row.scrollLeft += a.right - box.right + 28;
        }
        scrollHintSync(row);
    }
    const sortBarSeen = new WeakSet();
    const sortBarWatch = ('ResizeObserver' in window)
        ? new ResizeObserver(entries => entries.forEach(en => sortBarSync(en.target.firstElementChild, true))) : null;
    function sortBarRender(bar, items, dir, tail) {
        const was = bar.firstElementChild ? bar.firstElementChild.scrollLeft : 0;
        bar.innerHTML = sortBarHtml(items, dir, tail);
        const row = bar.firstElementChild;
        row.scrollLeft = was;
        if (sortBarWatch && !sortBarSeen.has(bar)) {
            sortBarSeen.add(bar);
            sortBarWatch.observe(bar);
        }
        sortBarSync(row, true);
    }
    // The order of two amounts in a sorted list: largest first or (asc)
    // smallest first. Empty amounts (zero, unknown, or under min) always go
    // to the end, so an ascending list opens with the smallest amounts that
    // exist. Stake on the move passes min = 0.1 SOL, as everywhere on the site.
    function sortCmp(x, y, asc, min) {
        const empty = v => (min ? !(v >= min) : !(v > 0));
        const ex = empty(x);
        const ey = empty(y);
        if (ex !== ey) return ex ? 1 : -1;
        return asc ? x - y : y - x;
    }

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
        // (brief: the same reason in the two or three words of a value)
        let brief = '';
        if (!jito) {
            if (status === 'unavailable') { note = 'Jito data unavailable right now'; brief = 'no Jito data'; }
            else if (status === 'ok' || status === 'cached') { note = 'not running Jito'; brief = 'not running Jito'; }
            else { note = 'not running Jito or no Jito data'; brief = 'no Jito data'; }
        } else if (typeof jito.mev_commission_bps === 'number') {
            bps = jito.mev_commission_bps;
        } else {
            note = 'not reported yet, no blocks produced this epoch';
            brief = 'not reported yet';
        }
        let cachedNote = '';
        if (status === 'cached' && jm && typeof jm.cache_age_seconds === 'number') {
            cachedNote = 'Jito data as of ' + Math.max(1, Math.round(jm.cache_age_seconds / 60)) + ' min ago';
        }
        return { bps, note, brief, cachedNote };
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
        // Each value answers for itself: its own tooltip names it in full.
        const mevTip = ['MEV commission: ' + (mText || mev.note)];
        if (mev.cachedNote) mevTip.push(mev.cachedNote);
        const seg = (label, text, tip) => '<span class="cv-seg' + (text ? '' : ' is-missing') + '" data-cv-tip="' + escapeHtml(tip.join('\n')) + '">' +
            '<span class="cv-seg-label">' + label + '</span>' + escapeHtml(text || '-') + '</span>';
        chips.push('<span class="cv-chip cv-chip-fees">' +
            seg(L.inflation, cText, ['Commission: ' + (cText || 'not reported')]) + seg(L.mev, mText, mevTip) + '</span>');

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

    // Tooltips of copy controls are the shared glass tooltip, shown where a
    // pointer can hover (on a touch screen a tap is the copy itself).
    const CV_CAN_HOVER = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
    const cvHoverTip = (escapedText) => CV_CAN_HOVER ? ' data-cv-tip="' + escapedText + '"' : '';
    function copyButtonHtml(text, label) {
        const l = escapeHtml(label);
        return '<button type="button" class="cv-copy-btn" data-cv-copy="' + escapeHtml(text) + '"' + cvHoverTip(l) +
            ' aria-label="' + l + '">' + COPY_ICONS + '</button>';
    }

    function keyTokenHtml(label, key) {
        const k = escapeHtml(key);
        return '<button type="button" class="cv-key" data-cv-copy="' + k + '"' + cvHoverTip(k) + ' aria-label="Copy ' +
            escapeHtml(label) + ' key"><span class="cv-key-label">' + escapeHtml(label) + '</span>' +
            '<span class="cv-key-val">' + escapeHtml(shortenPubkey(key)) + '</span>' + COPY_ICONS + '</button>';
    }
    // A key as a round sign: the kind and the whole key are in its tooltip,
    // a click copies the key and says so for a moment.
    // kind: 'Staker', 'Withdrawer', 'Identity', 'Vote account'.
    function keySignHtml(kind, key, glyph) {
        const k = escapeHtml(key);
        return '<button type="button" class="cv-key cv-key-ico" data-cv-copy="' + k + '"' +
            cvHoverTip(escapeHtml(kind + ' key') + '\n' + k + '\nClick to copy') + ' data-cv-copied="' + escapeHtml(kind + ' key copied') + '\n' + k +
            '" aria-label="' + escapeHtml('Copy the ' + kind.toLowerCase() + ' key ') + k + '"><i class="fas ' + glyph + ' cv-key-glyph" aria-hidden="true"></i>' +
            '<i class="fas fa-check cv-copied-icon" aria-hidden="true"></i></button>';
    }
    // The two keys of a validator in a list row: identity, then vote account.
    function validatorKeySignsHtml(identity, vote) {
        if (!identity && !vote) return '';
        return '<span class="cv-key-signs">' + (identity ? keySignHtml('Identity', identity, 'fa-key') : '') +
            (vote ? keySignHtml('Vote account', vote, 'fa-check-to-slot') : '') + '</span>';
    }
    // The keys of a validator on its own page: the sign of a key (a key for
    // the identity, a ballot box for the vote account) and the key itself in
    // one chip. A wide header shows the whole key, a narrow one its short
    // form (compact: always the short form, as in the list of changes); the
    // tooltip names the kind and a click copies, as in the lists.
    function keyChipHtml(kind, label, key, icon, compact) {
        const k = escapeHtml(key);
        return '<button type="button" class="cv-key cv-keychip' + (compact ? ' is-compact' : '') + '" data-cv-copy="' + k + '"' +
            cvHoverTip(escapeHtml(kind + ' key') + '\n' + k + '\nClick to copy') + ' data-cv-copied="' + escapeHtml(kind + ' key copied') + '\n' + k +
            '" aria-label="' + escapeHtml('Copy the ' + kind.toLowerCase() + ' key ') + k + '">' + cardIco(icon, 'cv-keychip-ico') +
            (label ? '<span class="cv-key-label">' + escapeHtml(label) + '</span>' : '') +
            (compact ? '' : '<span class="cv-key-val cv-key-full">' + k + '</span>') +
            '<span class="cv-key-val cv-key-short">' + escapeHtml(shortenPubkey(key)) + '</span>' + COPY_ICONS + '</button>';
    }
    function validatorKeyChipsHtml(identity, vote) {
        return (identity ? keyChipHtml('Identity', 'ID', identity, 'key-identity') : '') +
            (vote ? keyChipHtml('Vote account', 'Vote', vote, 'key-vote') : '');
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

    // POOL PLOTS BEGIN
    // A pool's sprite stands on a tile of the map: on its card of the Pools
    // tab, on its card of a validator page and in the header of its own page.
    // Sizes and places are in units of the plot's width; the plot's height
    // is PLOT_BOX_H of its width.
    const PLOT_BOX_H = 0.9;
    // A usual logo takes up to 0.56 of the plot's width and 0.50 of its
    // height. A logo much wider than tall (Jito, Bybit) gets more of the
    // width, up to 0.82, and stands a little higher, so its ends stay on the
    // tile. Returns the width, the height and the bottom line of the drawing.
    function plotSpriteRule(aspect) {
        let w = Math.min(0.82, Math.max(0.56, 0.56 + (aspect - 1.45) * 0.27));
        let h = w / aspect;
        if (h > 0.50) { h = 0.50; w = h * aspect; }
        const bottom = Math.min(0.68, Math.max(0.60, 0.53 + 0.285 * (1 - 0.85 * w)));
        return { w, h, bottom };
    }
    // Sprite files differ in how much empty space surrounds the drawing, so
    // the drawn part is measured once per file and the sprite is placed by it.
    const plotBoxCache = new Map();
    function plotSpriteBox(img) {
        const key = (img.currentSrc || img.src || '').split('?')[0];
        if (plotBoxCache.has(key)) return plotBoxCache.get(key);
        let box = null;
        try {
            const w = img.naturalWidth, h = img.naturalHeight;
            if (w && h) {
                const c = document.createElement('canvas');
                c.width = w; c.height = h;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0);
                const data = ctx.getImageData(0, 0, w, h).data;
                let x0 = w, y0 = h, x1 = -1, y1 = -1;
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        if (data[(y * w + x) * 4 + 3] > 12) {
                            if (x < x0) x0 = x;
                            if (x > x1) x1 = x;
                            if (y < y0) y0 = y;
                            if (y > y1) y1 = y;
                        }
                    }
                }
                if (x1 >= x0 && y1 >= y0) box = { w, h, x0, y0, x1: x1 + 1, y1: y1 + 1 };
            }
        } catch (_) {
            box = null;
        }
        plotBoxCache.set(key, box);
        return box;
    }
    const PLOT_SPRITE_PROPS = ['width', 'height', 'left', 'top', 'bottom', 'max-height'];
    function plotPlaceSprite(img) {
        if (!img || !img.complete || !img.naturalWidth) return;
        const plot = img.parentElement;
        if (!plot || !plot.classList.contains('cv-plot')) return;
        // The flat logo standing in for a sprite keeps the plain look.
        const b = (img.getAttribute('src') || '').indexOf('/pool-logos/') === 0 ? plotSpriteBox(img) : null;
        if (!b) {
            PLOT_SPRITE_PROPS.forEach(p => img.style.removeProperty(p));
            return;
        }
        const cw = b.x1 - b.x0, ch = b.y1 - b.y0;
        const rule = plotSpriteRule(cw / ch);
        const s = rule.w / cw;
        // (set as important: the image of a pool page has fixed sizes in its base styles)
        const set = (prop, value) => img.style.setProperty(prop, value, 'important');
        set('width', (b.w * s * 100).toFixed(2) + '%');
        set('height', 'auto');
        set('left', ((0.5 - (b.x0 + cw / 2) * s) * 100).toFixed(2) + '%');
        set('top', ((rule.bottom - b.y1 * s) / PLOT_BOX_H * 100).toFixed(2) + '%');
        set('bottom', 'auto');
        set('max-height', 'none');
    }
    document.addEventListener('load', (e) => {
        const img = e.target;
        if (img && img.tagName === 'IMG' && img.dataset && img.dataset.logoIso && img.parentElement &&
            img.parentElement.classList.contains('cv-plot')) plotPlaceSprite(img);
    }, true);

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
            // Letters and digits only, by whole characters: a sign or an
            // emoji in a name is not an initial (and half of an emoji is a
            // broken glyph).
            const words = String(name).split(/\s+/)
                .map(w => Array.from(w).filter(ch => /[\p{L}\p{N}]/u.test(ch))).filter(w => w.length > 0);
            if (words.length > 1) return (words[0][0] + words[1][0]).toUpperCase();
            if (words.length === 1) return words[0].slice(0, 2).join('').toUpperCase();
            // (a name of signs alone: the key speaks for it, when there is one)
            if (!fallbackKey) return Array.from(String(name).trim()).slice(0, 2).join('') || '??';
            name = '';
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
    // (the avatar inside a bubble of a pool map: the initials take its place)
    document.addEventListener('error', (e) => {
        const img = e.target;
        if (!img || img.tagName !== 'IMG' || !img.classList.contains('cv-pbub-img')) return;
        brokenImages.add(img.src);
        const face = img.parentNode;
        if (face) face.innerHTML = '<span class="cv-bub-initials">' + escapeHtml(img.dataset.fb || '') + '</span>';
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
	
		const active = v => v.totals?.total_active_lamports || 0;
		const byActive = (a, b) => active(b) - active(a);
		const asc = validatorsSortAsc;
		switch (validatorsSortMode) {
			case 'active-stake':
				filteredValidators.sort((a, b) => sortCmp(active(a), active(b), asc));
				break;
			case 'activating':
				filteredValidators.sort((a, b) => sortCmp(a.totals?.total_activating_lamports || 0, b.totals?.total_activating_lamports || 0, asc, MIN_ACTIVE_STAKE) || byActive(a, b));
				break;
			case 'deactivating':
				filteredValidators.sort((a, b) => sortCmp(a.totals?.total_deactivating_lamports || 0, b.totals?.total_deactivating_lamports || 0, asc, MIN_ACTIVE_STAKE) || byActive(a, b));
				break;
			case 'age':
				// Oldest vote accounts first; a second click flips the order. Unknown ages stay at the end.
				filteredValidators.sort((a, b) => {
					const x = cvListAge(a);
					const y = cvListAge(b);
					return sortCmp(x ? x.value + 1 : 0, y ? y.value + 1 : 0, asc) || byActive(a, b);
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
                ${cardIco('people')}
                <div class="stat-info">
                    <div class="stat-value">${visibleCount}</div>
                    <div class="stat-label">Validators${searchQuery ? ` (of ${totalCount})` : ''}${epochNote}</div>
                </div>
            </div>
            <div class="validators-stat-card">
                ${cardIco('active-stake')}
                <div class="stat-info">
                    <div class="stat-value"${shortTipAttr('Total active stake', lamportsToSol(totalActiveStake))}>${numPairHtml(lamportsToSol(totalActiveStake), 1)}</div>
                    <div class="stat-label">Active stake${epochNote}</div>
                </div>
            </div>
            <div class="validators-stat-card">
                ${cardIco('activating')}
                <div class="stat-info">
                    <div class="stat-value"${shortTipAttr('Activating', lamportsToSol(totalActivatingStake))}>${numPairHtml(lamportsToSol(totalActivatingStake), 1)}</div>
                    <div class="stat-label">Activating${epochNote}</div>
                </div>
            </div>
            <div class="validators-stat-card">
                ${cardIco('deactivating')}
                <div class="stat-info">
                    <div class="stat-value"${shortTipAttr('Deactivating', lamportsToSol(totalDeactivatingStake))}>${numPairHtml(lamportsToSol(totalDeactivatingStake), 1)}</div>
                    <div class="stat-label">Deactivating${epochNote}</div>
                </div>
            </div>
        `;
    }

    // ============================================
    // POOL TOOLTIP HELPERS
    // ============================================
    // The width a tooltip may use: the width of the page as it is laid out.
    // (A phone browser reports a wider window when anything on the page
    // reaches past its right edge; a tooltip placed by that number leaves
    // the screen.)
    function cvWindowWidth() {
        const page = document.documentElement.clientWidth;
        return page > 0 ? Math.min(page, window.innerWidth) : window.innerWidth;
    }
    // A chart tooltip is centred on its point and stays inside its chart:
    // at an end of the line half of it would hang out of the block - on a
    // phone out of the page, which makes the page wider than the window.
    // x: the point, width: the width of the chart, both in the pixels of the chart.
    function cvChartTipLeft(tooltip, x, width) {
        const half = (tooltip.offsetWidth || 120) / 2 + 2;
        return width > 2 * half ? Math.max(half, Math.min(width - half, x)) : width / 2;
    }
    // A tooltip that follows the pointer inside a block starts at the
    // pointer and ends inside the window: near the right edge it moves left.
    // x: the pointer, counted from the left edge of the block.
    function cvPointerTipLeft(tooltip, box, x) {
        const left = box.getBoundingClientRect().left;
        return Math.max(8 - left, Math.min(x, cvWindowWidth() - 8 - left - tooltip.offsetWidth));
    }
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
		tooltip.innerHTML = element.querySelector('.pool-tooltip-content').innerHTML.replace(/ data-cv-src="/g, ' src="');
		document.body.appendChild(tooltip);
	
		// Позиціонування
		const rect = element.getBoundingClientRect();
		const tooltipRect = tooltip.getBoundingClientRect();
		const PADDING = 10;
	
		let top = rect.top - tooltipRect.height - 12;
		let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
	
		if (left < PADDING) left = PADDING;
		if (left + tooltipRect.width > cvWindowWidth() - PADDING) {
			left = cvWindowWidth() - tooltipRect.width - PADDING;
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
    // (the longest value kept in one piece; a number followed by its unit)
    const CV_TIP_VALUE_MAX = 32;
    const CV_TIP_UNIT = /(\d) (?=(?:SOL|epochs?|ep|validators?|accounts?)\b)/g;
    const CV_TIP_KEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
    function showCvTip(el) {
        let text = el.getAttribute('data-cv-tip');
        if (!text) return;
        // A key chip that shows the whole key does not repeat it in its tooltip.
        if (el.classList.contains('cv-keychip')) {
            const full = el.querySelector('.cv-key-full');
            const key = el.getAttribute('data-cv-copy');
            if (full && key && getComputedStyle(full).display !== 'none') text = text.split('\n').filter(line => line !== key).join('\n');
        }
        const when = el.getAttribute('data-cv-tip-when');
        if (when === 'short') {
            const shortForm = el.querySelector('.cv-num-short');
            if (!shortForm || getComputedStyle(shortForm).display === 'none') return;
        }
        // "clipped": the text of the element does not fit and ends with an ellipsis.
        if (when === 'clipped' && el.scrollWidth <= el.clientWidth + 1) return;
        const old = document.getElementById('dynamic-pool-tooltip');
        if (old) old.remove();
        const tip = document.createElement('div');
        tip.id = 'dynamic-pool-tooltip';
        tip.className = 'pool-tooltip cv-tip';
        text.split('\n').forEach((line, i) => {
            const row = document.createElement('div');
            row.className = i === 0 ? 'cv-tip-line cv-tip-first' : 'cv-tip-line';
            // A line never breaks inside a value: "Label: value" breaks
            // after the colon and a short value stays in one piece; in any
            // other line a unit stays with its number.
            const cut = line.indexOf(': ');
            const value = cut > 0 ? line.slice(cut + 2) : '';
            if (value && value.length <= CV_TIP_VALUE_MAX) {
                row.appendChild(document.createTextNode(line.slice(0, cut + 2)));
                const v = document.createElement('span');
                v.className = 'cv-tip-val';
                v.textContent = value;
                row.appendChild(v);
            } else if (CV_TIP_KEY.test(line)) {
                // A key is one piece: one line where the tooltip has the room,
                // two equal halves where it has not.
                const half = Math.ceil(line.length / 2);
                row.classList.add('cv-tip-key');
                [line.slice(0, half), line.slice(half)].forEach((part) => {
                    const s = document.createElement('span');
                    s.textContent = part;
                    row.appendChild(s);
                });
            } else {
                row.textContent = line.replace(CV_TIP_UNIT, '$1\u00a0');
            }
            tip.appendChild(row);
        });
        document.body.appendChild(tip);
        const rect = el.getBoundingClientRect();
        const tr = tip.getBoundingClientRect();
        const PAD = 10;
        let top = rect.top - tr.height - 10;
        let left = rect.left + rect.width / 2 - tr.width / 2;
        if (left < PAD) left = PAD;
        if (left + tr.width > cvWindowWidth() - PAD) left = cvWindowWidth() - tr.width - PAD;
        // Tooltips of the bar under the header open below the bar, so they
        // never cover the header.
        const bar = el.closest ? el.closest('#cv-subheader') : null;
        if (bar) top = bar.getBoundingClientRect().bottom + 6;
        else if (top < PAD) top = rect.bottom + 10;
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
        // Everything the page scrolls to (the tab bar, a table) stops below
        // the sticky layers: the header, the banner and this bar.
        document.documentElement.style.setProperty('--cv-sticky-offset',
            (top + Math.round(subheaderEl.getBoundingClientRect().height) + 12) + 'px');
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

    // Tooltips of the bar are the shared glass tooltip (data-cv-tip), never
    // the browser's own. A button gets one only where a pointer can hover:
    // on a touch screen a tap is the action itself.
    const SUBHEADER_HOVER = !!(window.matchMedia && window.matchMedia('(hover: hover)').matches);
    function subheaderTip(el, text, always) {
        if (!el) return;
        el.removeAttribute('title');
        if (text && (always || SUBHEADER_HOVER)) el.setAttribute('data-cv-tip', text);
        else el.removeAttribute('data-cv-tip');
    }

    // How long ago a snapshot was taken, in words.
    function subheaderAgoText(iso) {
        const t = Date.parse(iso);
        if (!isFinite(t)) return '';
        const min = Math.max(0, Math.round((Date.now() - t) / 60000));
        if (min < 1) return 'updated just now';
        if (min < 60) return 'updated ' + min + ' min ago';
        return 'updated ' + Math.floor(min / 60) + ' h ' + (min % 60) + ' min ago';
    }

    function subheaderSyncEpoch() {
        if (!subheaderEl) return;
        const box = subheaderEl.querySelector('.cv-subheader-epochs');
        const sel = subheaderEpochSelect;
        if (!sel || !sel.options.length) { box.hidden = true; return; }
        box.hidden = false;
        const num = box.querySelector('.cv-ep-num');
        const epoch = Number(sel.value);
        box.querySelector('.cv-ep-val').textContent = isFinite(epoch) ? String(epoch) : sel.value;
        // Green for the latest epoch, yellow for a historical one.
        const isLatest = epoch === Number(latestEpochNumber);
        num.classList.toggle('is-latest', isLatest);
        num.classList.toggle('is-past', !isLatest);
        box.querySelector('[data-ep="older"]').disabled = sel.selectedIndex >= sel.options.length - 1;
        box.querySelector('[data-ep="newer"]').disabled = sel.selectedIndex <= 0;
        box.querySelector('[data-ep="latest"]').disabled = sel.selectedIndex <= 0;
        // The picker over the number mirrors the view's own epoch selector.
        const pick = box.querySelector('.cv-ep-select');
        if (pick.__cvFor !== sel || pick.options.length !== sel.options.length ||
            (pick.options.length && pick.options[0].value !== sel.options[0].value)) {
            pick.innerHTML = sel.innerHTML;
            pick.__cvFor = sel;
        }
        pick.value = sel.value;
        // Latest epoch: how far it is and how fresh the data is. Any other
        // epoch: a "past epoch" mark. The exact snapshot time is in the tooltip.
        const meta = box.querySelector('.cv-ep-meta');
        const entry = epochMap.get(epoch);
        const md = entry && entry.metadata ? entry.metadata : null;
        const pct = md && md.epoch_completed_percent !== undefined && md.epoch_completed_percent !== null &&
            isFinite(Number(md.epoch_completed_percent)) ? Number(md.epoch_completed_percent) : null;
        let snap = '';
        if (md && md.timestamp_utc && isFinite(Date.parse(md.timestamp_utc))) {
            try {
                const f = formatLocalSnapshot(md.timestamp_utc);
                snap = f.dt + ' ' + f.tzShort;
            } catch (_) {
                snap = '';
            }
        }
        if (isLatest) {
            const ago = md && md.timestamp_utc ? subheaderAgoText(md.timestamp_utc) : '';
            meta.innerHTML = (pct !== null ? '<span class="cv-ep-pct">' + Math.floor(pct) + '%</span>' : '') +
                (ago ? '<span class="cv-ep-ago">' + (pct !== null ? ' &middot; ' : '') + ago + '</span>' : '');
            subheaderTip(meta, 'Epoch ' + epoch + (pct !== null ? ' is ' + pct.toFixed(2) + '% complete' : '') +
                (snap ? '\nData snapshot: ' + snap : ''), true);
            subheaderTip(num, 'Latest epoch\nClick to choose another epoch');
        } else {
            meta.innerHTML = '<span class="cv-ep-past">past epoch</span>';
            subheaderTip(meta, 'Epoch ' + epoch + ', a past epoch' +
                (pct !== null ? '\nSnapshot taken at ' + pct.toFixed(2) + '% of the epoch' : '') +
                (snap ? '\n' + snap : ''), true);
            subheaderTip(num, 'Past epoch\nClick to choose another epoch');
        }
        meta.hidden = !meta.innerHTML;
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
        subheaderEl.innerHTML = '<div class="cv-subheader-inner">' +
            '<a class="cv-sub-crumb" hidden><span class="cv-sub-crumb-logo"></span><span class="cv-sub-crumb-title"></span></a>' +
            '<span class="cv-sub-sep" hidden aria-hidden="true"><i class="fas fa-chevron-right"></i></span>' +
            '<span class="cv-subheader-logo"></span>' +
            '<span class="cv-subheader-text"><span class="cv-subheader-kind"></span><span class="cv-subheader-title"></span></span>' +
            '<span class="cv-subheader-epochs" hidden>' +
            '<button type="button" class="cv-ep-btn" data-ep="older" aria-label="Previous epoch"><i class="fas fa-chevron-left" aria-hidden="true"></i></button>' +
            '<span class="cv-ep-num"><span class="cv-ep-val"></span><i class="fas fa-caret-down cv-ep-caret" aria-hidden="true"></i>' +
            '<select class="cv-ep-select" aria-label="Choose an epoch"></select></span>' +
            '<button type="button" class="cv-ep-btn" data-ep="newer" aria-label="Next epoch"><i class="fas fa-chevron-right" aria-hidden="true"></i></button>' +
            '<button type="button" class="cv-ep-btn" data-ep="latest" aria-label="Latest epoch"><i class="fas fa-angles-right" aria-hidden="true"></i></button>' +
            '<span class="cv-ep-meta" hidden></span>' +
            '</span>' +
            '<button type="button" class="cv-ep-btn cv-subheader-top" aria-label="Back to the top"><i class="fas fa-arrow-up" aria-hidden="true"></i></button></div>';
        subheaderTip(subheaderEl.querySelector('[data-ep="older"]'), 'Previous epoch');
        subheaderTip(subheaderEl.querySelector('[data-ep="newer"]'), 'Next epoch');
        subheaderTip(subheaderEl.querySelector('[data-ep="latest"]'), 'Latest epoch');
        subheaderTip(subheaderEl.querySelector('.cv-subheader-top'), 'Back to the top');
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
        // The epoch number is a picker: any epoch of the view in one click.
        const pick = subheaderEl.querySelector('.cv-ep-select');
        // The tooltip gives way to the open list.
        pick.addEventListener('mousedown', () => {
            cvTipTarget = null;
            if (window.hidePoolTooltip) window.hidePoolTooltip();
        });
        pick.addEventListener('change', () => {
            const sel = subheaderEpochSelect;
            if (!sel || sel.value === pick.value) return;
            sel.value = pick.value;
            sel.dispatchEvent(new Event('change'));
            subheaderSyncEpoch();
        });
        // The way back from a pool or a validator page to its list: a link
        // (a new tab, "copy link address") that a plain click turns into the
        // in-page route. The hidden breadcrumb still owns that route: the
        // main view, the tab, and a scroll to the tab bar.
        subheaderEl.querySelector('.cv-sub-crumb').addEventListener('click', (e) => {
            if (!cvPlainClick(e)) return;
            e.preventDefault();
            const crumb = document.getElementById('breadcrumb-section');
            if (!crumb) return;
            crumb.dataset.tab = e.currentTarget.getAttribute('data-tab') || 'pools';
            crumb.click();
        });
        // "updated N min ago" keeps counting while the page stays open.
        setInterval(() => { if (subheaderEpochSelect) subheaderSyncEpoch(); }, 30000);
        const anchor = document.getElementById('cv-staleness-banner') || document.querySelector('header');
        if (anchor && anchor.parentNode) anchor.insertAdjacentElement('afterend', subheaderEl);
        else document.body.insertBefore(subheaderEl, document.body.firstChild);
        window.addEventListener('resize', subheaderPlace);
        requestAnimationFrame(subheaderPlace);
        return subheaderEl;
    }

    // kind: "Pool" or "Validator" on their pages (empty for tabs), title,
    // logoHtml: a logo circle, syncImg: an on-page logo whose resolved src the
    // bar mirrors (light/dark variants are resolved there), epochSelect: the
    // view's epoch <select>, or null for no epoch steps.
    function subheaderSet(kind, title, logoHtml, syncImg, epochSelect) {
        const el = subheaderEnsure();
        // On a pool or a validator page the bar starts with the way back to
        // the list (its kit piece and name), so the small label is not needed.
        const crumbTab = kind === 'Pool' ? 'pools' : (kind === 'Validator' ? 'validators' : null);
        const crumb = el.querySelector('.cv-sub-crumb');
        const sep = el.querySelector('.cv-sub-sep');
        crumb.hidden = !crumbTab;
        sep.hidden = !crumbTab;
        if (crumbTab) {
            const t = SUBHEADER_TABS[crumbTab];
            crumb.setAttribute('data-tab', crumbTab);
            crumb.setAttribute('href', tabHref(crumbTab));
            subheaderTip(crumb, 'Back to ' + t.title);
            crumb.setAttribute('aria-label', 'Back to ' + t.title);
            crumb.querySelector('.cv-sub-crumb-logo').innerHTML = kitLogoHtml(t.kit);
            crumb.querySelector('.cv-sub-crumb-title').textContent = t.title;
        }
        const kindEl = el.querySelector('.cv-subheader-kind');
        kindEl.textContent = kind || '';
        kindEl.hidden = !kind || !!crumbTab;
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
        if (left + tr.width > cvWindowWidth() - PAD) left = cvWindowWidth() - tr.width - PAD;
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

    // A row of a pool page shows who else stakes with the validator: up to
    // five places (five small logos, or four and "+N"), largest first.
    const POOL_ROW_OTHERS = 5;
    function poolRowOthers(v) {
        return (v.groups || [])
            .filter(g => g.name !== currentPoolGroup && meetsStakeThreshold(g.active_lamports, g.activating_lamports))
            .sort((x, y) => (y.active_lamports - x.active_lamports) || (y.activating_lamports - x.activating_lamports));
    }
    // Tooltip of one of those logos (the staker and its amounts) or of "+N"
    // (the stakers that did not get a place).
    function showAlsoTip(el) {
        const box = el.closest('[data-vote]');
        const vote = box ? box.getAttribute('data-vote') : '';
        const v = poolValidators.find(x => x.info && x.info.vote_pubkey === vote);
        if (!v) return;
        const others = poolRowOthers(v);
        const total = (v.totals && v.totals.total_active_lamports) || 0;
        const named = g => { const def = cvSourceDef(g.name); return { name: g.name, def, title: cvSourceTitle(g.name, def) }; };
        const share = g => (total > 0 && g.active_lamports > 0) ? shareText(g.active_lamports / total * 100) : '';
        const sel = document.getElementById('pool-epoch-select');
        const epochLine = (sel && sel.value && Number(sel.value) !== Number(latestEpochNumber))
            ? '<div class="pool-tooltip-epoch">Epoch ' + escapeHtml(String(sel.value)) + '</div>' : '';
        const exact = lamports => formatNumber(lamportsToSol(lamports || 0), 2) + ' SOL';
        const which = el.getAttribute('data-cv-also');
        if (which === 'more') {
            const rest = others.slice(POOL_ROW_OTHERS - 1);
            if (!rest.length) return;
            const LIMIT = 12;
            cvShowTipHtml(el, '<div class="pool-tooltip-title">Also staked by</div>' + epochLine + rest.slice(0, LIMIT).map(g => {
                const n = named(g);
                return cvTipRow(cvSourceLogoMini(n), n.title, formatCompact(lamportsToSol(g.active_lamports)) + ' SOL' +
                    (share(g) ? '<span class="cv-tip-dim">' + share(g) + '</span>' : ''));
            }).join('') + (rest.length > LIMIT ? '<div class="cv-flow-more">and ' + (rest.length - LIMIT) + ' more</div>' : ''));
            return;
        }
        const g = others[Number(which)];
        if (!g) return;
        const n = named(g);
        cvShowTipHtml(el, '<div class="pool-tooltip-title cv-tip-pool">' + cvSourceLogoMini(n) + '<span>' + escapeHtml(n.title) + '</span></div>' + epochLine +
            cvTipRow(cvTipIco('active-stake'), 'Active stake', exact(g.active_lamports)) +
            (share(g) ? cvTipRow(cvTipIco('share'), 'Share of validator', share(g)) : '') +
            ((g.activating_lamports || 0) >= MIN_ACTIVE_STAKE ? cvTipRow(cvTipIco('activating'), 'Activating', '+' + exact(g.activating_lamports), 'is-up') : '') +
            ((g.deactivating_lamports || 0) >= MIN_ACTIVE_STAKE ? cvTipRow(cvTipIco('deactivating'), 'Deactivating', '-' + exact(g.deactivating_lamports), 'is-down') : ''));
    }

    document.addEventListener('mouseover', (e) => {
        const el = e.target && e.target.closest ? e.target.closest('[data-cv-tip],[data-cv-flow],[data-cv-vdtip],[data-cv-rich],[data-cv-also],[data-cv-pbub],[data-cv-summit]') : null;
        if (!el || el === cvTipTarget) return;
        // On a touch screen a tap on a link or a button is its action: its
        // plain tooltip stays closed (it would be left on screen after the tap).
        if (!CV_CAN_HOVER && el.hasAttribute('data-cv-tip') && el.matches('a, button')) return;
        // (in the narrow table of stakers the name opens the details of its
        // row, not the page of the staker: its "Opens the page" tooltip stays closed)
        if (el.matches('a.cv-vd-src-name') && CV_NARROW_TABLE && CV_NARROW_TABLE.matches) return;
        cvTipTarget = el;
        if (cvPinnedTip && cvPinnedTip.__card === el) return;
        if (el.hasAttribute('data-cv-rich')) showCvRichTip(el);
        else if (el.hasAttribute('data-cv-pbub')) showPoolBubTip(el);
        else if (el.hasAttribute('data-cv-summit')) showSummitTip(el);
        else if (el.hasAttribute('data-cv-also')) showAlsoTip(el);
        else if (el.hasAttribute('data-cv-vdtip')) showCvVdTip(el);
        else if (el.hasAttribute('data-cv-flow')) showFlowTip(el);
        else showCvTip(el);
    });
    document.addEventListener('mouseout', (e) => {
        if (!cvTipTarget) return;
        const from = e.target && e.target.closest ? e.target.closest('[data-cv-tip],[data-cv-flow],[data-cv-vdtip],[data-cv-rich],[data-cv-also],[data-cv-pbub],[data-cv-summit]') : null;
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
            // A control with data-cv-copied says what was copied in the tooltip for a moment.
            const said = ok ? el.getAttribute('data-cv-copied') : '';
            let note = null;
            if (said) {
                const was = el.getAttribute('data-cv-tip');
                el.setAttribute('data-cv-tip', said);
                showCvTip(el);
                note = document.getElementById('dynamic-pool-tooltip');
                if (was === null) el.removeAttribute('data-cv-tip'); else el.setAttribute('data-cv-tip', was);
            }
            el._cvCopyTimer = setTimeout(() => {
                el.classList.remove('is-copied', 'is-copy-failed');
                // (the note closes itself only: a tooltip opened since - the
                // pointer went on to another element - is not its to close)
                if (note && note.isConnected && note.id === 'dynamic-pool-tooltip' && window.hidePoolTooltip) { cvTipTarget = null; window.hidePoolTooltip(); }
            }, 1400);
        });
    }, true);

    // ============================================
    // POOL BADGE HTML BUILDERS
    // ============================================
    // The ring of a pool bubble: green = activating, red = deactivating,
    // split = both at once (share = the activating part, %), dashed = the
    // whole stake is arriving (activating only) or leaving (all the active
    // stake is deactivating). Amounts under 0.1 SOL do not count.
    function poolBadgeRing(pActive, pAct, pDeact) {
        const activatingOnly = pActive < MIN_ACTIVE_STAKE && pAct >= MIN_ACTIVE_STAKE;
        const hasAct = pAct >= MIN_ACTIVE_STAKE;
        const hasDeact = pDeact >= MIN_ACTIVE_STAKE;
        let cls = '';
        if (activatingOnly) cls = ' is-activating-only';
        else if (hasAct && hasDeact) cls = ' is-activating is-deactivating';
        else if (hasAct) cls = ' is-activating';
        else if (hasDeact && pDeact >= pActive) cls = ' is-exiting';
        else if (hasDeact) cls = ' is-deactivating';
        return { cls, activatingOnly, share: (hasAct && hasDeact) ? Math.round(Math.min(92, Math.max(8, pAct / (pAct + pDeact) * 100))) : null };
    }
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
        const ring = poolBadgeRing(pActive, pAct, pool.deactivating_lamports || 0);
        const movementClass = ring.cls;
        const movementStyle = ring.share === null ? '' : ' style="--act-share:' + ring.share + '%"';
        const activeStakeFormatted = ring.activatingOnly
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
							<span class="label">${cvTipIco('active-stake', true)}Active</span>
							<span class="value">${formatNumber(lamportsToSol(pool.active_lamports), 2)} SOL</span>
						</div>
						${pool.activating_lamports > 0 ? `
						<div class="pool-tooltip-stat activating">
							<span class="label">${cvTipIco('activating', true)}Activating</span>
							<span class="value">${formatNumber(lamportsToSol(pool.activating_lamports), 2)} SOL</span>
						</div>` : ''}
						${pool.deactivating_lamports > 0 ? `
						<div class="pool-tooltip-stat deactivating">
							<span class="label">${cvTipIco('deactivating', true)}Deactivating</span>
							<span class="value">${formatNumber(lamportsToSol(pool.deactivating_lamports), 2)} SOL</span>
						</div>` : ''}
						${pool.count > 0 ? `
						<div class="pool-tooltip-stat accounts">
							<span class="label">${cvTipIco('stake-accounts', true)}Stake accounts</span>
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
			// The stake on the move stands under the total stake, in a line of its own.
			const flowChip = (kind, lamports) => lamports > 0
				? '<div class="stake-stat ' + kind + '" data-cv-flow="' + kind + '" data-vote="' + escapeHtml(votePubkey) + '">' + cardIco(kind) +
				  '<span class="value">' + formatCompact(lamportsToSol(lamports)) + '</span></div>'
				: '';
			const flowsHtml = flowChip('activating', validator.totals?.total_activating_lamports || 0) +
				flowChip('deactivating', validator.totals?.total_deactivating_lamports || 0);
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
							<div class="validator-name cv-name-line">
								<a class="cv-name-text cv-vlink" data-cv-nav href="${vHref}" data-cv-tip="${nameHtml}" data-cv-tip-when="clipped"><span class="cv-name-run">${nameHtml}${CV_GO_SVG}</span></a>
								${realName ? copyButtonHtml(rawName, 'Copy name') : ''}
							</div>
							${isStaleView ? cvGoneBadgeHtml(votePubkey) : ''}${nameHit ? `<div class="cv-formerly">${nameHit.label} <b>${escapeHtml(nameHit.name)}</b></div>` : ''}
						</div>
						<div class="cv-chipline">${validatorKeySignsHtml(identityPubkey, votePubkey)}${cvListMetaHtml(validator)}</div>
					</div>
					<div class="validator-stake-stats">
						<div class="stake-stat active" data-cv-flow="active" data-vote="${escapeHtml(votePubkey)}">
							${cardIco('active-stake')}
							<span class="value">${formatCompact(lamportsToSol(validator.totals?.total_active_lamports || 0))}</span>
						</div>
						${flowsHtml ? '<div class="stake-flows">' + flowsHtml + '</div>' : ''}
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
			<div class="cv-sortbar" id="validators-sort-bar"></div>
			<div id="validators-list-items-container"></div>
		`;
		
		// ⭐ ВИКЛИКАЄМО НОВІ ФУНКЦІЇ
		updateSortButtons(isStale, epochNum);
		updateValidatorStats(isStale, epochNum);
		renderValidatorsListItems();
	}
// ⭐ НОВА ФУНКЦІЯ ДЛЯ ОНОВЛЕННЯ КНОПОК СОРТУВАННЯ
    function updateSortButtons(isStale = false, epochNum = null) {
        const sortBar = document.getElementById('validators-sort-bar');
        if (!sortBar) return;

        const pastEpochBadge = isStale ? `
        <span class="validators-sort-badge">
            <i class="fas fa-hourglass-half"></i> Past Epoch: ${epochNum}
        </span>` : '';

        // Ages come from the snapshot (epoch 1043 and later) or, for older epochs, from the validators index.
        validatorsListEpoch = Number((document.getElementById('epoch-select') || {}).value);
        validatorsHasAge = validatorsData.some(v => v.meta && typeof v.meta.validator_age === 'number') || !!cvIndexByVote;
        if (isStale) cvEnsureIndexForList();
        const item = (mode, icon, label, dir) => ({ attr: ' onclick="window.changeValidatorSort(\'' + mode + '\')"', icon, label,
            active: validatorsSortMode === mode, dir });
        const items = [item('active-stake', 'fa-coins', 'Stake', true), item('activating', 'fa-arrow-trend-up', 'Activating', true),
            item('deactivating', 'fa-arrow-trend-down', 'Deactivating', true), item('age', 'fa-hourglass-half', 'Age', true)];
        // A search for pools brings its own order: the validators with the most stake from those pools go first.
        if (isPoolSearchMode && poolSortOrder.length > 0) {
            const isDarkSortBtn = document.body.classList.contains('dark-theme-body');
            const poolIconsHtml = poolSortOrder.map(poolName => {
                const poolDef = latestPoolDefinitions.find(d => d.group === poolName);
                if (poolDef && poolDef.image) {
                    const resolvedSortBtn = resolveLogoUrlSync(poolDef.image, isDarkSortBtn);
                    return `<img src="${resolvedSortBtn}" data-logo-default="${poolDef.image}" class="sort-pool-icon" alt="" data-cv-tip="${escapeHtml(poolName)}">`;
                }
                return `<span class="sort-pool-icon-initials" data-cv-tip="${escapeHtml(poolName)}">${getInitials(poolName)}</span>`;
            }).join('');
            items.push(item('pool-specific', 'fa-layer-group', 'Pools (beta)' + poolIconsHtml, false));
        }
        sortBarRender(sortBar, items, validatorsSortAsc ? 'asc' : 'desc', pastEpochBadge);
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
                    validatorsSortAsc = false;
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
        // A second click on a measure flips its direction.
        validatorsSortAsc = (mode === validatorsSortMode && mode !== 'pool-specific') ? !validatorsSortAsc : false;
        if (mode === 'age' && !cvIndexData) cvEnsureIndexForList();
        validatorsSortMode = mode;
        sortValidators();

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
    // opts (all optional) fit the chart to another measure without changing
    // how it looks or behaves:
    //   variant   - data-chart-variant on the container (its colours are in the CSS)
    //   gradId    - id of this chart's own fill gradient (a variant needs its own)
    //   fmt       - formatter of the values in the two labels under the chart
    //   tip       - (point) => text of the hover tooltip after "Epoch N:"
    //   labels    - (data) => [leftHtml, rightHtml] instead of the first and last epoch
    //   butterfly - two series on one scale: value rises from the middle line, down falls from it
    function renderInteractiveChart(container, data, title = 'Active Stake', highlightEpoch = null, opts = null) {
        if (!container || !data || data.length === 0) {
            if (container) container.style.display = 'none';
            return;
        }

        container.style.display = 'block';
        const o = opts || {};
        const formatValue = o.fmt || ((val) => {
            if (val >= 1_000_000) return `${(val/1_000_000).toFixed(2)}M`;
            if (val >= 1_000) return `${(val/1_000).toFixed(1)}K`;
            return val.toFixed(0);
        });
        const tipText = o.tip || ((p) => `${new Intl.NumberFormat('en-US').format(p.value)} SOL`);
        const gradId = o.gradId || 'sparkline-gradient';
        if (o.variant) container.setAttribute('data-chart-variant', o.variant);
        else container.removeAttribute('data-chart-variant');

        // What this container shows. While it is out of sight (no width) a
        // single observer waits and draws the latest plan once it appears.
        container.__cvPlan = { data, title, highlightEpoch, opts };
        const width = container.clientWidth;
        if (width === 0) {
            if (!container.__cvWait && 'ResizeObserver' in window) {
                const ro = new ResizeObserver((entries) => {
                    if (!(entries[0] && entries[0].contentRect.width > 0)) return;
                    ro.disconnect();
                    container.__cvWait = null;
                    const plan = container.__cvPlan;
                    if (plan) renderInteractiveChart(container, plan.data, plan.title, plan.highlightEpoch, plan.opts);
                });
                container.__cvWait = ro;
                ro.observe(container);
            }
            return;
        }
        container.__cvDrawnWidth = width;

        const height = 60, PADDING = 5;
        const butterfly = !!o.butterfly && data.length > 1;
        const FLOW_UP = '#14F195', FLOW_DOWN = '#FF6B6B';
        // Positions of the points on the chart.
        const toPoints = () => {
            if (butterfly) {
                const mid = height / 2;
                const top = Math.max(1e-9, ...data.map(d => Math.max(d.value || 0, d.down || 0)));
                return data.map((d, i) => ({
                    x: (i / (data.length - 1 || 1)) * width,
                    y: mid - ((d.value || 0) / top) * (mid - PADDING),
                    y2: mid + ((d.down || 0) / top) * (mid - PADDING),
                    epoch: d.epoch, value: d.value, down: d.down
                }));
            }
            const values = data.map(d => d.value);
            const minVal = Math.min(...values);
            const maxVal = Math.max(...values);
            const range = maxVal - minVal === 0 ? 1 : maxVal - minVal;
            return data.map((d, i) => ({
                x: (i / (data.length - 1 || 1)) * width,
                y: height - PADDING - ((d.value - minVal) / range) * (height - 2 * PADDING),
                epoch: d.epoch, value: d.value
            }));
        };

        if (data.length === 1) {
            // A single point: a dot on a baseline.
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
            tooltip.innerHTML = `<span class="epoch">Epoch ${data[0].epoch}:</span> ${tipText({ epoch: data[0].epoch, value: data[0].value })}`;
        } else {
            const points = toPoints();

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

            const lineOf = (key) => points.map(p => `${p.x.toFixed(2)},${p[key].toFixed(2)}`).join(' L ');
            const x0 = points[0].x.toFixed(2), x1 = points[points.length - 1].x.toFixed(2);
            const pathLineData = lineOf('y');
            const baseY = butterfly ? height / 2 : height;
            const pathFillData = `M ${x0},${baseY} L ${pathLineData} L ${x1},${baseY} Z`;
            const labels = o.labels ? o.labels(data) : [
                `${data[0].epoch}: <span class="value">${formatValue(data[0].value)}</span>`,
                `${data[data.length - 1].epoch}: <span class="value">${formatValue(data[data.length - 1].value)}</span>`
            ];
            const defs = butterfly
                ? `<linearGradient id="${gradId}-up" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="rgba(20, 241, 149, 0.35)" />
                            <stop offset="100%" stop-color="rgba(20, 241, 149, 0)" />
                        </linearGradient>
                        <linearGradient id="${gradId}-down" x1="0" y1="1" x2="0" y2="0">
                            <stop offset="0%" stop-color="rgba(255, 107, 107, 0.35)" />
                            <stop offset="100%" stop-color="rgba(255, 107, 107, 0)" />
                        </linearGradient>`
                : `<linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stop-color="var(--sparkline-gradient-start)" />
                            <stop offset="100%" stop-color="var(--sparkline-gradient-end)" />
                        </linearGradient>`;
            const fillStyle = gradId === 'sparkline-gradient' ? '' : ` style="fill: url(#${gradId});"`;
            const paths = butterfly
                ? `<path d="${pathFillData}" class="chart-path-fill" style="fill: url(#${gradId}-up);" />
                    <path d="M ${x0},${baseY} L ${lineOf('y2')} L ${x1},${baseY} Z" class="chart-path-fill" style="fill: url(#${gradId}-down);" />
                    <path d="M ${pathLineData}" class="chart-path-line" style="stroke: ${FLOW_UP};" />
                    <path d="M ${lineOf('y2')}" class="chart-path-line" style="stroke: ${FLOW_DOWN};" />`
                : `<path d="${pathFillData}" class="chart-path-fill"${fillStyle} />
                    <path d="M ${pathLineData}" class="chart-path-line" />`;

            container.innerHTML = `
                ${title ? `<div class="chart-title">${title}</div>` : ''}
                <div class="chart-tooltip" style="display: none;"></div>
                <svg viewBox="0 0 ${width} ${height}" style="overflow: visible; cursor: pointer;">
                    <defs>
                        ${defs}
                    </defs>
                    ${paths}
                    ${marker ? `<line class="selected-epoch-line" x1="${marker.x}" x2="${marker.x}" y1="0" y2="${height}"></line>` : ''}
                    ${marker ? `<circle class="selected-epoch-dot" cx="${marker.x}" cy="${marker.y}" r="4.5"></circle>`: ''}
                    ${marker && butterfly ? `<circle class="selected-epoch-dot" cx="${marker.x}" cy="${marker.y2}" r="4.5"></circle>`: ''}
                    <line class="tracker-line-svg" x1="-999" x2="-999" y1="0" y2="${height}"></line>
                    <circle class="tracker-dot-svg" cx="-999" cy="-999" r="4.5"${butterfly ? ` style="fill: ${FLOW_UP};"` : ''}></circle>
                    ${butterfly ? `<circle class="tracker-dot-svg" cx="-999" cy="-999" r="4.5" style="fill: ${FLOW_DOWN};"></circle>` : ''}
                </svg>
                <div class="chart-range-labels">
                    <span>${labels[0]}</span>
                    <span>${labels[1]}</span>
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

                const chartCenter = width / 2;
                const maxOffset = 12;
                const distanceFromCenter = marker.x - chartCenter;
                const offsetRatio = distanceFromCenter / chartCenter;
                const finalOffset = -offsetRatio * maxOffset;
                // The badge stands over its epoch, a little toward the middle,
                // and never reaches out of the chart at either edge.
                const half = badge.offsetWidth / 2;
                const centre = Math.min(Math.max(marker.x + finalOffset, half), Math.max(half, width - half));
                badge.style.left = `${centre.toFixed(2)}px`;

                badge.style.visibility = 'visible';
            }

            container.querySelectorAll('.chart-path-line').forEach((line) => {
                const length = line.getTotalLength();
                line.style.strokeDasharray = length;
                line.style.strokeDashoffset = length;
            });
        }

        // Hover and click.
        const svg = container.querySelector('svg');
        if (!svg) return;

        const points = toPoints();
        const tooltip = container.querySelector('.chart-tooltip');
        const trackerLine = container.querySelector('.tracker-line-svg');
        const trackerDots = container.querySelectorAll('.tracker-dot-svg');
        const nearest = (clientX) => {
            const rect = svg.getBoundingClientRect();
            const mouseX = clientX - rect.left;
            let closestIndex = 0, minDistance = Infinity;
            points.forEach((p, i) => {
                const d = Math.abs(p.x - mouseX);
                if (d < minDistance) {
                    minDistance = d;
                    closestIndex = i;
                }
            });
            return points[closestIndex];
        };

        svg.addEventListener('mousemove', (e) => {
            const point = nearest(e.clientX);
            if (point) {
                tooltip.style.display = '';
                tooltip.innerHTML = `<span class="epoch">Epoch ${point.epoch}:</span> ${tipText(point)}`;
                // (inside the chart: see cvChartTipLeft)
                tooltip.style.left = `${cvChartTipLeft(tooltip, point.x, width)}px`;
                tooltip.style.top = `${point.y}px`;
                trackerLine.setAttribute('x1', point.x);
                trackerLine.setAttribute('x2', point.x);
                trackerDots[0].setAttribute('cx', point.x);
                trackerDots[0].setAttribute('cy', point.y);
                if (trackerDots[1]) {
                    trackerDots[1].setAttribute('cx', point.x);
                    trackerDots[1].setAttribute('cy', point.y2);
                }
            }
        });

        // The tracker and the tooltip belong to the chart itself: over the
        // title or the labels of the block they stay out of sight.
        if (data.length > 1) {
            svg.addEventListener('mouseleave', () => {
                tooltip.style.display = 'none';
                trackerLine.setAttribute('x1', -999);
                trackerLine.setAttribute('x2', -999);
                trackerDots.forEach((dot) => { dot.setAttribute('cx', -999); dot.setAttribute('cy', -999); });
            });
        }

        svg.addEventListener('click', (e) => {
            const point = nearest(e.clientX);
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
    
    // Defaults stay out of the address: a plain visit keeps the bare URL,
    // a parameter shows up only when the visitor changes something.
    const URL_DEFAULTS = { tab: 'pools', sort: 'category', epoch: 'latest' };
    function setUrlState({tab, sort, epoch, search}) {
        const url = new URL(window.location);
        const put = (key, value) => {
            if (value && value !== URL_DEFAULTS[key]) url.searchParams.set(key, value);
            else url.searchParams.delete(key);
        };
        put('tab', tab);
        put('sort', sort);
        put('epoch', epoch);
        put('search', search);
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
    // What the tooltip of the mountain tells ("View from the top"): the
    // epoch on screen, how many validators - counted from the largest one
    // down - hold more than a third and more than a half of its active
    // stake, the highest total on record and the first one of the history.
    // (A third is the share that can stop the network: the fewer validators
    // hold it, the less the stake is spread.)
    let cvSummit = null;
    function cvSummitFacts(data, totalLamports, series, isPast) {
        const real = !data.__aggregated && Array.isArray(data.validators);
        const stakes = real ? data.validators.map(v => (v && v.totals && v.totals.total_active_lamports) || 0)
            .filter(x => x > 0).sort((a, b) => b - a) : [];
        const holders = (part) => {
            let sum = 0;
            for (let i = 0; i < stakes.length; i++) {
                sum += stakes[i];
                if (sum > totalLamports * part) return i + 1;
            }
            return 0;
        };
        const has = Array.isArray(series) && series.length > 1;
        return {
            epoch: data.metadata ? data.metadata.epoch : null,
            isPast: !!isPast,
            total: lamportsToSol(totalLamports),
            third: totalLamports > 0 ? holders(1 / 3) : 0,
            half: totalLamports > 0 ? holders(1 / 2) : 0,
            high: has ? series.reduce((a, p) => (p.value > a.value ? p : a), series[0]) : null,
            first: has ? series.reduce((a, p) => (Number(p.epoch) < Number(a.epoch) ? p : a), series[0]) : null
        };
    }
    function showSummitTip(el) {
        const s = cvSummit;
        if (!s) return;
        const count = n => formatNumber(n) + (n === 1 ? ' validator' : ' validators');
        let html = '<div class="pool-tooltip-title cv-tip-pool"><img class="cv-tip-ico cv-tip-summit" src="/brand/decor/alpine-tile.webp" alt="" aria-hidden="true">' +
            '<span>View from the top</span></div>' +
            (s.isPast && s.epoch !== null ? '<div class="pool-tooltip-epoch">Epoch ' + escapeHtml(String(s.epoch)) + '</div>' : '');
        if (s.third > 0) {
            html += cvTipRow(cvTipIco('stake-rank'), 'A third of the stake', count(s.third)) +
                cvTipRow(cvTipIco('validators'), 'Half of the stake', count(s.half));
        }
        if (s.high) html += cvTipRow(cvTipIco('peak-stake'), 'Peak in epoch ' + escapeHtml(String(s.high.epoch)), shortSol(s.high.value) + ' SOL');
        if (s.first && Number(s.first.epoch) !== Number(s.epoch)) {
            const climb = s.total - s.first.value;
            html += cvTipRow(cvTipIco('change'), 'Since epoch ' + escapeHtml(String(s.first.epoch)),
                (climb >= 0 ? '+' : '-') + shortSol(Math.abs(climb)) + ' SOL');
        }
        if (s.third > 0) html += '<div class="cv-flow-more">Validators are counted from the largest one down.</div>';
        cvShowTipHtml(el, html);
    }
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
        
        cvNetworkActive = totalStake;
        cvSummit = cvSummitFacts(data, totalStake, historicStakeData, isStale);
        const epochNote = isStale ? `<span class="epoch-inline-note">in epoch ${metadata.epoch}</span>` : '';
        // Two charts side by side: the total active stake, and the number of
        // validators or the stake in motion (the switch is that chart's title).
        const net2 = historicStakeData ? cvNetSeries() : [];
        const summaryChartHtml = historicStakeData ?
            `<div class="cv-net-charts${net2.length > 1 ? '' : ' is-single'}">
                <div class="summary-chart-wrapper">
                    <div class="interactive-chart-container" id="summary-chart-container"></div>
                </div>
                ${net2.length > 1 ? `<div class="summary-chart-wrapper">
                    <div class="interactive-chart-container" id="${NET2_ID}"></div>
                </div>` : ''}
            </div>` : '';
        
        const cardValue = (lamports) => numPairHtml(lamportsToSol(lamports), 2);
        const cardTip = (label, lamports) => shortTipAttr(label, lamportsToSol(lamports));
        document.getElementById('summary-container').innerHTML = `
            <div class="sp-summary-card total-stake-card">
                <span class="title"><span class="cv-hero-mark" data-cv-summit="1"><img class="cv-hero-tile" src="/brand/decor/alpine-tile.webp" alt="" width="320" height="263" decoding="async" draggable="false"></span>Solana Mainnet Stake</span>
                ${summaryChartHtml}
                <div class="total-stake-grid">
                    <div class="total-stake-item"${cardTip('Total active stake', totalStake)}>
                        ${cardIco('active-stake')}
                        <div class="stake-info">
                            <span class="value">${cardValue(totalStake)}</span>
                            <span class="label">Total Active Stake${epochNote}</span>
                        </div>
                    </div>
                    <div class="total-stake-item"${cardTip('Activating', activatingStake)}>
                        ${cardIco('activating')}
                        <div class="stake-info">
                            <span class="value">${cardValue(activatingStake)}</span>
                            <span class="label">Activating${epochNote}</span>
                        </div>
                    </div>
                    <div class="total-stake-item"${cardTip('Deactivating', deactivatingStake)}>
                        ${cardIco('deactivating')}
                        <div class="stake-info">
                            <span class="value">${cardValue(deactivatingStake)}</span>
                            <span class="label">Deactivating${epochNote}</span>
                        </div>
                    </div>
                    <div class="total-stake-item">
                        ${cardIco('validators')}
                        <div class="stake-info">
                            <span class="value">${validators.length}</span>
                            <span class="label">Validators${epochNote}</span>
                        </div>
                    </div>
                </div>
            </div>`;
            
        if (historicStakeData) {
            // The first chart looks like the one next to it: its title is a
            // chip (one option, always on) and its labels name the two extremes.
            const low = historicStakeData.reduce((a, p) => (p.value < a.value ? p : a), historicStakeData[0]);
            const high = historicStakeData.reduce((a, p) => (p.value > a.value ? p : a), historicStakeData[0]);
            chartsToRedraw.push({
                id: 'summary-chart-container',
                data: historicStakeData,
                title: '<span class="cv-vd-toggle cv-vd-toggle-sm"><span class="cv-vd-chip">Total active stake</span></span>',
                highlightEpoch,
                opts: { labels: () => cvChartInOrder([low.epoch, cvChartSide('Min', shortSol(low.value), low.epoch)], [high.epoch, cvChartSide('Max', shortSol(high.value), high.epoch)]) }
            });
            if (net2.length > 1) {
                cvNet2Last = { points: net2, highlightEpoch };
                chartsToRedraw.push(cvNet2Entry());
            }
        }
    }

    // ---------- main page: the second chart ----------
    // Per epoch: the number of validators, and the stake activating and
    // deactivating across the network. A light epoch entry carries the
    // figures in __net; a full snapshot is summed here. The chart is drawn by
    // renderInteractiveChart, like the chart next to it, so the two behave
    // as one (drawing, the selected epoch, resizing).
    const NET2_ID = 'cv-net2-chart';
    let cvNet2Mode = 'validators';
    let cvNet2Last = null;
    // One label under a main chart: its name (a shorter one for phones), the
    // value, and a pill that opens that epoch.
    function cvChartSide(label, value, epoch, shortLabel) {
        return '<span class="cv-side-name">' + label + ':</span>' + (shortLabel ? '<span class="cv-side-short">' + shortLabel + ':</span>' : '') +
            '<span class="value">' + value + '</span><button type="button" class="cv-chart-ep" data-cv-main-epoch="' +
            epoch + '" data-cv-tip="Open epoch ' + epoch + '">' + epoch + '</button>';
    }
    // Two labels in the order of their epochs: the earlier one on the left, like the line above them.
    function cvChartInOrder(a, b) {
        return a[0] <= b[0] ? [a[1], b[1]] : [b[1], a[1]];
    }
    function cvNetSeries() {
        const out = [];
        (allEpochData || []).forEach((d) => {
            if (!d || !d.metadata) return;
            let act = 0, deact = 0, count = 0;
            if (d.__net) {
                act = d.__net.activating; deact = d.__net.deactivating; count = d.__net.validators;
            } else {
                (d.validators || []).forEach((v) => {
                    if (!v || !v.totals) return;
                    act += v.totals.total_activating_lamports || 0;
                    deact += v.totals.total_deactivating_lamports || 0;
                    count++;
                });
            }
            out.push({ epoch: Number(d.metadata.epoch), ts: d.metadata.timestamp_utc, value: lamportsToSol(act), down: lamportsToSol(deact), validators: count });
        });
        return out.sort((a, b) => a.epoch - b.epoch);
    }
    // The chart as an entry of chartsToRedraw. Its title is the switch between
    // the two measures; the labels under it name the two extremes.
    function cvNet2Entry() {
        const st = cvNet2Last;
        if (!st) return null;
        const seg = (mode, label) => '<button type="button" data-net2="' + mode + '"' + (cvNet2Mode === mode ? ' class="active"' : '') + '>' + label + '</button>';
        const title = '<span class="cv-vd-toggle cv-vd-toggle-sm" id="cv-net2-toggle" role="group" aria-label="What this chart shows">' +
            seg('validators', 'Validators') + seg('flow', 'Stake in motion') + '</span>';
        const pts = st.points;
        if (cvNet2Mode === 'flow') {
            const peakIn = pts.reduce((a, p) => (p.value > a.value ? p : a), pts[0]);
            const peakOut = pts.reduce((a, p) => (p.down > a.down ? p : a), pts[0]);
            return { id: NET2_ID, data: pts, title, highlightEpoch: st.highlightEpoch, opts: {
                variant: 'flow', gradId: 'cv-net2-gradient', butterfly: true,
                tip: p => '+' + shortSol(p.value) + ' activating, -' + shortSol(p.down) + ' deactivating',
                labels: () => cvChartInOrder([peakIn.epoch, cvChartSide('Peak in', '+' + shortSol(peakIn.value), peakIn.epoch, 'In')],
                    [peakOut.epoch, cvChartSide('Peak out', '-' + shortSol(peakOut.down), peakOut.epoch, 'Out')])
            } };
        }
        const whole = v => formatNumber(Math.round(v));
        const data = pts.map(p => ({ epoch: p.epoch, value: p.validators }));
        const min = data.reduce((a, p) => (p.value < a.value ? p : a), data[0]);
        const max = data.reduce((a, p) => (p.value > a.value ? p : a), data[0]);
        return { id: NET2_ID, data, title, highlightEpoch: st.highlightEpoch, opts: {
            variant: 'validators', gradId: 'cv-net2-gradient',
            tip: p => whole(p.value) + ' validators',
            labels: () => cvChartInOrder([min.epoch, cvChartSide('Min', whole(min.value), min.epoch)], [max.epoch, cvChartSide('Max', whole(max.value), max.epoch)])
        } };
    }
    document.addEventListener('click', (e) => {
        const t = e.target && e.target.closest ? e.target : null;
        if (!t) return;
        const seg = t.closest('#cv-net2-toggle button');
        if (seg) {
            cvNet2Mode = seg.getAttribute('data-net2') === 'flow' ? 'flow' : 'validators';
            const entry = cvNet2Entry();
            const box = document.getElementById(NET2_ID);
            if (!entry || !box) return;
            chartsToRedraw = chartsToRedraw.filter(c => c.id !== NET2_ID);
            chartsToRedraw.push(entry);
            renderInteractiveChart(box, entry.data, entry.title, entry.highlightEpoch ?? null, entry.opts);
            return;
        }
        // An epoch pill under a main chart selects that epoch, like the picker in the bar.
        const pill = t.closest('[data-cv-main-epoch]');
        if (pill) {
            const sel = document.getElementById('epoch-select');
            const epoch = pill.getAttribute('data-cv-main-epoch');
            if (sel && String(sel.value) !== epoch && Array.from(sel.options).some(o => o.value === epoch)) {
                sel.value = epoch;
                sel.dispatchEvent(new Event('change'));
            }
        }
    });

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

    // The card of a pool on the Pools tab, top to bottom: the plot and the
    // name (a real link to the pool page), two head cells, the chart of the
    // active stake, four small cells, one line of the description (it opens
    // in place) and a row with the site of the pool and its keys.
    function poolCardHtml(g, sparklineData, highlightEpoch, isStale = false, selEpoch = null) {
        const title = cleanText(g.definition.long_name) || g.name;
        const displayTitle = g.name === 'OTHER' ? 'Other Stakes' : title;
        const epoch = isStale ? Number(selEpoch) : Number(latestEpochNumber);
        const inEpoch = isStale ? ' in epoch ' + selEpoch : '';
        const pastEpoch = isStale ? selEpoch : null;
        const sol = lamportsToSol(g.total_active_lamports);
        const solShown = cardSol(sol);

        const hasChart = !!sparklineData && sparklineData.length >= 1;
        const chartContainerId = `chart-container-${g.name.replace(/\s+/g, '-')}-${Math.random().toString(36).slice(2,7)}`;
        if (hasChart) chartsToRedraw.push({ id: chartContainerId, data: sparklineData, title: '', highlightEpoch });

        // The sprite stands on a plot (see POOL PLOTS); at that size the
        // larger sprite file is needed. data-logo-default lets a theme switch
        // swap the flat logo that stands in when there is no sprite.
        const isDarkTheme = document.body.classList.contains('dark-theme-body');
        const logoHtml = (g.name === 'OTHER' || !g.definition.image)
            ? `<div class="card-header-logo card-header-logo-svg cv-plot">${g.name === 'OTHER' ? otherIsoImg(256) : ''}${OTHER_GROUP_SVG}</div>`
            : `<div class="card-header-logo cv-plot"><img src="${resolveLogoUrlSync(g.definition.image, isDarkTheme, 256)}" data-logo-default="${g.definition.image}" data-logo-iso="256" alt="" loading="lazy" decoding="async"></div>`;

        // Change of the active stake since the epoch before (the history of the pool has it).
        const before = hasChart ? sparklineData.find(d => Number(d.epoch) === epoch - 1) : null;
        const delta = before ? g.total_active_lamports - Math.round(before.value * 1e9) : null;
        const change = delta === null ? null : cvSignedSol(delta);
        const share = cvNetworkActive > 0 ? g.total_active_lamports / cvNetworkActive * 100 : null;
        const cells = [
            flowCell('activating', 'Activating', g.total_activating_lamports, pastEpoch),
            flowCell('deactivating', 'Deactivating', g.total_deactivating_lamports, pastEpoch),
            { icon: 'change', label: 'Change vs ' + (epoch - 1), value: change ? change.text : '-', cls: change ? change.cls : '',
                zero: !change || change.text === '0',
                tip: change ? 'Active stake against epoch ' + (epoch - 1) + ': ' + (delta > 0 ? '+' : '') + formatNumber(lamportsToSol(delta), 2) + ' SOL'
                    : 'No stake from this pool in epoch ' + (epoch - 1) },
            { icon: 'share', label: 'Share of stake', value: share === null ? '-' : shareText(share), zero: !(share > 0),
                tip: 'Share of all the active stake on Solana' + inEpoch }
        ];

        let descText = cleanText(g.definition.description);
        if (g.name === 'OTHER' && !descText) {
            descText = 'Aggregate of all stakes that do not match any defined pool or stakeholder category. ' +
                      'This includes validators that are not captured by other groups rules or keys.';
        }
        const url = cleanText(g.definition.url);
        let host = '';
        if (isValidHttpUrl(url)) {
            try { host = new URL(url).hostname.replace(/^www\./, ''); } catch (_) { host = ''; }
        }
        // Keys: one round sign each (the kind and the key are in its tooltip, a
        // click copies the key); a long list ends with the number of the rest.
        const keys = ['OTHER', 'SELF_STAKE', 'ID_STAKE'].includes(g.name) ? []
            : g.staker_keys.map(k => [k, 'Staker']).concat(g.withdrawer_keys.map(k => [k, 'Withdrawer']));
        const keySign = ([k, kind]) => keySignHtml(kind, k, 'fa-key');
        const poolLink = escapeHtml(poolHref(g.name, epoch));
        const keysShown = keys.length > CARD_KEYS_SHOWN ? CARD_KEYS_SHOWN - 1 : keys.length;
        const keysHtml = keys.length
            ? '<span class="cv-pc-keys">' + keys.slice(0, keysShown).map(keySign).join('') +
              (keys.length > keysShown ? '<a class="cv-pc-more" data-cv-nav href="' + poolLink + '" data-cv-tip="' +
                  escapeHtml((keys.length - keysShown) + ' more keys on the page of the pool') + '">+' + (keys.length - keysShown) + '</a>' : '') + '</span>'
            : '';
        const aboutHtml = (descText || host || keysHtml)
            ? '<div class="cv-pc-about">' +
              (descText ? '<div class="cv-pc-desc" role="button" tabindex="0" aria-expanded="false"><p>' + descText +
                  '</p><i class="fas fa-chevron-down" aria-hidden="true"></i></div>' : '') +
              ((host || keysHtml) ? '<div class="cv-pc-foot">' +
                  (host ? '<a class="cv-pc-site" href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(host) +
                      '<i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>' : '') + keysHtml + '</div>' : '') +
              '</div>'
            : '';

        return `
            <div class="sp-block sp-group-card sp-pool-card" data-pool-group="${g.name}">
                <div class="card-header" style="cursor: pointer;">
                    <a class="cv-card-link" data-cv-nav href="${poolLink}">${logoHtml}<span class="pool-name">${cvLinkLabelHtml(displayTitle)}</span></a>
                </div>
                <div class="card-body">
                    <div class="card-main-content">
                        ${headCellsHtml([
                            { icon: 'active-stake', label: 'Active stake', value: sol > 0 ? solShown.text : '0',
                                tip: (isStale || !solShown.exact) ? 'Active stake' + inEpoch + ': ' + formatNumber(sol, 2) + ' SOL' : '' },
                            { icon: 'people', label: 'Active validators', value: formatNumber(g.active_validator_count),
                                tip: 'Validators with ' + lamportsToSol(MIN_ACTIVE_STAKE) + ' SOL or more of active or activating stake from this pool' + inEpoch }
                        ])}
                        ${hasChart ? `<div class="interactive-chart-container" id="${chartContainerId}"></div>` : ''}
                        ${microCellsHtml(cells)}
                    </div>
                    ${aboutHtml}
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
        chartsToRedraw = chartsToRedraw.filter(c => c.id === 'summary-chart-container' || c.id === NET2_ID);

        if (!aggregatedData || Object.keys(aggregatedData).length === 0) {
            container.className = 'sp-groups-grid';
            container.innerHTML = '<p style="grid-column: 1 / -1; text-align: center;">No pool data available to display.</p>';
            return;
        }

        const groupsArr = Object.values(aggregatedData).filter(g => g.total_validator_count > 0);
        const getSparkData = (gname) => historicDataByPool ? historicDataByPool[gname] : null;

        // A measure: one grid, the largest first or (a second click) the smallest first.
        const measure = {
            stake: g => g.total_active_lamports,
            validators: g => g.active_validator_count,
            activating: g => g.total_activating_lamports,
            deactivating: g => g.total_deactivating_lamports
        }[sortMode];
        if (measure) {
            container.className = 'sp-groups-grid';
            const min = (sortMode === 'activating' || sortMode === 'deactivating') ? MIN_ACTIVE_STAKE : 0;
            const sorted = groupsArr.sort((a, b) => sortCmp(measure(a), measure(b), currentSortAsc, min) ||
                (b.total_active_lamports - a.total_active_lamports));
            container.innerHTML = sorted.map(g => 
                poolCardHtml(g, getSparkData(g.name), highlightEpoch, isStale, selEpoch)
            ).join('');
            markShortDescriptions(container);
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
        markShortDescriptions(container);
    }

    // A description that fits its one line needs no way to open: one pass
    // reads every card, a second one marks them (no layout in between).
    function markShortDescriptions(root) {
        const items = Array.from((root || document).querySelectorAll('.cv-pc-desc'));
        const fits = items.map(d => { const p = d.firstElementChild; return !!p && p.clientWidth > 0 && p.scrollHeight <= p.clientHeight + 1; });
        items.forEach((d, i) => { if (!d.classList.contains('is-open')) d.classList.toggle('is-short', fits[i]); });
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
        // The notes that stood here have moved: the counting rule is in the
        // Documentation, the version is in the footer, and the bar under the
        // header marks a past epoch. The hidden pill still carries that state.
        document.getElementById('info-notes-container').innerHTML = '';

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
    // Only a few full past snapshots stay in memory (each is several MB of
    // JSON and far more once parsed). The one unused for the longest gives
    // its place back to the light entry built from the aggregated history
    // and is loaded again when somebody opens that epoch.
    const FULL_EPOCHS_KEPT = 3;
    const pseudoEpochStash = new Map();
    function trimFullEpochCache(justLoaded) {
        if (fullEpochCache.size <= FULL_EPOCHS_KEPT) return;
        // Never the epoch that was just loaded, nor one a view has selected.
        const keep = new Set([justLoaded]);
        ['epoch-select', 'pool-epoch-select', 'validator-epoch-select'].forEach((id) => {
            const sel = document.getElementById(id);
            if (sel && sel.value !== '') keep.add(Number(sel.value));
        });
        for (const epoch of Array.from(fullEpochCache.keys())) {
            if (fullEpochCache.size <= FULL_EPOCHS_KEPT) break;
            if (keep.has(epoch)) continue;
            fullEpochCache.delete(epoch);
            const pseudo = pseudoEpochStash.get(epoch);
            if (!pseudo) continue;
            epochMap.set(epoch, pseudo);
            const i = allEpochData.findIndex(d => d.metadata && d.metadata.epoch === epoch);
            if (i >= 0) allEpochData[i] = pseudo;
        }
    }
    
    // Convert one aggregated entry into a pseudo-snapshot matching the shape the
    // rest of the dashboard expects. Three independent invariants are preserved:
    //   1. Sum of validators[].totals.total_active_lamports == totals.active_lamports
    //   2. Sum of validators[].aggregations.by_group[name] == pool_stats[name]
    //   3. Number of validators[] entries with aggregations.by_group[name] == pool_stats[name].validator_count
    // Achieved by emitting one "totals carrier" validator with the epoch totals
    // and N pseudo-validators per pool group (each carrying 1/N of the pool's stake).
    const NO_TOTALS = { total_active_lamports: 0, total_activating_lamports: 0, total_deactivating_lamports: 0 };
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
            
            // One object fills all the n places of the pool: the entries are
            // equal and only read, and a full history would hold about a
            // million of them otherwise.
            const carrier = {
                __pseudo: 'pool_carrier',
                __pool_group: groupName,
                totals: NO_TOTALS,
                aggregations: {
                    by_group: [{
                        name: groupName,
                        active_lamports: activeShare,
                        activating_lamports: activatingShare,
                        deactivating_lamports: deactivatingShare
                    }]
                }
            };
            for (let i = 0; i < n; i++) validators.push(carrier);
        }
        
        return {
            __aggregated: true,
            // Network figures of the epoch for the second chart of the main page.
            __net: {
                activating: Object.keys(poolStats).reduce((s, k) => s + (poolStats[k].activating_lamports || 0), 0),
                deactivating: Object.keys(poolStats).reduce((s, k) => s + (poolStats[k].deactivating_lamports || 0), 0),
                validators: totals.validator_count || 0
            },
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
            // A hit moves the epoch to the "recently used" end.
            const hit = fullEpochCache.get(epoch);
            fullEpochCache.delete(epoch);
            fullEpochCache.set(epoch, hit);
            return hit;
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
            pseudoEpochStash.set(epoch, epochData);
            // Also replace pseudo entry in epochMap so future reads hit full data
            epochMap.set(epoch, fullData);
            // Update allEpochData index too
            const idx = allEpochData.findIndex(d => d.metadata && d.metadata.epoch === epoch);
            if (idx >= 0) allEpochData[idx] = fullData;
            trimFullEpochCache(epoch);
            return fullData;
        } catch (err) {
            console.error(`Lazy load failed for epoch ${epoch}:`, err);
            return null;
        }
    }
    
    // Show/hide a small loader overlay for lazy snapshot loads.
    // Targets the pool detail content area to avoid covering the whole page.
    // (several loads can run at once - a newer choice while an older one is
    // still loading - so the loader counts them and leaves with the last)
    let epochLoaderDepth = 0;
    function showEpochLoader(message = 'Loading epoch data...') {
        epochLoaderDepth++;
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
        epochLoaderDepth = Math.max(0, epochLoaderDepth - 1);
        if (epochLoaderDepth > 0) return;
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
    
    // The sort bar of the Pools tab (its default state is also in the page markup).
    function setActiveSortButton(mode) {
        const bar = document.getElementById('sorting-bar');
        if (!bar) return;
        const item = (key, icon, label) => ({ attr: ' data-sort="' + key + '"', icon, label, active: mode === key, dir: key !== 'category' });
        sortBarRender(bar, [item('category', 'fa-folder-tree', 'Category'), item('stake', 'fa-coins', 'Stake'),
            item('validators', 'fa-user-check', 'Validators'), item('activating', 'fa-arrow-trend-up', 'Activating'),
            item('deactivating', 'fa-arrow-trend-down', 'Deactivating')], currentSortAsc ? 'asc' : 'desc');
    }
    
    // Maps tab id to its label as shown in breadcrumbs.
    const tabToBreadcrumb = {
        'pools': 'Pools',
        'validators': 'Validators', 
        'docs': 'Documentation'
    };
    
	function activateTab(targetTab, opts) {
		requestAnimationFrame(() => subheaderShowTab(targetTab));
		document.querySelectorAll('.sp-tab-link').forEach(item => {
			item.classList.remove('active');
			item.removeAttribute('aria-current');
		});
		document.querySelectorAll('.sp-tab-content').forEach(item => 
			item.classList.remove('active')
		);
		
		const link = document.querySelector(`.sp-tab-link[data-tab="${targetTab}"]`);
		const content = document.getElementById(`tab-content-${targetTab}`);
		
		if (link && content) { 
			link.classList.add('active'); 
			link.setAttribute('aria-current', 'page');
			content.classList.add('active'); 
		}
		
		// A card rendered while its tab is hidden has no size, so the check of
		// one-line descriptions runs again when the Pools tab comes on screen.
		if (targetTab === 'pools') {
			// Use rAF so the browser has applied the display change before measuring
			requestAnimationFrame(() => {
				const poolsContainer = document.getElementById('groups-grid-container');
				if (poolsContainer) markShortDescriptions(poolsContainer);
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
        if (tabsNav && opts && opts.scroll) {
            tabsNav.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
	}

    // ============================================
    // CHART FUNCTIONS (ВИКЛИК)
    // ============================================
    // Draws the charts of the main view that need it: a new chart, or one
    // whose width has changed. A resize that keeps the width (a phone hiding
    // its address bar), a second call in a row and a chart that is out of
    // sight and already waiting draw nothing.
    function drawAllChartsNow() {
        chartsToRedraw.forEach(chart => {
            const container = document.getElementById(chart.id);
            if (!container) return;
            const width = container.clientWidth;
            if (width > 0 ? width === container.__cvDrawnWidth : !!container.__cvWait) return;
            renderInteractiveChart(container, chart.data, chart.title, chart.highlightEpoch ?? null, chart.opts || null);
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
    // A choice of epoch can overtake the loading of an earlier one: only the
    // latest choice is drawn when its data is there (an answer that arrives
    // for an older choice is kept in the cache and not drawn).
    let mainEpochSeq = 0;
    async function switchToEpochWithLazyLoad(epochNum, historicData) {
        const numKey = Number(epochNum);
        const seq = ++mainEpochSeq;
        const entry = epochMap.get(numKey);
        if (entry && entry.__aggregated) {
            showEpochLoader(`Loading epoch ${numKey}...`);
            try {
                await loadEpochFull(numKey);
            } finally {
                hideEpochLoader();
            }
        }
        if (seq !== mainEpochSeq) return;
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
    // The stakers block opens as a table; cards and bubbles are one click away and the choice is kept.
    const CV_VIEWS = ['table', 'cards', 'bubbles'];
    let cvSourcesView = CV_VIEWS.indexOf(safeStorage.getItem('validatorSourcesView')) >= 0 ? safeStorage.getItem('validatorSourcesView') : 'table';
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
    let validatorsSortAsc = false;
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
    // One history file per validator. The files opened last stay in memory
    // (a session can visit hundreds of validators); an older one is loaded
    // again on the next visit. A failed download is not kept.
    const SHARDS_KEPT = 16;
    function loadValidatorShard(vote) {
        if (cvShardCache.has(vote)) {
            const hit = cvShardCache.get(vote);
            cvShardCache.delete(vote);
            cvShardCache.set(vote, hit);
            return hit;
        }
        const p = cvFetchJsonState(validatorsBaseUrl + encodeURIComponent(vote) + '.json').catch(err => {
            console.warn('[stake-dashboard] validator history unavailable:', err && err.message);
            cvShardCache.delete(vote);
            return { state: 'error', data: null };
        });
        cvShardCache.set(vote, p);
        while (cvShardCache.size > SHARDS_KEPT) cvShardCache.delete(cvShardCache.keys().next().value);
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
                    // (a fourth number, when the history files carry it, is the
                    // number of stake accounts of the staker in that epoch)
                    return { name: nameRemap.get(name) || name, active: g[0] || 0, activating: g[1] || 0,
                        deactivating: g[2] || 0, count: typeof g[3] === 'number' ? g[3] : null };
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
        if (isFinite(n) && n !== Number(latestEpochNumber)) p.set('epoch', String(n));
        if (vote) p.set('find', vote);
        return window.location.pathname + '?' + p.toString();
    }
    function cvRememberMainScroll() {
        const main = document.getElementById('main-dashboard-view');
        if (main && main.style.display !== 'none') cvMainScrollY = window.scrollY;
    }
    function cvRenderRoute(fresh) {
        // (a tooltip kept open by a click - a card, a bubble, a row - belongs
        // to the view that is being left)
        cvVdUnpinTip();
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
    // A click the page handles itself: the main button without a modifier
    // key. Any other click on a link is left to the browser (a new tab, a
    // new window, a download).
    function cvPlainClick(e) {
        return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    }
    // The address of a tab of the main view with the epoch on screen: what
    // the browser opens for a tab link or for the way back in the bar.
    function tabHref(tab) {
        const p = new URLSearchParams();
        if (tab && tab !== URL_DEFAULTS.tab) p.set('tab', tab);
        if (tab === 'pools' && currentSortMode && currentSortMode !== URL_DEFAULTS.sort) p.set('sort', currentSortMode);
        const epoch = new URLSearchParams(window.location.search).get('epoch');
        if (epoch && epoch !== URL_DEFAULTS.epoch) p.set('epoch', epoch);
        const q = p.toString();
        return window.location.pathname + (q ? '?' + q : '');
    }
    // That address follows the epoch and the sort order, so a link gets it
    // at the moment the pointer or the focus comes to it.
    ['pointerover', 'pointerdown', 'focusin'].forEach((type) => {
        document.addEventListener(type, (e) => {
            const a = e.target && e.target.closest ? e.target.closest('a.sp-tab-link[data-tab], a.cv-sub-crumb[data-tab]') : null;
            if (!a) return;
            const href = tabHref(a.getAttribute('data-tab'));
            if (a.getAttribute('href') !== href) a.setAttribute('href', href);
        }, true);
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
        const root = document.getElementById('stake-pool-dashboard');
        if (root) root.classList.remove('cv-is-notfound');
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
        // ("not found" is a state of the whole page: its backdrop belongs to the root)
        const root = document.getElementById('stake-pool-dashboard');
        if (root) root.classList.toggle('cv-is-notfound', kind === 'notfound');
        if (!kind) { view.removeAttribute('data-state'); box.innerHTML = ''; return; }
        view.setAttribute('data-state', 'message');
        const back = '<a class="cv-vd-back" href="' + escapeHtml(window.location.pathname + '?tab=validators') +
            '" data-cv-main="1"><i class="fas fa-arrow-left" aria-hidden="true"></i>Validators list</a>';
        let title = 'Loading...';
        if (kind === 'loading') {
            box.innerHTML = '<div class="cv-vd-msg"><div class="cv-vd-spinner"></div><p>Loading validator...</p></div>';
        } else if (kind === 'notfound') {
            title = 'Not found';
            box.innerHTML = '<div class="cv-vd-msg is-plots"><div class="cv-vd-msg-card"><h2>Validator not found</h2>' +
                '<p>No validator with this vote account or identity key appears in the data since epoch ' + DATASET_FIRST_EPOCH + '.</p>' +
                '<p class="cv-vd-msg-key">' + escapeHtml(key || '') + '</p>' + back + '</div></div>';
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
    // The name in the page header is a copy control of the same kind as the
    // ID and Vote keys next to it: it copies the validator's name, or the
    // full vote account when the validator has no name.
    function cvVdSetName(shown, realName, vote) {
        const h = document.getElementById('cv-vd-name');
        if (!h) return;
        const value = realName || vote || shown;
        h.removeAttribute('title');
        h.innerHTML = '<button type="button" class="cv-key cv-key-name" data-cv-copy="' + escapeHtml(value) + '"' +
            (realName ? '' : cvHoverTip(escapeHtml(value))) + ' aria-label="' + (realName ? 'Copy name' : 'Copy vote account') +
            '"><span class="cv-key-name-text">' + escapeHtml(shown) + '</span>' + COPY_ICONS + '</button>';
        const slot = document.getElementById('cv-vd-name-copy');
        if (slot) slot.innerHTML = '';
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
        cvVdSetName(m.displayName, m.realName ? m.rawName : '', m.vote);
        let status = '';
        if (!m.isActive && m.lastEpoch !== null) {
            status = '<span class="cv-vd-badge is-inactive" data-cv-tip="Last seen with stake in epoch ' + m.lastEpoch + '">' +
                '<i class="fas fa-power-off" aria-hidden="true"></i>Inactive since epoch ' + (m.lastEpoch + 1) + '</span>';
        } else if (m.historyState === 'new') {
            status = '<span class="cv-vd-badge is-new" data-cv-tip="First seen in the current epoch">' +
                '<i class="fas fa-seedling" aria-hidden="true"></i>New validator</span>';
        }
        $('cv-vd-status').innerHTML = status;
        $('cv-vd-keys').innerHTML = validatorKeyChipsHtml(m.identity, m.vote);
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
        $('cv-vd-sources-title').innerHTML = 'Stakers' + small;
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
        cvVdSetName(shownName, hasRealName(shownRaw) ? shownRaw : '', m.vote);
        // On a past epoch a yellow pill marks a name that is not the current one.
        const namePill = $('cv-vd-namepill');
        if (namePill) {
            namePill.innerHTML = nameDiffers
                ? '<span class="cv-vd-asof" data-cv-tip="The name of this validator in epoch ' + E + '"><i class="fas fa-hourglass-half" aria-hidden="true"></i>name in epoch ' + E + '</span>'
                : '';
        }
        $('cv-vd-keys').innerHTML = validatorKeyChipsHtml(shownIdentity, m.vote);
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
        // The age of the vote account is a chip too, as in the lists (the
        // card below keeps its details).
        const ageThen = cvAgeAt(m, entry);
        const ageChip = ageThen
            ? '<span class="cv-chip cv-chip-age" data-cv-tip="' + escapeHtml('Vote account age' + (isPast ? ' in epoch ' + E : '') + ': ' +
              cvAgeText(ageThen) + ' epochs with votes') + '"><span class="cv-seg"><i class="fas fa-hourglass-half" aria-hidden="true"></i>' +
              escapeHtml(cvAgeText(ageThen)) + ' ep</span></span>'
            : '';
        if (entry && entry.meta) {
            const metaHtml = buildMetaChipsHtml(entry.meta, entry.scriptInfo);
            chips = (isPast ? '<span class="cv-vd-asof"><i class="fas fa-hourglass-half" aria-hidden="true"></i>In epoch ' + E + '</span>' : '') +
                (ageChip ? metaHtml.replace(/<\/div>$/, ageChip + '</div>') : metaHtml);
        } else if (entry && E < META_FIRST_EPOCH) {
            chips = '<span class="cv-vd-nodata">Commission and client data start at epoch ' + META_FIRST_EPOCH + '</span>';
        }
        $('cv-vd-chips').innerHTML = chips;
        // Metric cards; the details of each open in a tooltip (hover) that a click pins.
        const note = isPast ? ' in epoch ' + E : '';
        const card = (icon, cls, valueHtml, label, tipKind, extraAttr) =>
            '<div class="pool-metric-card"' + (tipKind ? ' data-cv-vdtip="' + tipKind + '"' : '') + (extraAttr || '') + '>' +
            cardIco(icon, 'cv-ico-metric') + '<div class="pool-metric-info">' +
            '<span class="pool-metric-value' + (cls === 'activating' ? ' positive' : (cls === 'deactivating' ? ' negative' : (cls === 'none' ? ' is-zero' : ''))) + '">' +
            valueHtml + '</span><span class="pool-metric-label">' + escapeHtml(label) + '</span></div></div>';
        let ageHtml = '-';
        const ageNow = cvAgeNow(m);
        if (ageThen) {
            ageHtml = escapeHtml(cvAgeText(ageThen));
            if (ageNow && E !== m.lastEpoch) {
                ageHtml += '<small class="cv-vd-now"> / ' + escapeHtml(cvAgeText(ageNow)) + (m.isActive ? ' now' : ' at the end') + '</small>';
            }
        }
        const sol = '<small class="cv-vd-unit"> SOL</small>';
        // An amount of a million SOL or more is shown in whole SOL, so the
        // larger number fits its card; the exact amount stays in the tooltip.
        const cardSol = (lamports) => {
            const v = lamportsToSol(lamports);
            return numPairHtml(v, v >= 1e6 ? 0 : 2);
        };
        const activeSol = lamportsToSol(entry ? entry.active : 0);
        const activeTip = activeSol >= 1e6
            ? ' data-cv-tip="Active stake: ' + formatNumber(activeSol, 2) + ' SOL"'
            : shortTipAttr('Active stake', activeSol);
        $('cv-vd-metrics').innerHTML = !entry ? '' : (
            card('active-stake', '', cardSol(entry.active) + sol, 'Active Stake', null, activeTip) +
            card('stake-rank', '', entry.rank ? '#' + formatNumber(entry.rank) : '-', 'Stake Rank', 'rank') +
            card('stake-accounts', '', entry.accounts !== null ? formatNumber(entry.accounts) : '-', 'Stake Accounts', 'accounts') +
            card('vote-account-age', '', ageHtml, 'Vote Account Age', 'age') +
            card('activating', entry.activating > 0 ? 'activating' : 'none', (entry.activating > 0 ? '+' + cardSol(entry.activating) : '0') + sol, 'Activating', 'activating') +
            card('deactivating', entry.deactivating > 0 ? 'deactivating' : 'none', (entry.deactivating > 0 ? '-' + cardSol(entry.deactivating) : '0') + sol, 'Deactivating', 'deactivating'));
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
                { height: 110, grid: CV_GRID_LINES, stats: true, highlightEpoch: E, onPick: cvVdSelectEpoch });
            cvRenderEpochChart(auxBox, rankMode
                ? m.epochs.filter(e => e.rank).map(e => ({ epoch: e.epoch, ts: e.ts, value: e.rank }))
                : m.epochs.filter(e => e.accounts !== null).map(e => ({ epoch: e.epoch, ts: e.ts, value: e.accounts })),
                rankMode
                    ? { height: 110, grid: CV_GRID_LINES, stats: true, invert: true, statLabels: ['Best', 'Lowest'], fmt: v => '#' + whole(v),
                        tip: p => '#' + whole(p.value) + ' by active stake', highlightEpoch: E, onPick: cvVdSelectEpoch }
                    : { height: 110, grid: CV_GRID_LINES, stats: true, fmt: whole, tip: p => whole(p.value) + ' stake accounts',
                        highlightEpoch: E, onPick: cvVdSelectEpoch });
            cvRenderEpochChart(dynBox, m.epochs.map(e => ({ epoch: e.epoch, ts: e.ts, value: lamportsToSol(e.activating),
                down: lamportsToSol(e.deactivating) })),
                { height: 110, butterfly: true, grid: CV_GRID_LINES, stats: true, scaleMode: cvDynScaleMode, highlightEpoch: E, onPick: cvVdSelectEpoch });
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

    // Dashed grid lines with their values on the charts of a validator page:
    // one switch for the whole site, off by default. The settings panel is
    // to flip it; until then the key can be set by hand.
    const CV_GRID_LINES = safeStorage.getItem('cvGridLines') === '1';

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
    // How many rows of the stakers block (pools, programs, known holders, the rest): "1 entry", "5 entries".
    const cvEntries = n => n + (n === 1 ? ' entry' : ' entries');
    function cvSignedSol(lamports) {
        const sol = lamportsToSol(lamports);
        const text = formatCompact(Math.abs(sol));
        if (text === '0') return { text: '0', cls: '' };
        // (a change against the epoch before is history: its colours are the
        // quiet ones wherever it stands - the bright green and red belong to
        // the stake that moves now)
        return sol > 0 ? { text: '+' + text, cls: 'cv-vd-pos is-soft' } : { text: '-' + text, cls: 'cv-vd-neg is-soft' };
    }
    function cvVdRenderSources(m, entry, idx) {
        const body = document.getElementById('cv-vd-sources-body');
        const bar = document.getElementById('cv-vd-sortbar');
        const scopeBox = document.getElementById('cv-vd-scope');
        document.querySelectorAll('#cv-vd-view-toggle button').forEach(b =>
            b.classList.toggle('active', b.getAttribute('data-view') === cvSourcesView));
        if (!body) return;
        if (cvBubblesMap) {
            if (cvBubblesWatch) cvBubblesWatch.unobserve(cvBubblesMap);
            if (cvBubblesSeen) cvBubblesSeen.unobserve(cvBubblesMap);
            cvBubblesMap = null;
        }
        // (a tooltip kept open by a click on something of this block goes with it)
        if (cvPinnedTip && cvPinnedTip.__card && body.contains(cvPinnedTip.__card)) cvVdUnpinTip();
        if (!entry) {
            body.innerHTML = '';
            if (bar) bar.innerHTML = '';
            if (scopeBox) scopeBox.innerHTML = '';
            return;
        }
        const E = entry.epoch;
        const isPast = E !== Number(latestEpochNumber);
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
        // (the donut was drawn before this check: its Reset follows the filter that is left)
        const donutReset = document.getElementById('cv-vd-donut-reset');
        if (donutReset) donutReset.hidden = !cvPoolFilter;
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
            const item = (k, icon, label) => ({ attr: ' data-src-sort="' + k + '"', icon, label, active: key === k, dir: k !== 'category' });
            sortBarRender(bar, [item('category', 'fa-folder-tree', 'Category'), item('active', 'fa-coins', 'Stake'),
                item('activating', 'fa-arrow-trend-up', 'Activating'), item('deactivating', 'fa-arrow-trend-down', 'Deactivating'),
                item('change', 'fa-arrows-up-down', 'Change vs ' + (E - 1))], dir, note);
        };
        if (src.shown.length === 0 && !(cvShowPastPools && past.length)) {
            sortBar(sortKey, sortDir);
            body.innerHTML = '<div class="chart-no-data">No stake of ' + minSol + ' SOL or more in this epoch</div>' + smallHtml;
            return;
        }
        const thinNames = new Set(thin.map(g => g.name));
        const list = !cvPoolFilter ? src.shown
            : src.shown.filter(g => (cvPoolFilter === CV_THIN_KEY ? thinNames.has(g.name) : g.name === cvPoolFilter));
        const pastList = (cvShowPastPools && !cvPoolFilter) ? past : [];
        const filterHtml = cvPoolFilter
            ? '<div class="cv-vd-filter">Showing only <b>' + (cvPoolFilter === CV_THIN_KEY
                ? 'the ' + cvEntries(list.length) + ' under 1%' : escapeHtml(list[0].title)) +
              '</b> <button type="button" class="cv-vd-linkbtn" data-cv-pool-clear="1">Show all</button></div>'
            : '';
        const countsNote = (isPast && list.some(g => g.count === null))
            ? '<p class="cv-vd-note">Stake accounts per staker are not in the history files. <button type="button" class="cv-vd-linkbtn" id="cv-vd-load-counts">Load them for epoch ' +
              E + '</button> (the full data of the epoch, a few seconds).</p>'
            : '';
        const epochNote = isPast ? '<span class="epoch-inline-note">in epoch ' + E + '</span>' : '';
        const pct = g => shareText(g.share);
        const href = g => escapeHtml(poolHref(g.name, E, m.vote));
        const goTip = g => escapeHtml(isPast
            ? 'Opens the ' + g.title + ' page for epoch ' + E + ' with this validator selected. A past epoch takes a moment to load.'
            : 'Opens the ' + g.title + ' page with this validator selected');
        const catTitle = c => (c === 'OTHER' ? 'Other' : toTitleCaseKey(c));
        const sortedBy = (arr, key, dir) => arr.slice().sort((a, b) => {
            const x = cvSourceValue(a, key);
            const y = cvSourceValue(b, key);
            // (stake on the move: the stakers with none stay at the end in both directions)
            if (key === 'activating' || key === 'deactivating') return sortCmp(x, y, dir === 'asc', MIN_ACTIVE_STAKE) || (b.active - a.active);
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
        // The details of a staker as a tooltip: a bubble opens it, and so does
        // a row of the table on a phone (where the table keeps fewer columns).
        const exact = lamports => formatNumber(lamportsToSol(lamports), 2) + ' SOL';
        // "New" and "leaving": the whole stake of a staker arrives or
        // leaves in the epoch. Every view marks it with the same dashed
        // green or red sign (the ring of a badge in the lists, the outline
        // of a bubble, the edge of a card and of a table row) and a word.
        const stateOf = g => {
            if (g.past) return '';
            const ring = poolBadgeRing(g.active, g.activating, g.deactivating);
            return ring.activatingOnly ? 'new' : (ring.cls === ' is-exiting' ? 'leaving' : '');
        };
        const STATE_NOTE = { 'new': 'All of its stake is activating', leaving: 'All of its stake is deactivating' };
        const stateTag = g => {
            const s = stateOf(g);
            return s ? '<span class="cv-state is-' + s + '" data-cv-tip="' + STATE_NOTE[s] + '">' + s + '</span>' : '';
        };
        const tipState = g => {
            const s = stateOf(g);
            return s ? '<div class="cv-tip-state"><span class="cv-state is-' + s + '">' + s + '</span>' + STATE_NOTE[s] + '</div>' : '';
        };
        const tipHead = g => '<div class="pool-tooltip-title cv-tip-pool">' + cvSourceLogoMini(g) + '<span>' + escapeHtml(g.title) + '</span></div>' +
            (isPast ? '<div class="pool-tooltip-epoch">Epoch ' + E + '</div>' : '') + tipState(g);
        const tipLink = g => '<a class="cv-tip-go" data-cv-nav href="' + href(g) + '">Open its page' + CV_GO_SVG + '</a>';
        // (the change against the epoch before is history: its colour is
        // quieter than the colour of the stake that moves now)
        const tipChange = delta => (delta ? cvTipRow(cvTipIco('change'), 'Change vs epoch ' + (E - 1), cvSignedSol(delta).text + ' SOL',
            (delta > 0 ? 'is-up' : 'is-down') + ' is-soft') : '');
        const tipDetails = g => cvTipRow(cvTipIco('active-stake'), 'Active stake', exact(g.active)) +
            cvTipRow(cvTipIco('share'), 'Share of validator', pct(g)) +
            (g.activating > 0 ? cvTipRow(cvTipIco('activating'), 'Activating', '+' + exact(g.activating), 'is-up') : '') +
            (g.deactivating > 0 ? cvTipRow(cvTipIco('deactivating'), 'Deactivating', '-' + exact(g.deactivating), 'is-down') : '') +
            (g.count ? cvTipRow(cvTipIco('stake-accounts'), 'Stake accounts', formatNumber(g.count)) : '') + tipChange(g.delta);
        if (cvSourcesView === 'bubbles') {
            // Bubbles: every staker of the epoch as a bubble sized by its
            // stake, packed around the largest one. A bubble takes the colour
            // of stake on the move, and a click keeps its details open.
            // Stakers without stake in the epoch stand apart, small and grey.
            // This view has no sort bar.
            cvBarKey = null;
            if (bar) bar.innerHTML = '';
            const isDark = document.body.classList.contains('dark-theme-body');
            const weight = g => g.active + g.activating;
            const top = Math.max(1, ...list.map(weight));
            // How strongly the stake of a bubble moves, 0..1: against the
            // largest movement among the bubbles, or against a quarter of a
            // percent of the stake of the validator when all of them move
            // less than that (so a movement of a few SOL never looks strong).
            // The root keeps a small movement visible next to a large one.
            const moveOf = g => (g.activating || 0) + (g.deactivating || 0);
            const topMove = Math.max(entry.active * 0.0025, ...list.map(moveOf));
            const strength = g => (topMove > 0 ? Math.min(1, Math.sqrt(moveOf(g) / topMove)) : 0);
            // The size of a bubble, 0..1 (relative to the largest staker of
            // this validator): mostly the root of its part of the largest
            // one, partly its order of magnitude - so 17M, 50K and 2 SOL are
            // three different sizes, and the smallest is still easy to tap.
            const span = top > MIN_ACTIVE_STAKE ? Math.log(top / MIN_ACTIVE_STAKE) : 0;
            const sizeOf = g => {
                const w = weight(g);
                if (!(w > 0)) return 0;
                const order = span > 0 ? Math.max(0, Math.min(1, Math.log(Math.max(w, MIN_ACTIVE_STAKE) / MIN_ACTIVE_STAKE) / span)) : 1;
                return 0.65 * Math.sqrt(w / top) + 0.35 * order;
            };
            const face = (g, big) => {
                const iso = big ? 256 : 96;
                if (g.name === 'OTHER') return (otherIsoImg(iso) || '') + OTHER_GROUP_SVG;
                if (isValidHttpUrl(g.def.image)) {
                    return '<img src="' + escapeHtml(resolveLogoUrlSync(g.def.image, isDark, iso)) + '" data-logo-default="' +
                        escapeHtml(g.def.image) + '" data-logo-iso="' + iso + '" alt="">';
                }
                return '<span class="cv-bub-initials">' + escapeHtml(getInitials(g.name)) + '</span>';
            };
            const STATE = { ' is-activating-only': ' is-new', ' is-activating is-deactivating': ' is-both', ' is-activating': ' is-up',
                ' is-exiting': ' is-exit', ' is-deactivating': ' is-down' };
            const bubble = (g, i) => {
                const t = sizeOf(g);
                const ring = poolBadgeRing(g.active, g.activating, g.deactivating);
                const tip = cvRich(tipHead(g) + tipDetails(g) + tipLink(g));
                const up = (g.activating || 0) >= MIN_ACTIVE_STAKE;
                const down = (g.deactivating || 0) >= MIN_ACTIVE_STAKE;
                return '<button type="button" class="cv-bub' + (STATE[ring.cls] || '') + '" data-cv-pin="1" data-t="' + t.toFixed(4) + '" style="--i:' + i +
                    (STATE[ring.cls] ? ';--mv:' + strength(g).toFixed(3) : '') +
                    (ring.share === null ? '' : ';--act:' + ring.share + '%') + '"' + tip + ' aria-label="' + escapeHtml(g.title) + '">' +
                    '<span class="cv-bub-face">' + face(g, t > 0.4) + '</span>' +
                    '<span class="cv-bub-val">' + (ring.activatingOnly ? '+' + formatCompact(lamportsToSol(g.activating)) : formatCompact(lamportsToSol(g.active))) + '</span>' +
                    (up ? '<span class="cv-bub-flow is-up"><i class="fas fa-arrow-trend-up" aria-hidden="true"></i></span>' : '') +
                    (down ? '<span class="cv-bub-flow is-down"><i class="fas fa-arrow-trend-down" aria-hidden="true"></i></span>' : '') +
                    '</button>';
            };
            const pastBubble = g => '<button type="button" class="cv-bub-past" data-cv-pin="1"' + cvRich(tipHead(g) + '<div class="cv-flow-more">' +
                (g.before !== null ? 'No stake since epoch ' + (g.before + 1) : 'Stake from epoch ' + g.after) + '</div>' + tipLink(g)) +
                ' aria-label="' + escapeHtml(g.title) + '"><span class="cv-bub-face">' + face(g, false) + '</span></button>';
            // The totals of the epoch; a click opens the split by staker, like the cards at the top of the page.
            const amount = (lamports, sign) => (lamports > 0 ? sign + numPairHtml(lamportsToSol(lamports), 2) : '0') + '<small> SOL</small>';
            const chip = (kind, icon, label, valueHtml, cls) => '<button type="button" class="cv-bubble-chip' + (cls ? ' ' + cls : '') + '" data-cv-vdtip="' + kind + '">' +
                cardIco(icon) + '<span>' + label + '</span><b>' + valueHtml + '</b></button>';
            const current = byActive(list);
            // The panel holds everything but the bubbles with stake: the
            // totals, the stakers without stake in the epoch and the note
            // about the smallest ones (on a phone its parts stand around
            // the map: the totals above it, the rest under it).
            body.innerHTML = filterHtml + '<div class="cv-bwrap"><div class="cv-binfo"><div class="cv-bubble-chips">' +
                chip('stake', 'active-stake', 'Total stake', amount(entry.active, '')) +
                chip('activating', 'activating', 'Activating', amount(entry.activating, '+'), entry.activating > 0 ? 'is-up' : '') +
                chip('deactivating', 'deactivating', 'Deactivating', amount(entry.deactivating, '-'), entry.deactivating > 0 ? 'is-down' : '') +
                '</div>' +
                (pastList.length ? '<div class="cv-bpast"><div class="cv-bpast-head"><span>No stake in epoch ' + E + '</span><small>' +
                    cvEntries(pastList.length) + ' from other epochs</small></div><div class="cv-bpast-row">' + pastList.map(pastBubble).join('') + '</div></div>' : '') +
                smallHtml + '</div>' +
                (current.length ? '<div class="cv-bmap">' + current.map(bubble).join('') + '</div>'
                    : '<p class="cv-vd-note cv-bmap-empty">No stake of ' + minSol + ' SOL or more in this epoch</p>') +
                '</div>';
            const map = body.querySelector('.cv-bmap');
            if (map) {
                cvBubblesLayout(map);
                cvBubblesMap = map;
                if (cvBubblesWatch) cvBubblesWatch.observe(map);
                if (cvBubblesSeen) cvBubblesSeen.observe(map);
            }
            return;
        }
        if (isTable) {
            sortBar(sortKey, sortDir);
            const hasCounts = list.some(g => g.count !== null);
            // A column header sorts by its column. short: what a phone shows in
            // its place (a shorter word or the sign of the measure); the
            // columns marked cv-st-x are left out on a phone.
            const head = (key, label, cls, tip, short) => '<button type="button" class="cv-st-h' + (cls ? ' ' + cls : '') + (short ? ' has-short' : '') +
                (sortKey === key ? ' is-sorted' : '') + '" data-src-sort="' + key + '"' + (tip ? ' data-cv-tip="' + tip + '"' : '') +
                (short ? ' aria-label="' + label + '"' : '') + '><span class="cv-st-hl">' + label + '</span>' +
                (short ? '<span class="cv-st-hs">' + short + '</span>' : '') + ' <i class="fas ' +
                (sortKey === key ? (sortDir === 'asc' ? 'fa-caret-up' : 'fa-caret-down') : 'fa-sort') + '" aria-hidden="true"></i></button>';
            // The stake of a row: the whole number, and the short one a phone shows.
            // (no active stake - the stake of a new staker is all activating -
            // is a quiet "0": here zero is the fact)
            const stakeCell = lamports => {
                const sol = lamportsToSol(lamports);
                return '<span class="cv-st-c" data-label="Active stake, SOL">' + (sol >= 0.005
                    ? '<span class="cv-st-full">' + formatNumber(sol, 2) + '</span><span class="cv-st-short">' + cardSol(sol).text + '</span>'
                    : '<span class="cv-vd-muted">0</span>') + '</span>';
            };
            // A tap on a row opens its details on a phone (see cvPinTarget).
            const rowTip = html => ' data-cv-rowtip="' + cvRichId(html) + '"';
            // What a cell of the table says: a number is a value; a small
            // dot stands where there is nothing - no stake on the move (none,
            // or less than the 0.1 SOL every count of the page starts from),
            // no change, any number of a staker without stake in the epoch -
            // so a column shows only what is there; a quiet "0" is a zero
            // that is the fact; "-" means the data has no value.
            const NO_FLOW = '<span class="cv-st-none" role="img" aria-label="none"></span>';
            const NO_DATA = '<span class="cv-vd-muted">-</span>';
            // The stake on the move of a row. A wide table shows the arrow of
            // the direction; on a phone the arrow is the header of the column,
            // and the number carries its sign and drops the decimal from a
            // hundred thousand, so it fits (an amount that would round to
            // zero reads "<1").
            const flowShort = sol => {
                const part = (v, unit) => (v >= 99.95 ? v.toFixed(0) : v.toFixed(1)) + unit;
                if (sol >= 999500) return part(sol / 1e6, 'M');
                if (sol >= 999.5) return part(sol / 1e3, 'K');
                const whole = sol.toFixed(0);
                return whole === '0' ? '&lt;1' : whole;
            };
            const flow = (lamports, up) => {
                if (!((lamports || 0) >= MIN_ACTIVE_STAKE)) return NO_FLOW;
                const sol = lamportsToSol(lamports);
                const text = formatCompact(sol);
                return '<span class="' + (up ? 'cv-vd-pos' : 'cv-vd-neg') + '"><i class="fas ' + (up ? 'fa-arrow-trend-up' : 'fa-arrow-trend-down') +
                    '" aria-hidden="true"></i> <span class="cv-st-full">' + (text === '0' ? '&lt;1' : text) + '</span><span class="cv-st-short">' +
                    '<span class="cv-st-sign">' + (up ? '+' : '-') + '</span>' + flowShort(sol) + '</span></span>';
            };
            const flowCell = (label, lamports, up) => '<span class="cv-st-c cv-st-flow" data-label="' + label + '">' + flow(lamports, up) + '</span>';
            const none = (label, cls) => '<span class="cv-st-c' + (cls ? ' ' + cls : '') + '" data-label="' + label + '">' + NO_FLOW + '</span>';
            const changeCell = d => '<span class="cv-st-c cv-st-x" data-label="Change vs epoch ' + (E - 1) + '">' +
                (!d ? NO_DATA : (d.text === '0' ? NO_FLOW : '<span class="' + d.cls + '">' + d.text + '</span>')) + '</span>';
            const shareCell = (share, text) => '<span class="cv-st-c cv-st-share cv-st-x" data-label="Share of validator"><span class="cv-st-bar">' +
                (share > 0 ? '<i style="width:' + Math.max(1, Math.min(100, share)).toFixed(1) + '%"></i>' : '') + '</span><span class="cv-st-pct">' +
                (share > 0 ? text : NO_FLOW) + '</span></span>';
            // The pool name is the only link of a row; the arrow next to it says so.
            const rowHtml = g => {
                const d = g.delta === null ? null : cvSignedSol(g.delta);
                const state = stateOf(g);
                const cat = '<span class="cv-vd-src-cat">' + escapeHtml(catTitle(g.category)) + '</span>';
                return '<div class="cv-st-row' + (state ? ' is-' + state : '') + '"' + rowTip(tipHead(g) + tipDetails(g) + tipLink(g)) + '>' +
                    '<span class="cv-st-c cv-st-source"><a class="cv-st-logo" data-cv-nav href="' + href(g) + '" tabindex="-1" aria-hidden="true">' +
                    cvSourceLogoMini(g, 96) + '</a><span class="cv-vd-src-text"><a class="cv-vd-src-name" data-cv-nav href="' +
                    href(g) + '" data-cv-tip="' + goTip(g) + '">' + cvLinkLabelHtml(g.title) + '</a>' +
                    (state ? '<span class="cv-vd-src-sub">' + cat + stateTag(g) + '</span>' : cat) + '</span></span>' +
                    stakeCell(g.active) + shareCell(g.share, pct(g)) +
                    (hasCounts ? '<span class="cv-st-c cv-st-x" data-label="Stake accounts">' + (g.count !== null ? formatNumber(g.count) : NO_DATA) + '</span>' : '') +
                    flowCell('Activating', g.activating, true) + flowCell('Deactivating', g.deactivating, false) + changeCell(d) +
                    '<span class="cv-st-c cv-st-trend" data-label="Stake over time">' + cvMiniSpark(seriesFull(g.name), E) + '</span>' + corner(g) + '</div>';
            };
            const pastRowHtml = p => {
                const d = p.delta === null ? null : cvSignedSol(p.delta);
                return '<div class="cv-st-row is-past"' + rowTip(tipHead(p) + '<div class="cv-flow-more">' +
                    (p.before !== null ? 'No stake since epoch ' + (p.before + 1) : 'Stake from epoch ' + p.after) + '</div>' + tipChange(p.delta) + tipLink(p)) + '>' +
                    '<span class="cv-st-c cv-st-source">' + cvSourceLogoMini(p, 96) + '<span class="cv-vd-src-text"><span class="cv-vd-src-name">' +
                    escapeHtml(p.title) + '</span><span class="cv-vd-src-cat">' + escapeHtml(catTitle(p.category)) + '</span><span class="cv-vd-past-line">' +
                    pastStatus(p) + '</span></span></span>' + none('Active stake, SOL') + shareCell(0, '') +
                    (hasCounts ? none('Stake accounts', 'cv-st-x') : '') + flowCell('Activating', 0, true) + flowCell('Deactivating', 0, false) + changeCell(d) +
                    '<span class="cv-st-c cv-st-trend" data-label="Stake over time">' + cvMiniSpark(seriesFull(p.name), E) + '</span></div>';
            };
            // The validator's totals of the epoch: always the first row.
            const prevTotal = m.historyState === 'ok' ? m.epochs.find(e => e.epoch === E - 1) : null;
            const totalDelta = prevTotal ? cvSignedSol(entry.active - prevTotal.active) : null;
            const totalSeries = m.historyState === 'ok'
                ? m.epochs.map(e => ({ epoch: e.epoch, ts: e.ts, value: lamportsToSol(e.active) })) : [];
            const totalRow = '<div class="cv-st-row cv-st-total"' + rowTip('<div class="pool-tooltip-title">Total stake</div>' +
                (isPast ? '<div class="pool-tooltip-epoch">Epoch ' + E + '</div>' : '') + cvTipRow(cvTipIco('active-stake'), 'Active stake', exact(entry.active)) +
                cvTipRow(cvTipIco('people'), 'Stakers', String(src.shown.length)) +
                (entry.activating > 0 ? cvTipRow(cvTipIco('activating'), 'Activating', '+' + exact(entry.activating), 'is-up') : '') +
                (entry.deactivating > 0 ? cvTipRow(cvTipIco('deactivating'), 'Deactivating', '-' + exact(entry.deactivating), 'is-down') : '') +
                (entry.accounts !== null && entry.accounts !== undefined ? cvTipRow(cvTipIco('stake-accounts'), 'Stake accounts', formatNumber(entry.accounts)) : '') +
                (prevTotal ? tipChange(entry.active - prevTotal.active) : '')) + '>' +
                '<span class="cv-st-c cv-st-source"><span class="cv-st-total-ico"><img class="cv-total-tile" src="/brand/decor/alpine-tile.webp" alt="" ' +
                'width="320" height="263" loading="lazy" decoding="async"></span><span class="cv-vd-src-text">' +
                '<span class="cv-vd-src-name">Total stake</span><span class="cv-vd-src-cat">' + cvEntries(src.shown.length) + '</span></span></span>' +
                stakeCell(entry.active) +
                '<span class="cv-st-c cv-st-share cv-st-x" data-label="Share of validator"><span class="cv-st-bar"><i style="width:100%"></i></span>' +
                '<span class="cv-st-pct">100%</span></span>' +
                (hasCounts ? '<span class="cv-st-c cv-st-x" data-label="Stake accounts">' + (entry.accounts !== null ? formatNumber(entry.accounts) : NO_DATA) + '</span>' : '') +
                flowCell('Activating', entry.activating, true) + flowCell('Deactivating', entry.deactivating, false) + changeCell(totalDelta) +
                '<span class="cv-st-c cv-st-trend" data-label="Stake over time">' + cvMiniSpark(totalSeries, E) + '</span></div>';
            const pastHead = pastList.length
                ? '<div class="cv-st-group cv-st-group-past"><span>No stake in epoch ' + E + '</span><span class="cv-st-group-meta">' +
                  cvEntries(pastList.length) + ' from other epochs</span></div>'
                : '';
            let rows = '';
            if (sortKey === 'category') {
                cats.forEach(cat => {
                    const inCat = byActive(list.filter(g => g.category === cat));
                    const pastCat = pastList.filter(p => p.category === cat);
                    if (!inCat.length && !pastCat.length) return;
                    const share = inCat.reduce((a, g) => a + g.share, 0);
                    rows += '<div class="cv-st-group"><span>' + escapeHtml(catTitle(cat)) + '</span><span class="cv-st-group-meta">' +
                        (inCat.length ? cvEntries(inCat.length) + ', ' +
                            shareText(share) + ' of stake' : 'no stake in this epoch') +
                        '</span></div>' + inCat.map(rowHtml).join('') + pastCat.map(pastRowHtml).join('');
                });
            } else {
                rows = sortedBy(list, sortKey, sortDir).map(rowHtml).join('') + pastHead + pastList.map(pastRowHtml).join('');
            }
            // (on a narrow screen the table scrolls sideways: a new order keeps the place it was scrolled to)
            const wasTable = body.querySelector('.cv-st');
            const wasLeft = wasTable ? wasTable.scrollLeft : 0;
            body.innerHTML = filterHtml + '<div class="cv-st-wrap"><div class="cv-st' + (hasCounts ? '' : ' no-counts') + '" data-cv-scroll="x"><div class="cv-st-row cv-st-head">' +
                head('name', 'Staker', 'cv-st-source') + head('active', 'Active, SOL', '', '', 'Stake') + head('active', 'Share', 'cv-st-x') +
                (hasCounts ? head('accounts', 'Accounts', 'cv-st-x') : '') + head('activating', 'Activating', '', '', cardIco('activating')) +
                head('deactivating', 'Deactivating', '', '', cardIco('deactivating')) +
                head('change', 'vs ' + (E - 1), 'cv-st-x', 'Change of the active stake against epoch ' + (E - 1)) +
                '<div class="cv-st-h cv-st-trend has-short"><span class="cv-st-hl">Stake over time</span><span class="cv-st-hs"><i class="fas fa-chart-line" aria-hidden="true"></i></span></div></div>' +
                totalRow + rows + '</div>' + scrollArrowsHtml('x') + '</div>' +
                '<p class="cv-st-hint"><i class="fas fa-hand-pointer" aria-hidden="true"></i>Tap a row for details</p>' + smallHtml + countsNote;
            const table = body.querySelector('.cv-st');
            if (wasLeft) table.scrollLeft = wasLeft;
            scrollHint(table);
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
            ? '<div class="card-header-logo card-header-logo-svg cv-plot">' + (g.name === 'OTHER' ? otherIsoImg(256) + OTHER_GROUP_SVG
                : '<span class="cv-src-initials">' + escapeHtml(getInitials(g.title)) + '</span>') + '</div>'
            : '<div class="card-header-logo cv-plot"><img src="' + escapeHtml(resolveLogoUrlSync(g.def.image,
                document.body.classList.contains('dark-theme-body'), 256)) + '" data-logo-default="' + escapeHtml(g.def.image) + '" data-logo-iso="256" alt=""></div>');
        const chartHtml = name => {
            if (m.historyState !== 'ok') return '';
            const id = 'cv-src-chart-' + (++cvChartSeq);
            charts.push({ id, points: series(name) });
            return '<div class="interactive-chart-container" id="' + id + '"></div>';
        };
        // Head cells: the stake of this staker here and its share of the validator.
        const heads = g => {
            const sol = lamportsToSol(g.active);
            const shown = cardSol(sol);
            return headCellsHtml([
                { icon: 'active-stake', label: 'Active stake', value: sol > 0 ? shown.text : '0',
                    tip: (isPast || !shown.exact) ? 'Active stake' + (isPast ? ' in epoch ' + E : '') + ': ' + formatNumber(sol, 2) + ' SOL' : '' },
                { icon: 'share', label: 'Share of validator', value: g.past ? '0%' : pct(g), tip: isPast ? 'Share of the validator stake in epoch ' + E : '' }
            ]);
        };
        // The largest stake of a staker here over the history, with its epoch
        // (a shorter label where the cell shares its row with another one).
        const peakCell = (value, epoch, alone) => ({ icon: 'peak-stake', label: epoch === null ? 'Peak stake' : (alone ? 'Peak, epoch ' : 'Peak in ') + epoch,
            value: epoch === null ? '-' : formatCompact(value), zero: epoch === null,
            tip: epoch === null ? '' : 'Largest stake from this staker here: ' + formatNumber(value, 2) + ' SOL in epoch ' + epoch });
        // Under the chart: the stake on the move, the change since the epoch
        // before, then the number of stake accounts - or, where the history
        // has no count for the epoch, the peak of this staker here.
        const cells = g => {
            const d = g.delta === null ? null : cvSignedSol(g.delta);
            const out = [flowCell('activating', 'Activating', g.activating, isPast ? E : null),
                flowCell('deactivating', 'Deactivating', g.deactivating, isPast ? E : null),
                { icon: 'change', label: 'Change vs ' + (E - 1), value: d ? d.text : '-', cls: d ? d.cls : '', zero: !d || d.text === '0',
                    tip: d ? 'Active stake against epoch ' + (E - 1) + ': ' + (g.delta > 0 ? '+' : '') + formatNumber(lamportsToSol(g.delta), 2) + ' SOL' : '' }];
            if (g.count !== null) {
                out.push({ icon: 'stake-accounts', label: 'Stake accounts', value: formatNumber(g.count) });
            } else {
                const top = seriesFull(g.name).reduce((a, p) => (p.value > a.value ? p : a), { value: 0, epoch: null });
                out.push(peakCell(top.value, top.epoch));
            }
            return out;
        };
        const cardHtml = g => '<div class="sp-block sp-group-card cv-src-card' + (stateOf(g) ? ' is-' + stateOf(g) : '') + '"><div class="card-header"><a class="cv-src-link" data-cv-nav href="' + href(g) +
            '" data-cv-tip="' + goTip(g) + '">' + logoHtml(g) + '<span class="pool-name">' + cvLinkLabelHtml(g.title) + '</span></a>' + stateTag(g) + corner(g) + '</div>' +
            '<div class="card-body"><div class="card-main-content">' + heads(g) + chartHtml(g.name) + microCellsHtml(cells(g)) + '</div></div></div>';
        const pastCardHtml = p => '<div class="sp-block sp-group-card cv-src-card is-past"><div class="card-header"><div class="cv-src-link">' +
            logoHtml(p) + '<span class="pool-name">' + escapeHtml(p.title) + '</span></div></div>' +
            '<div class="card-body"><div class="card-main-content"><div class="cv-vd-past-line">' + pastStatus(p) + '</div>' + heads(p) +
            chartHtml(p.name) + microCellsHtml([peakCell(lamportsToSol(p.peak), p.peakEpoch, true)]) + '</div></div></div>';
        const anyCard = g => (g.past ? pastCardHtml(g) : cardHtml(g));
        let html = '';
        if (sortKey === 'category') {
            html = '<div class="cv-cat-flow">';
            cats.forEach(cat => {
                const inCat = ordered.filter(g => g.category === cat);
                const n = inCat.length;
                if (!n) return;
                html += '<div class="category-section cv-cat-n' + Math.min(n, 3) + '"><div class="category-header"><div class="title">' + escapeHtml(catTitle(cat)) +
                    '</div><div class="meta">' + cvEntries(n) + '</div></div><div class="sp-groups-grid">' +
                    inCat.map(anyCard).join('') + '</div></div>';
            });
            html += '</div>';
        } else {
            html = '<div class="sp-groups-grid cv-vd-flat-grid">' + ordered.map(anyCard).join('') + '</div>';
        }
        body.innerHTML = filterHtml + html + smallHtml + countsNote;
        charts.forEach(c => cvRenderEpochChart(document.getElementById(c.id), c.points,
            { height: 76, grid: CV_GRID_LINES, stats: true, zeroBreak: true, highlightEpoch: E, onPick: cvVdSelectEpoch }));
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
        const reset = document.getElementById('cv-vd-donut-reset');
        if (reset) reset.hidden = !cvPoolFilter;
        const shown = entry ? cvEntrySources(m, entry).shown.sort((a, b) => b.active - a.active) : [];
        if (!shown.length || !(entry.active > 0)) {
            box.innerHTML = '<div class="chart-no-data">No stake above ' + lamportsToSol(MIN_ACTIVE_STAKE) + ' SOL in this epoch</div>';
            return;
        }
        const pctText = share => shareText(share * 100);
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
                    cvTipRow(cvTipIco('active-stake'), 'Active stake', formatNumber(lamportsToSol(g.active), 2) + ' SOL') +
                    cvTipRow(cvTipIco('share'), 'Share of validator', pctText(share)) + '<div class="cv-flow-more">Click: show only this staker below</div>') });
        });
        if (thin.length) {
            const sum = thin.reduce((a, g) => a + g.active, 0);
            const label = cvEntries(thin.length) + ' under 1%';
            segs.push({ key: CV_THIN_KEY, g: null, title: label, active: sum, share: sum / entry.active, color: '#B8C0CC',
                tip: cvRich('<div class="pool-tooltip-title">' + label + ' of the validator stake</div>' + thin.slice(0, 12).map(poolRow).join('') +
                    (thin.length > 12 ? '<div class="cv-flow-more">and ' + (thin.length - 12) + ' more</div>' : '') +
                    '<div class="cv-flow-more">Click: show only these below</div>') });
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
    // The sign of a measure in a tooltip row: an icon of the set. later: the
    // markup waits hidden in the page (the tooltip of a pool in the
    // validators list is written with its row), so the image gets its address
    // only when the tooltip opens - a hidden image would load all the same.
    function cvTipIco(name, later) {
        return '<img class="cv-tip-ico" ' + (later ? 'data-cv-src' : 'src') + '="/brand/icons/' + name +
            '.webp" alt="" aria-hidden="true" width="48" height="48" decoding="async">';
    }
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
        } else if (kind === 'stake') {
            const rows = cvEntrySources(m, entry).shown.slice().sort((a, b) => b.active - a.active);
            html = title('Active stake by staker' + inEpoch);
            if (!rows.length) html += more('Nothing above ' + lamportsToSol(MIN_ACTIVE_STAKE) + ' SOL');
            rows.slice(0, LIMIT).forEach(g => {
                const share = entry.active > 0 ? g.active / entry.active * 100 : 0;
                html += cvTipRow(cvSourceLogoMini(g), g.title, formatCompact(lamportsToSol(g.active)) + '<span class="cv-tip-dim">' +
                    shareText(share) + '</span>');
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
                '<div class="cv-chipline">' + validatorKeySignsHtml(r.identity, r.vote) +
                '<div class="cv-inactive-chips"' + (r.last_epoch >= META_FIRST_EPOCH ? ' data-vote="' + escapeHtml(r.vote) + '"' : '') + '></div></div></div>' +
                '<span class="cv-inactive-meta">Inactive since epoch ' + (r.last_epoch + 1) + '</span>' +
                '<span class="cv-inactive-stake">' + formatCompact(lamportsToSol(r.active_lamports || 0)) + ' SOL in epoch ' + r.last_epoch + '</span></div>';
        }).join('');
        return '<div class="cv-inactive-block"><div class="cv-inactive-head"><i class="fas fa-power-off" aria-hidden="true"></i>Inactive validators (' +
            hits.length + ')<span>no stake in the current epoch; each page keeps the history</span></div>' + rows +
            (hits.length > LIMIT ? '<div class="cv-inactive-more">and ' + (hits.length - LIMIT) + ' more: add letters to narrow the search</div>' : '') + '</div>';
    }
    // Vote account age of a list row: registry value + 1 once it has credits
    // in the epoch of the snapshot.
    function cvListAge(v, atEpoch) {
        const meta = v ? v.meta : null;
        if (meta && typeof meta.validator_age === 'number') {
            return { value: meta.validator_age + (meta.epoch_credits > 0 ? 1 : 0), isMin: meta.validator_age_is_min === true };
        }
        // Snapshots before epoch 1043 carry no age: estimate it from the
        // registry value in the validators index, minus the epochs since.
        const row = (cvIndexByVote && v && v.info) ? cvIndexByVote.get(v.info.vote_pubkey) : null;
        // (atEpoch: the epoch of a pool page; the validators list has its own)
        const at = atEpoch === undefined ? validatorsListEpoch : Number(atEpoch);
        if (!row || typeof row.validator_age !== 'number' || !isFinite(at)) return null;
        const since = Math.max(0, Number(row.validator_age_epoch) - at);
        return { value: Math.max(0, row.validator_age - since), isMin: row.validator_age_is_min === true, approx: true };
    }
    // The age chip joins the meta chips of a row in the Age sort mode of a
    // list (the validators list and the list of a pool page). a: cvListAge().
    function cvWithAgeChip(html, a) {
        const tip = !a ? 'No age data for this vote account'
            : (a.approx ? 'Estimated age in this epoch: the current age minus the epochs since. Exact for a validator that voted in every one of them.'
                : 'Vote account age: ' + cvAgeText(a) + ' epochs with votes');
        // (the wrapper is a line of its own under the chips and the keys:
        // every row of the Age order has the same two lines)
        const chip = '<span class="cv-age-line"><span class="cv-chip cv-chip-age' + (a ? '' : ' is-missing') + '" data-cv-tip="' + escapeHtml(tip) +
            '"><span class="cv-seg"><i class="fas fa-hourglass-half" aria-hidden="true"></i>' +
            (a ? (a.approx ? '~' : '') + escapeHtml(cvAgeText(a)) + ' ep' : '-') + '</span></span></span>';
        return html ? html.replace(/<\/div>$/, chip + '</div>') : '<div class="cv-meta">' + chip + '</div>';
    }
    // Meta chips of a row of the validators list.
    function cvListMetaHtml(v) {
        const html = buildMetaChipsHtml(v.meta, validatorsScriptInfo);
        if (validatorsSortMode !== 'age' || !validatorsHasAge) return html;
        return cvWithAgeChip(html, cvListAge(v));
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
    // A click on a metric card or on a bubble pins its tooltip: it stays,
    // becomes solid and selectable, until a click elsewhere, a scroll or
    // Escape. The element it belongs to is marked while it is open.
    let cvPinnedTip = null;
    function cvVdUnpinTip() {
        if (cvPinnedTip) {
            if (cvPinnedTip.__card) cvPinnedTip.__card.classList.remove('is-picked');
            cvPinnedTip.remove();
        }
        cvPinnedTip = null;
    }
    // What a click pins a tooltip to: a metric card, a bubble, or - on a
    // phone, where the Stakers table keeps fewer columns - a row of that
    // table (not its links and buttons).
    const CV_NARROW_TABLE = window.matchMedia ? window.matchMedia('(max-width: 768px)') : null;
    function cvPinTarget(t) {
        if (!t || !t.closest) return null;
        const card = t.closest('[data-cv-vdtip], [data-cv-pin], [data-cv-pbub]');
        if (card) return card;
        const row = t.closest('.cv-st-row[data-cv-rowtip]');
        if (!row || !CV_NARROW_TABLE || !CV_NARROW_TABLE.matches) return null;
        // (the name and the logo of a staker open the details too: a finger
        // goes for the name first, and the details hold the link to the page
        // of the staker; the other links and buttons of a row keep their own action)
        const control = t.closest('a, button');
        return (!control || control.matches('a.cv-vd-src-name, a.cv-st-logo')) ? row : null;
    }
    function cvVdPinTip(card) {
        const same = cvPinnedTip && cvPinnedTip.__card === card;
        cvVdUnpinTip();
        if (same) return;
        if (card.hasAttribute('data-cv-rich')) showCvRichTip(card);
        else if (card.hasAttribute('data-cv-pbub')) showPoolBubTip(card);
        else if (card.hasAttribute('data-cv-rowtip')) cvShowTipHtml(card, cvRichTips.get(card.getAttribute('data-cv-rowtip')) || '');
        else showCvVdTip(card);
        const tip = document.getElementById('dynamic-pool-tooltip');
        if (!tip) return;
        tip.id = 'cv-pinned-tip';
        tip.classList.add('is-pinned');
        // (the pinned form is taller - it shows its link - so it takes its
        // place again and stays clear of the element it belongs to)
        positionTip(card, tip);
        tip.__card = card;
        card.classList.add('is-picked');
        cvPinnedTip = tip;
    }
    // ---------- bubbles of the stakers block ----------
    // Lays the bubbles of a map out. Sizes follow the room there is; places
    // come from packing: the largest bubble stands in the middle and every
    // next one takes the free place nearest to it, searched along a spiral
    // that is wider than tall on a wide screen. No physics: the places are
    // computed once per width (the order in the markup is largest first).
    function cvBubblesLayout(map) {
        const W = map.clientWidth;
        if (!W) return;
        map.__cvW = W;
        const bubs = Array.from(map.querySelectorAll('.cv-bub'));
        if (!bubs.length) { map.style.height = ''; return; }
        const wide = W >= 780;
        const mid = !wide && W >= 560;
        // (data-fit: a map that may hold a hundred bubbles - the validators
        // of a pool. Its largest diameter follows the room there is, so the
        // map stays about a screen tall: the bubbles get half of the area of
        // a box as wide as the map and as tall as that screen.)
        const fit = map.hasAttribute('data-fit');
        // (crowd: a map of more than a hundred bubbles - a visitor asked for
        // more. Its small bubbles get less room and its large ones keep
        // theirs, so the sizes still tell the amounts apart: the smallest
        // diameter goes from 34 px at a hundred bubbles to 18 px at five
        // hundred, and the largest one is allowed to stay 40 px further away.)
        const crowd = fit ? Math.max(0, Math.min(1, (bubs.length - 100) / 400)) : 0;
        const dMin = fit ? Math.round(34 - 16 * crowd) : 46;
        let dMax = wide ? 190 : (mid ? 156 : Math.max(100, Math.min(136, Math.round(W * 0.42))));
        if (fit) {
            const ts = bubs.map(el => Number(el.getAttribute('data-t') || 0));
            const room = W * Math.min(wide ? 0.58 * W : (mid ? 0.95 * W : 2.1 * W), 760) * 0.5;
            const area = d => ts.reduce((sum, t) => { const x = dMin + (d - dMin) * t; return sum + x * x; }, 0) * Math.PI / 4;
            const dFloor = dMin + 14 + 40 * crowd;
            while (dMax > dFloor && area(dMax) > room) dMax *= 0.95;
            dMax = Math.round(dMax);
        }
        const PAD = fit && bubs.length > 40 ? (crowd > 0.5 ? 4 : 5) : (wide || mid ? 10 : 7);
        const ratio = wide ? 1.85 : (mid ? 1.45 : 0.92);
        const half = W / 2;
        const placed = [];
        let fitFrom = 0;
        bubs.forEach((el, i) => {
            const r = Math.round(dMin + (dMax - dMin) * Number(el.getAttribute('data-t') || 0)) / 2;
            let x = 0;
            let y = 0;
            if (i > 0 && fit) {
                // (a map that fits its room holds many small bubbles: the
                // search goes along a tight spiral - turns 8 px apart, a look
                // every 8 px of the way - and starts a little inside the place
                // of the bubble before, where the free room begins)
                let rad = Math.max(2, fitFrom - 70);
                let ang = i * 2.399963;
                for (let s = 0; s < 26000; s++) {
                    const turn = 8 / rad;
                    ang += turn;
                    rad += 8 * turn / 6.2832;
                    const px = Math.cos(ang) * rad * ratio;
                    const py = Math.sin(ang) * rad;
                    if (Math.abs(px) + r > half) continue;
                    let free = true;
                    for (let k = 0; k < placed.length; k++) {
                        const p = placed[k];
                        const min = p.r + r + PAD;
                        if ((p.x - px) * (p.x - px) + (p.y - py) * (p.y - py) < min * min) { free = false; break; }
                    }
                    if (free) { x = px; y = py; fitFrom = rad; break; }
                }
            } else if (i > 0) {
                const a0 = i * 2.399963; // (the golden angle: every bubble starts its search in a direction of its own)
                for (let s = 1; s < 9000; s++) {
                    const rad = s * 0.75;
                    const px = Math.cos(a0 + s * 0.21) * rad * ratio;
                    const py = Math.sin(a0 + s * 0.21) * rad;
                    if (Math.abs(px) + r > half) continue;
                    let free = true;
                    for (let k = 0; k < placed.length; k++) {
                        const p = placed[k];
                        const min = p.r + r + PAD;
                        if ((p.x - px) * (p.x - px) + (p.y - py) * (p.y - py) < min * min) { free = false; break; }
                    }
                    if (free) { x = px; y = py; break; }
                }
            }
            placed.push({ x, y, r });
        });
        // Then the bubbles draw together: each one creeps towards the middle
        // (or slides along a neighbour) while it touches nothing.
        const freeAt = (i, px, py) => {
            const r = placed[i].r;
            if (Math.abs(px) + r > half) return false;
            for (let k = 0; k < placed.length; k++) {
                if (k === i) continue;
                const p = placed[k];
                const min = p.r + r + PAD;
                if ((p.x - px) * (p.x - px) + (p.y - py) * (p.y - py) < min * min) return false;
            }
            return true;
        };
        const order = placed.map((p, i) => i).slice(1).sort((a, b) =>
            Math.hypot(placed[a].x / ratio, placed[a].y) - Math.hypot(placed[b].x / ratio, placed[b].y));
        for (let pass = 0; pass < 140; pass++) {
            let moved = false;
            for (let n = 0; n < order.length; n++) {
                const i = order[n];
                const p = placed[i];
                const gx = p.x / (ratio * ratio);
                const len = Math.hypot(gx, p.y);
                if (len < 0.5) continue;
                const sx = -gx / len * 1.5;
                const sy = -p.y / len * 1.5;
                if (freeAt(i, p.x + sx, p.y + sy)) { p.x += sx; p.y += sy; moved = true; }
                else if (Math.abs(sy) > 0.2 && freeAt(i, p.x, p.y + sy)) { p.y += sy; moved = true; }
                else if (Math.abs(sx) > 0.2 && freeAt(i, p.x + sx, p.y)) { p.x += sx; moved = true; }
            }
            if (!moved) break;
        }
        if (fit) {
            // A map that fits its room settles once more: every bubble sinks
            // towards the middle row while it has room, stepping sideways
            // around a neighbour - the many small bubbles of a pool stand
            // close, and the map is no taller than it has to be. (Every step
            // brings a bubble nearer to the middle row, so this ends.)
            const byRow = placed.map((p, i) => i).sort((a, b) => Math.abs(placed[a].y) - Math.abs(placed[b].y));
            for (let pass = 0; pass < 260; pass++) {
                let moved = false;
                for (let n = 0; n < byRow.length; n++) {
                    const i = byRow[n];
                    const p = placed[i];
                    if (i === 0 || Math.abs(p.y) < 1.5) continue;
                    const sy = p.y > 0 ? -1.5 : 1.5;
                    const sx = p.x > 0 ? -1.5 : 1.5;
                    if (freeAt(i, p.x, p.y + sy)) { p.y += sy; moved = true; }
                    else if (freeAt(i, p.x + sx, p.y + sy)) { p.x += sx; p.y += sy; moved = true; }
                    else if (freeAt(i, p.x - sx, p.y + sy)) { p.x -= sx; p.y += sy; moved = true; }
                }
                if (!moved) break;
            }
        }
        let top = Infinity;
        let bottom = -Infinity;
        let left = Infinity;
        let right = -Infinity;
        placed.forEach(p => {
            top = Math.min(top, p.y - p.r); bottom = Math.max(bottom, p.y + p.r);
            left = Math.min(left, p.x - p.r); right = Math.max(right, p.x + p.r);
        });
        const EDGE = 16;
        const shift = -(left + right) / 2; // (the cluster stands in the middle of the map)
        map.style.height = Math.ceil(bottom - top + 2 * EDGE) + 'px';
        bubs.forEach((el, i) => {
            const p = placed[i];
            el.style.setProperty('--d', (p.r * 2) + 'px');
            el.style.left = (half + p.x + shift - p.r).toFixed(1) + 'px';
            el.style.top = (p.y - p.r - top + EDGE).toFixed(1) + 'px';
            el.classList.toggle('is-small', p.r * 2 < 84);
            el.classList.toggle('is-tiny', p.r * 2 < 30);
        });
    }
    // ---------- bubbles of a pool page ----------
    // The validators of a pool as bubbles of the same glass: a bubble is a
    // validator (its avatar inside), sized by the stake of this pool with it
    // (the root of its part of the largest one, so areas follow amounts and
    // a large allocation stands out; a small part is the order of magnitude,
    // which keeps the smallest stake easy to tap), tinted by the stake on
    // the move as strongly as it moves (against the largest movement on the
    // map, or a quarter of a percent of the stake of the pool when every
    // movement is smaller), with a dashed rim when the whole stake arrives
    // or leaves. list: the validators to show, the largest first.
    const CV_BUB_STATE = { ' is-activating-only': ' is-new', ' is-activating is-deactivating': ' is-both', ' is-activating': ' is-up',
        ' is-exiting': ' is-exit', ' is-deactivating': ' is-down' };
    const cvPoolBubWeight = v => (v.poolStake.active_lamports || 0) + (v.poolStake.activating_lamports || 0);
    function cvPoolBubblesHtml(list) {
        const moveOf = v => (v.poolStake.activating_lamports || 0) + (v.poolStake.deactivating_lamports || 0);
        const top = list.reduce((a, v) => Math.max(a, cvPoolBubWeight(v)), 1);
        const topMove = list.reduce((a, v) => Math.max(a, moveOf(v)), poolBubblesTotal * 0.0025);
        const strength = v => (topMove > 0 ? Math.min(1, Math.sqrt(moveOf(v) / topMove)) : 0);
        const span = top > MIN_ACTIVE_STAKE ? Math.log(top / MIN_ACTIVE_STAKE) : 0;
        const sizeOf = v => {
            const w = cvPoolBubWeight(v);
            if (!(w > 0)) return 0;
            const order = span > 0 ? Math.max(0, Math.min(1, Math.log(Math.max(w, MIN_ACTIVE_STAKE) / MIN_ACTIVE_STAKE) / span)) : 1;
            return 0.85 * Math.sqrt(w / top) + 0.15 * order;
        };
        return list.map((v, i) => {
            const ps = v.poolStake;
            const ring = poolBadgeRing(ps.active_lamports || 0, ps.activating_lamports || 0, ps.deactivating_lamports || 0);
            const state = CV_BUB_STATE[ring.cls] || '';
            const raw = cleanText(v.info.name).trim();
            const name = hasRealName(raw) ? raw : shortenPubkey(raw || v.info.vote_pubkey);
            const icon = (isValidHttpUrl(v.info.icon_url) && !brokenImages.has(v.info.icon_url)) ? v.info.icon_url : '';
            const initials = escapeHtml(getInitials(name, v.info.identity_pubkey || ''));
            // (--i times the entrance: a long map does not make its last bubbles
            // wait; --f is the phase of the sway, one of eight, so neighbours move apart)
            return '<button type="button" class="cv-bub cv-pbub' + state + '" data-cv-pbub="' + escapeHtml(v.info.vote_pubkey || '') +
                '" data-t="' + sizeOf(v).toFixed(4) + '" style="--i:' + Math.min(i, 36) + ';--f:' + (i % 8) + (state ? ';--mv:' + strength(v).toFixed(3) : '') +
                (ring.share === null ? '' : ';--act:' + ring.share + '%') + '" aria-label="' + escapeHtml(name) + '">' +
                '<span class="cv-bub-face">' + (icon
                    ? '<img class="cv-pbub-img" src="' + escapeHtml(icon) + '" alt="" loading="lazy" decoding="async" data-fb="' + initials + '">'
                    : '<span class="cv-bub-initials">' + initials + '</span>') + '</span>' +
                '<span class="cv-bub-val">' + (ring.activatingOnly ? '+' + formatCompact(lamportsToSol(ps.activating_lamports || 0))
                    : formatCompact(lamportsToSol(ps.active_lamports || 0))) + '</span>' +
                ((ps.activating_lamports || 0) >= MIN_ACTIVE_STAKE ? '<span class="cv-bub-flow is-up"><i class="fas fa-arrow-trend-up" aria-hidden="true"></i></span>' : '') +
                ((ps.deactivating_lamports || 0) >= MIN_ACTIVE_STAKE ? '<span class="cv-bub-flow is-down"><i class="fas fa-arrow-trend-down" aria-hidden="true"></i></span>' : '') +
                '</button>';
        }).join('');
    }
    // The details of a bubble of a pool map, built when they open: the
    // validator, the stake of this pool with it and its share of the pool,
    // the stake on the move, the total stake of the validator. A click keeps
    // them open, with the link to the page of the validator.
    function showPoolBubTip(el) {
        const vote = el.getAttribute('data-cv-pbub');
        const v = poolValidators.find(x => x.info && x.info.vote_pubkey === vote);
        if (!v) return;
        const ps = v.poolStake || {};
        const raw = cleanText(v.info.name).trim();
        const name = hasRealName(raw) ? raw : shortenPubkey(raw || vote);
        const icon = isValidHttpUrl(v.info.icon_url) ? v.info.icon_url : '';
        const sel = document.getElementById('pool-epoch-select');
        const past = (sel && sel.value && Number(sel.value) !== Number(latestEpochNumber)) ? sel.value : null;
        const exact = lamports => (lamportsToSol(lamports || 0) >= 0.005 ? formatNumber(lamportsToSol(lamports), 2) : '0') + ' SOL';
        const ring = poolBadgeRing(ps.active_lamports || 0, ps.activating_lamports || 0, ps.deactivating_lamports || 0);
        const state = ring.activatingOnly ? 'new' : (ring.cls === ' is-exiting' ? 'leaving' : '');
        const share = (poolBubblesTotal > 0 && ps.active_lamports > 0) ? shareText(ps.active_lamports / poolBubblesTotal * 100) : '';
        // What a pool looks at when it chooses a validator: the two
        // commissions (the letters are those of the chips of the lists) and
        // the age of the vote account.
        const letter = ch => '<span class="cv-flow-logo is-initials cv-tip-letter">' + ch + '</span>';
        let feeRows = '';
        if (v.meta) {
            const cText = formatBpsPercent(metaCommissionBps(v.meta));
            const mev = metaMevInfo(v.meta, poolScriptInfo);
            const mText = formatBpsPercent(mev.bps);
            feeRows = cvTipRow(letter(COMMISSION_LABELS.inflation), 'Commission', escapeHtml(cText || 'not reported'), cText ? '' : 'is-none') +
                cvTipRow(letter(COMMISSION_LABELS.mev), 'MEV commission', escapeHtml(mText || mev.brief), mText ? '' : 'is-none');
        }
        const age = cvListAge(v, sel && sel.value ? Number(sel.value) : Number(latestEpochNumber));
        const poolLogo = cvSourceLogoMini({ name: currentPoolGroup, def: cvSourceDef(currentPoolGroup) });
        cvShowTipHtml(el, '<div class="pool-tooltip-title cv-tip-pool">' + cvMiniLogoHtml(icon, name, v.info.identity_pubkey) + '<span>' + escapeHtml(name) + '</span></div>' +
            (past ? '<div class="pool-tooltip-epoch">Epoch ' + escapeHtml(String(past)) + '</div>' : '') +
            (state ? '<div class="cv-tip-state"><span class="cv-state is-' + state + '">' + state + '</span>All pool stake here is ' +
                (state === 'new' ? 'activating' : 'deactivating') + '</div>' : '') +
            cvTipRow(poolLogo, 'Stake in this pool', exact(ps.active_lamports)) +
            (share ? cvTipRow(cvTipIco('share'), 'Share of the pool', share) : '') +
            ((ps.activating_lamports || 0) >= MIN_ACTIVE_STAKE ? cvTipRow(cvTipIco('activating'), 'Activating', '+' + exact(ps.activating_lamports), 'is-up') : '') +
            ((ps.deactivating_lamports || 0) >= MIN_ACTIVE_STAKE ? cvTipRow(cvTipIco('deactivating'), 'Deactivating', '-' + exact(ps.deactivating_lamports), 'is-down') : '') +
            cvTipRow(cvTipIco('active-stake'), 'Total stake', exact(v.totals && v.totals.total_active_lamports)) +
            feeRows + (age ? cvTipRow(cvTipIco('vote-account-age'), 'Vote account age',
                (age.approx ? '~' : '') + escapeHtml(cvAgeText(age)) + (age.value === 1 ? ' epoch' : ' epochs')) : '') +
            '<a class="cv-tip-go" data-cv-nav href="' + escapeHtml(validatorHref(vote, sel ? sel.value : null)) + '">Open its page' + CV_GO_SVG + '</a>');
    }
    let cvBubblesMap = null;
    // The most bubbles a map sways with. Every swaying bubble is moved in
    // every frame: a hundred keep a slow phone at sixty frames a second, two
    // hundred do not (measured on the stand with the processor slowed four times).
    const CV_BUBBLES_SWAY = 120;
    // A map out of sight does not sway: an endless animation is work for the
    // device also when nobody looks at it.
    const cvBubblesSeen = ('IntersectionObserver' in window) ? new IntersectionObserver(entries => entries.forEach(en => {
        en.target.classList.toggle('is-away', !en.isIntersecting);
    }), { rootMargin: '150px 0px' }) : null;
    const cvBubblesWatch = ('ResizeObserver' in window) ? new ResizeObserver(entries => entries.forEach(en => {
        const map = en.target;
        if (map.isConnected && Math.abs((map.__cvW || 0) - map.clientWidth) > 3) cvBubblesLayout(map);
    })) : null;
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
    function cvRichId(html) {
        const id = 'r' + (++cvRichSeq);
        cvRichTips.set(id, html);
        return id;
    }
    function cvRich(html) {
        return ' data-cv-rich="' + cvRichId(html) + '"';
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
            cvTipRow(cvTipIco('active-stake'), 'Total', formatNumber(lamportsToSol(t.total_active_lamports || 0), 2) + ' SOL') +
            (typeof t.total_stake_accounts === 'number' ? cvTipRow(cvTipIco('stake-accounts'), 'Stake accounts', formatNumber(t.total_stake_accounts)) : ''));
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
        const idChip = key => keyChipHtml('Identity', '', key, 'key-identity', true);
        ids.forEach((c, i) => { if (i > 0) add(c.epoch, 'Identity', idChip(ids[i - 1].identity), idChip(c.identity)); });
        // The current epoch is not in the history file yet: compare the live
        // name and identity with the last recorded ones.
        const live = m.epochs.length && m.epochs[m.epochs.length - 1].isLive ? m.epochs[m.epochs.length - 1] : null;
        if (live && names.length && String(names[names.length - 1].name || '').trim() !== m.rawName) {
            add(live.epoch, 'Name', nameHtml(names[names.length - 1].name), nameHtml(m.rawName));
        }
        if (live && ids.length && ids[ids.length - 1].identity !== m.identity && m.identity) {
            add(live.epoch, 'Identity', idChip(ids[ids.length - 1].identity), idChip(m.identity));
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
                cvSourcesView = CV_VIEWS.indexOf(viewBtn.getAttribute('data-view')) >= 0 ? viewBtn.getAttribute('data-view') : 'table';
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
                if (!cvPlainClick(e)) return;
                e.preventDefault();
                const section = document.getElementById('breadcrumb-section');
                if (section) section.click();
                return;
            }
            const card = cvPinTarget(t);
            if (card) {
                // (a link inside what is pinned - the name of a staker in the
                // table on a phone - does not navigate on a plain tap; a new
                // tab or a new window is still the link's own)
                const link = t.closest('a[href]');
                if (link && card.contains(link)) {
                    if (!cvPlainClick(e)) return;
                    e.preventDefault();
                }
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
            if (e.target.closest('#cv-pinned-tip') || cvPinTarget(e.target)) return;
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
        // A reload or a return from another site starts at the top: the page
        // is rebuilt from data, so an offset restored by the browser would
        // land on another place. The browser's own restoring is switched
        // off while the page loads and comes back for Back and Forward
        // inside the app.
        try {
            if ('scrollRestoration' in window.history) {
                window.history.scrollRestoration = 'manual';
                const restoreAuto = () => setTimeout(() => {
                    try { window.history.scrollRestoration = 'auto'; } catch (_) { /* ignore */ }
                }, 1500);
                if (document.readyState === 'complete') restoreAuto();
                else window.addEventListener('load', restoreAuto, { once: true });
            }
        } catch (_) { /* older browsers */ }
        const loader = document.getElementById('sofzp-loader-overlay');
        document.getElementById('stake-pool-dashboard').classList.add('is-loading');

        // Показуємо скелетони
        document.getElementById('summary-container').innerHTML = 
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
        // A plain visit starts at the top. A link that names another tab (or a
        // reload on that tab) starts at the tab bar, where its content begins.
        if (!urlState.validator && !new URLSearchParams(window.location.search).get('pool')) {
            if (initialTab === 'pools') {
                window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
            } else {
                requestAnimationFrame(() => requestAnimationFrame(() => {
                    const tabsNavAtLoad = document.querySelector('.sp-tabs-nav');
                    if (tabsNavAtLoad) tabsNavAtLoad.scrollIntoView({ behavior: 'instant', block: 'start' });
                }));
            }
        }

        // ============================================
        // EVENT LISTENERS
        // ============================================
        document.getElementById('sorting-bar').addEventListener('click', (e) => {
            const btn = e.target.closest('.sort-btn');
            if (!btn) return;
            
            const mode = btn.getAttribute('data-sort');
            if (!mode) return;
            // A second click on a measure flips its direction.
            if (mode === currentSortMode) {
                if (mode === 'category') return;
                currentSortAsc = !currentSortAsc;
            } else {
                currentSortMode = mode;
                currentSortAsc = false;
            }
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
        
        // The tabs are links: a plain click switches the tab in place, a
        // click with a modifier key is left to the browser (a new tab).
        document.querySelectorAll('.sp-tab-link').forEach(link => {
            link.addEventListener('click', (e) => {
                if (!cvPlainClick(e)) return;
                e.preventDefault();
                const targetTab = e.currentTarget.getAttribute('data-tab');
                activateTab(targetTab, { scroll: true });
            });
        });

        const grid = document.getElementById('groups-grid-container');
        
        grid.addEventListener('click', (event) => {
            // The one-line description opens and closes in place.
            const desc = event.target.closest('.cv-pc-desc');
            if (desc && !desc.classList.contains('is-short')) {
                const open = desc.classList.toggle('is-open');
                desc.setAttribute('aria-expanded', String(open));
            }
        });
        
        grid.addEventListener('keydown', (e) => {
            if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('cv-pc-desc') &&
                !e.target.classList.contains('is-short')) {
                e.preventDefault();
                const open = e.target.classList.toggle('is-open');
                e.target.setAttribute('aria-expanded', String(open));
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

        // After a resize the one-line descriptions are checked again, when the width of the grid has changed.
        let descGridWidth = 0;
        const refreshDescCollapsers = debounce(() => {
            const root = document.getElementById('groups-grid-container');
            if (!root || !root.clientWidth || root.clientWidth === descGridWidth) return;
            descGridWidth = root.clientWidth;
            markShortDescriptions(root);
        }, 200);
        
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
                poolImageContainer?.querySelectorAll(':scope > img[data-logo-stem]').forEach(n => n.remove());
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
                    // "Other Stakes" has a sprite of its own: it stands on the
                    // plot next to the glyph, which stays as the fallback.
                    poolImageContainer.querySelectorAll(':scope > img[data-logo-stem]').forEach(n => n.remove());
                    svgWrap.innerHTML = OTHER_GROUP_SVG;
                    if (poolGroup === 'OTHER') svgWrap.insertAdjacentHTML('beforebegin', otherIsoImg(256));
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
                    if (Number(newEpoch) === Number(latestEpochNumber)) params.delete('epoch');
                    else params.set('epoch', newEpoch);
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
                    // (a newer choice, or leaving the page, overtakes a load in flight)
                    if (this.value !== newEpoch || currentPoolGroup !== poolGroup) return;
                    
                    // Оновлюємо дані для нової епохи
                    keepPoolBlockInPlace(() => updatePoolMetrics(poolGroup));
                    // TODO: updatePoolCharts(poolGroup) - буде додано пізніше
                };
            }
            
            // Оновлюємо URL з параметром pool та epoch
            const params = new URLSearchParams(window.location.search);
            params.set('pool', poolGroup);
            
            // Використовуємо poolEpochSelect, а не головний epochSelect
            if (poolEpochSelect && poolEpochSelect.value) {
                const selectedEpoch = poolEpochSelect.value;
                if (Number(selectedEpoch) === Number(latestEpochNumber)) params.delete('epoch');
                else params.set('epoch', selectedEpoch);
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
        // The validators of a pool keep their place on screen when the page
        // is drawn again for another epoch. The cards above them change
        // their height (a past epoch adds a line to each), and the rows and
        // the bubbles are new elements, so a browser has nothing to hold on
        // to. The list (or the map) is held only when a visitor is at it or
        // below its top; higher on the page nothing is touched.
        function keepPoolBlockInPlace(redraw) {
            const block = document.getElementById('pool-validators-table');
            const before = block ? block.getBoundingClientRect().top : null;
            redraw();
            if (before === null || before > window.innerHeight * 0.6) return;
            const settle = () => {
                if (!block.isConnected) return;
                const now = block.getBoundingClientRect().top;
                // (at once: the page scrolls smoothly by default, and a glide here would be the jump itself)
                if (Math.abs(now - before) >= 1) window.scrollBy({ top: now - before, left: 0, behavior: 'instant' });
            };
            settle();
            requestAnimationFrame(() => requestAnimationFrame(settle));
        }

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
            
            // An address without an epoch means the latest one. (The pool
            // page steps its own epochs and only sets the selector of the
            // main view: a main view drawn for a past epoch must not stay on
            // screen under a bar that says "latest".)
            const epochValue = (!epochParam || epochParam === 'latest') ? latestEpochNumber : epochParam;
            if (mainEpochSelect && epochMap.has(Number(epochValue))) {
                mainEpochSelect.value = epochValue;
                // Re-render only when the epoch differs from the one on screen,
                // so the validators list keeps its place. (Before the first
                // drawing of the main view there is nothing to compare with:
                // an address that names an epoch asks for it, a plain one waits.)
                const drawn = mainRenderedEpoch !== null || !!epochParam;
                if (drawn && Number(mainRenderedEpoch) !== Number(epochValue)) mainEpochSelect.dispatchEvent(new Event('change'));
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
                        poolStake: groupData,
                        groups: resolvedGroups
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
            
            // Narrow screens show a short number (1.67M SOL); the exact one
            // is in the card's tooltip while the short form is on screen.
            const setPoolMetric = (id, label, sol, sign) => {
                const el = document.getElementById(id);
                if (!el) return;
                el.innerHTML = (sol > 0 || !sign)
                    ? sign + '<span class="cv-num-full">' + formatNumber(sol) + '</span><span class="cv-num-short">' + shortSol(sol) + '</span><small class="cv-unit"> SOL</small>'
                    : '0<small class="cv-unit"> SOL</small>';
                // (nothing on the move: a quiet "0", not a green or a red one)
                el.classList.toggle('is-zero', !!sign && !(sol > 0));
                const cardEl = el.closest('.pool-metric-card');
                if (cardEl) {
                    cardEl.setAttribute('data-cv-tip', label + ': ' + formatNumber(sol, 2) + ' SOL');
                    cardEl.setAttribute('data-cv-tip-when', 'short');
                }
            };
            setPoolMetric('pool-metric-stake', 'Active stake', activeSol, '');
            document.getElementById('pool-metric-validators').textContent = poolStats.validator_count;
            setPoolMetric('pool-metric-activating', 'Activating', activatingSol, '+');
            setPoolMetric('pool-metric-deactivating', 'Deactivating', deactivatingSol, '-');
            
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
            // A key is a chip (the sign, the kind, the key: a click copies
            // it, as the keys of a validator do) and a small link that opens
            // its stake accounts in Solscan.
            const renderKeyItem = (key, type) => {
                const keyItem = document.createElement('div');
                keyItem.className = 'authority-key-item cv-authkey';
                keyItem.innerHTML = keyChipHtml(type, type, key, 'key-identity') +
                    '<a class="cv-key-link" href="https://solscan.io/account/' + encodeURIComponent(key) + '#stakeAccounts" target="_blank" rel="noopener"' +
                    cvHoverTip('Open in Solscan') + ' aria-label="' + escapeHtml('Open the ' + type.toLowerCase() + ' key in Solscan') +
                    '"><i class="fas fa-arrow-up-right-from-square" aria-hidden="true"></i></a>';
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
                    const formattedValue = type === 'validators' 
                        ? point.value 
                        : new Intl.NumberFormat('en-US').format(point.value);
                    tooltip.innerHTML = `<span class="epoch">Epoch ${point.epoch}:</span> ${formattedValue}${tooltipSuffix}`;
                    // (inside the chart - the tooltip keeps its place, unseen,
                    // after the pointer has left: see cvChartTipLeft)
                    tooltip.style.left = `${cvChartTipLeft(tooltip, point.x, width)}px`;
                    tooltip.style.top = `${point.y - 25}px`;
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
            // Reset stands in the title row while some validators are switched off.
            const resetEl = document.getElementById('pool-donut-reset');
            if (resetEl) {
                resetEl.hidden = hiddenValidatorKeys.size === 0;
                resetEl.onclick = () => {
                    resetHiddenValidators();
                    renderStakeDistributionChart(validators, searchQuery);
                };
            }
            
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
                scrollHint(legendContainer);
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
                const rawName = cleanText(v.info?.name).trim();
                return {
                    name: hasRealName(rawName) ? rawName : shortenPubkey(rawName || v.info?.vote_pubkey),
                    voteKey: v.info?.vote_pubkey || '',
                    identity: v.info?.identity_pubkey || '',
                    iconUrl: isValidHttpUrl(v.info?.icon_url || '') ? v.info.icon_url : '',
                    value: lamportsToSol(v.poolStake?.active_lamports || 0),
                    color: gradient.mainColor,
                    gradient,
                    hidden: hiddenValidatorKeys.has(v.info?.vote_pubkey)
                };
            });
            // A row of the legend: the colour, the logo, the name, the share
            // and the amount (as in the legend of a validator page). A row
            // that is switched off keeps its place, struck through.
            const legendRowHtml = (item, seg) => {
                const avatar = item.voteKey === 'others'
                    ? '<span class="cv-flow-logo is-icon legend-avatar"><i class="fas fa-ellipsis" aria-hidden="true"></i></span>'
                    : '<span class="cv-flow-logo cv-vd-mini legend-avatar">' + ((item.iconUrl && !brokenImages.has(item.iconUrl))
                        ? '<img class="validator-image" src="' + escapeHtml(item.iconUrl) + '" alt="" loading="lazy" data-fb-name="' +
                          escapeHtml(item.name) + '" data-fb-key="' + escapeHtml(item.identity) + '">'
                        : createFallbackImage(item.name, item.identity)) + '</span>';
                return '<div class="legend-item' + (item.hidden ? ' disabled' : '') + '" data-votekey="' + escapeHtml(item.voteKey) + '">' +
                    '<span class="legend-color" style="background-color: ' + item.color + ';"></span>' + avatar +
                    '<span class="legend-name" data-cv-tip="' + escapeHtml(item.name) + '" data-cv-tip-when="clipped">' + escapeHtml(item.name) + '</span>' +
                    '<span class="legend-share">' + (seg ? shareText(seg.percentage * 100) : '-') + '</span>' +
                    '<span class="legend-sol">' + (seg ? formatCompact(item.value) : '') + '</span></div>';
            };
            
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
            
            if (total === 0) {
                if (centerEl) centerEl.style.display = 'none';
                container.innerHTML = `
                    <div class="chart-no-data-container">
                        <div class="chart-no-data-text">No stake data</div>
                    </div>`;
                // (every validator is switched off: the legend stays, so one of them can be switched on again)
                legendContainer.innerHTML = allChartData.map(item => legendRowHtml(item, null)).join('');
                legendContainer.querySelectorAll('.legend-item').forEach(item => {
                    item.addEventListener('click', () => {
                        hiddenValidatorKeys.delete(item.dataset.votekey);
                        renderStakeDistributionChart(validators, searchQuery, false);
                    });
                });
                scrollHint(legendContainer);
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
            
            legendContainer.innerHTML = allChartData.map(item =>
                legendRowHtml(item, item.hidden ? null : segments.find(s => s.voteKey === item.voteKey))).join('');
            legendContainer.querySelectorAll('img.validator-image').forEach(img => {
                if (img.complete && img.naturalHeight === 0) {
                    window.handleValidatorImage(img, img.dataset.fbName || '', img.dataset.fbKey || '');
                }
            });
            scrollHint(legendContainer);
            
            // Інтерактивність
            const tooltip = container.querySelector('.distribution-tooltip');
            const svgSegments = container.querySelectorAll('.donut-segment');
            const legendItems = legendContainer.querySelectorAll('.legend-item');
            
            function showTooltip(seg, x, y) {
                tooltip.innerHTML = `
                    <div class="tooltip-name" style="color: ${seg.color};">${escapeHtml(seg.name)}</div>
                    <div class="tooltip-value">${formatValue(seg.value)} SOL (${(seg.percentage * 100).toFixed(1)}%)</div>
                `;
                tooltip.style.opacity = '1';
                tooltip.style.left = `${cvPointerTipLeft(tooltip, container, x)}px`;
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
                    tooltip.style.left = `${cvPointerTipLeft(tooltip, container, e.clientX - rect.left)}px`;
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
        
        // The epoch the ages of the page are counted at.
        function poolAgeEpoch() {
            const value = (document.getElementById('pool-epoch-select') || {}).value;
            return value ? Number(value) : Number(latestEpochNumber);
        }
        // Snapshots before epoch 1043 carry no ages: the validators index
        // has them. It is asked for once, and the list is put in order again
        // when it arrives (the details of a bubble read it when they open).
        function ensureIndexForPoolAges() {
            if (cvIndexData || poolIndexAsked) return;
            if (!poolValidators.some(v => !(v.meta && typeof v.meta.validator_age === 'number'))) return;
            poolIndexAsked = true;
            loadValidatorsIndex().then(index => {
                poolIndexAsked = false;
                if (!index || !currentPoolGroup || poolValidatorsView !== 'list' || poolDetailSortMode !== 'age') return;
                sortPoolValidators();
                renderPoolValidatorsTable();
            });
        }

        // Сортування валідаторів пулу
        function sortPoolValidators() {
            const asc = poolDetailSortOrder === 'asc';
            const amount = {
                'pool-stake': v => v.poolStake.active_lamports || 0,
                'total-stake': v => v.totals.total_active_lamports || 0,
                activating: v => v.poolStake.activating_lamports || 0,
                deactivating: v => v.poolStake.deactivating_lamports || 0
            }[poolDetailSortMode];
            const min = (poolDetailSortMode === 'activating' || poolDetailSortMode === 'deactivating') ? MIN_ACTIVE_STAKE : 0;
            // Age: oldest vote accounts first, a second click flips the
            // order, unknown ages stay at the end (as in the validators list).
            const byAge = poolDetailSortMode === 'age';
            const ages = new Map();
            if (byAge) {
                const at = poolAgeEpoch();
                poolValidators.forEach(v => { const a = cvListAge(v, at); ages.set(v, a ? a.value + 1 : 0); });
                ensureIndexForPoolAges();
            }
            poolValidators.sort((a, b) => {
                if (byAge) return sortCmp(ages.get(a), ages.get(b), asc) || ((b.poolStake.active_lamports || 0) - (a.poolStake.active_lamports || 0));
                if (amount) return sortCmp(amount(a), amount(b), asc, min);
                if (poolDetailSortMode !== 'name') return 0;
                const nameA = (a.info.name || a.info.vote_pubkey || '').toLowerCase();
                const nameB = (b.info.name || b.info.vote_pubkey || '').toLowerCase();
                const result = nameA.localeCompare(nameB);
                return asc ? -result : result;
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
            // The notes that stood here are gone, like on the main page: the
            // counting rule is in the Documentation and the bar under the
            // header marks a past epoch.
            const container = document.getElementById('pool-validators-info-notes');
            if (container) container.innerHTML = '';
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
            // On the map every bubble is in sight at once, so the card says
            // how many validators are drawn while the map holds fewer of them
            // (the list is read from the top and needs no such note). The
            // note stands after the label, or under it where the card is narrow.
            const onMapText = (poolValidatorsView === 'bubbles' && visibleCount > poolRowsVisible)
                ? '<span class="cv-stat-onmap">' + poolRowsVisible + ' on<span class="cv-stat-the"> the</span> map</span>' : '';
            const forCountText = isFiltered ? ` · ${visibleCount} shown` : '';
            
            // The cards do not repeat the pool's name; their tooltips say it,
            // with the pool's logo, on a line of its own.
            const poolTip = (lead) => cvRich('<div class="cv-tip-lead">' + lead + '</div><div class="pool-tooltip-title cv-tip-pool">' +
                cvMiniLogoHtml(isValidHttpUrl(poolImage) ? resolveLogoUrlSync(poolImage, isDarkStatCard) : '', poolLongName, currentPoolGroup) +
                '<span>' + escapeHtml(poolLongName) + '</span></div>');
            container.innerHTML = `
                <div class="pool-validators-stat-card"${poolTip('Validators with stake from')}>
                    <div class="stat-icon">${poolIconHtml}</div>
                    <div class="stat-info">
                        <div class="stat-value">${visibleCount}</div>
                        <div class="stat-label${onMapText ? ' cv-stat-parts' : ''}"><span class="cv-stat-what">Validators${poolSearchQuery ? ` <span class="cv-stat-of">(of ${totalCount})</span>` : ''}</span>${onMapText} ${epochNote}</div>
                    </div>
                </div>
                <div class="pool-validators-stat-card"${poolTip('Active stake on these validators from')}>
                    <div class="stat-icon stat-icon-plain">${cardIco('active-stake')}</div>
                    <div class="stat-info">
                        <div class="stat-value"${shortTipAttr('Pool stake', lamportsToSol(totalPoolStake))}>${numPairHtml(lamportsToSol(totalPoolStake), 1)}</div>
                        <div class="stat-label">Pool stake${forCountText} ${epochNote}</div>
                    </div>
                </div>
                <div class="pool-validators-stat-card">
                    <div class="stat-icon stat-icon-plain">${cardIco('activating')}</div>
                    <div class="stat-info">
                        <div class="stat-value"${shortTipAttr('Activating', lamportsToSol(totalActivatingStake))}>${numPairHtml(lamportsToSol(totalActivatingStake), 1)}</div>
                        <div class="stat-label">Activating${forCountText} ${epochNote}</div>
                    </div>
                </div>
                <div class="pool-validators-stat-card">
                    <div class="stat-icon stat-icon-plain">${cardIco('deactivating')}</div>
                    <div class="stat-info">
                        <div class="stat-value"${shortTipAttr('Deactivating', lamportsToSol(totalDeactivatingStake))}>${numPairHtml(lamportsToSol(totalDeactivatingStake), 1)}</div>
                        <div class="stat-label">Deactivating${forCountText} ${epochNote}</div>
                    </div>
                </div>
            `;
        }
        
        // Оновлення панелі сортування для валідаторів пулу
        function updatePoolValidatorsSortBar() {
            const sortBar = document.getElementById('pool-validators-sort-bar');
            if (!sortBar || !currentPoolGroup) return;
            // (the map of bubbles has no order to choose: the sizes say it)
            if (poolValidatorsView === 'bubbles') { sortBar.innerHTML = ''; return; }
            
            const poolDef = latestPoolDefinitions.find(p => p.group === currentPoolGroup);
            const poolImage = poolDef?.image || '';
            
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
                `<img src="${resolvedSortImage}" data-logo-default="${poolImage}" class="pool-icon" alt="">` : 
                `<i class="fas fa-layer-group" aria-hidden="true"></i>`;
            
            const item = (key, lead, label) => ({ attr: ' data-sort="' + key + '"', lead, label, active: poolDetailSortMode === key, dir: true });
            const fa = name => '<i class="fas ' + name + '" aria-hidden="true"></i>';
            // The stake in this pool goes first: it is what the page is about.
            sortBarRender(sortBar, [item('pool-stake', poolIconHtml, 'Stake in this pool'), item('total-stake', fa('fa-database'), 'Total stake'),
                item('activating', fa('fa-arrow-trend-up'), 'Activating'), item('deactivating', fa('fa-arrow-trend-down'), 'Deactivating'),
                item('age', fa('fa-hourglass-half'), 'Age'), item('name', fa('fa-arrow-down-a-z'), 'Name')],
                poolDetailSortOrder, pastEpochBadge);
            
            // Додаємо обробники для кнопок сортування
            sortBar.querySelectorAll('.sort-btn').forEach(btn => {
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
            // (a map of bubbles that is about to be replaced: its tooltip
            // kept open by a click goes with it, and so does its watch)
            if (cvPinnedTip && cvPinnedTip.__card && container.contains(cvPinnedTip.__card)) cvVdUnpinTip();
            if (poolBubblesMap) {
                if (cvBubblesWatch) cvBubblesWatch.unobserve(poolBubblesMap);
                if (cvBubblesSeen) cvBubblesSeen.unobserve(poolBubblesMap);
                poolBubblesMap = null;
            }
            document.querySelectorAll('#pool-validators-view-toggle button').forEach(b =>
                b.classList.toggle('active', b.getAttribute('data-view') === poolValidatorsView));
            
            // A long pool opens with its first hundred validators and "Show
            // More" adds the next hundred, in the list and on the map alike.
            // Another pool, search, order or view starts from the top; another
            // epoch keeps the number on screen, and with it the place on the page.
            const listKey = [currentPoolGroup, poolSearchQuery, poolDetailSortMode, poolDetailSortOrder, poolValidatorsView].join('|');
            if (listKey !== poolRowsFor) {
                poolRowsFor = listKey;
                poolRowsVisible = VALIDATORS_PER_PAGE;
            }

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
            
            // A row is a line of tiles: who the validator is, its total stake
            // with the small logos of its other stakers, and three tiles of
            // this pool (the arrows carry the small logo of the pool, so the
            // stake on the move reads as the stake of this pool).
            const poolDef = latestPoolDefinitions.find(p => p.group === currentPoolGroup);
            const epochValue = (document.getElementById('pool-epoch-select') || {}).value;
            const pastEpoch = (epochValue && Number(epochValue) !== Number(latestEpochNumber)) ? epochValue : null;
            const moreHtml = () => displayValidators.length > poolRowsVisible
                ? '<div class="validators-load-more-container"><button type="button" class="validators-load-more-btn" id="pool-rows-more">' +
                  '<i class="fas fa-plus-circle" aria-hidden="true"></i> Show More (' + (displayValidators.length - poolRowsVisible) + ' remaining)</button></div>'
                : '';
            if (poolValidatorsView === 'bubbles') {
                // The map: the validators of the page as bubbles, the largest
                // first (the engine puts the first bubble in the middle).
                poolBubblesTotal = poolValidators.reduce((a, v) => a + (v.poolStake.active_lamports || 0), 0);
                const shown = displayValidators.slice().sort((a, b) => cvPoolBubWeight(b) - cvPoolBubWeight(a)).slice(0, poolRowsVisible);
                // (a map of more than forty bubbles arrives quickly; up to
                // CV_BUBBLES_SWAY bubbles sway, a larger map stands still)
                container.innerHTML = '<div class="cv-bmap cv-pbmap' + (shown.length > CV_BUBBLES_SWAY ? ' is-many' : (shown.length > 40 ? ' is-crowd' : '')) + '" data-fit="1">' +
                    cvPoolBubblesHtml(shown) + '</div>' + moreHtml();
                const map = container.querySelector('.cv-bmap');
                cvBubblesLayout(map);
                // (the details of a bubble say the age: an old epoch reads it from the validators index)
                if (!cvIndexData && shown.some(v => !(v.meta && typeof v.meta.validator_age === 'number'))) loadValidatorsIndex();
                poolBubblesMap = map;
                if (cvBubblesWatch) cvBubblesWatch.observe(map);
                if (cvBubblesSeen) cvBubblesSeen.observe(map);
                container.onclick = (e) => {
                    const t = e.target;
                    if (!t || !t.closest) return;
                    if (t.closest('#pool-rows-more')) {
                        poolRowsVisible += VALIDATORS_PER_PAGE;
                        renderPoolValidatorsTable();
                        return;
                    }
                    const bub = t.closest('[data-cv-pbub]');
                    if (bub) cvVdPinTip(bub);
                };
                return;
            }
            const vrowIco = name => cardIco(name);
            const poolLogoOf = { name: currentPoolGroup, def: poolDef || cvSourceDef(currentPoolGroup) };
            const poolSign = '<span class="cv-vrow-sign">' + cvSourceLogoMini(poolLogoOf, 96) + '</span>';
            const poolMark = '<span class="cv-vrow-mark">' + cvSourceLogoMini(poolLogoOf) + '</span>';
            const flowSign = name => '<span class="cv-vrow-flowsign is-' + name + '">' + poolMark + cardIco(name) + '</span>';
            // The tiles of the pool show no name: the tooltip of each one
            // names its measure and gives the whole amount.
            const tileTip = (label, lamports) => {
                const sol = lamportsToSol(lamports || 0);
                return label + (pastEpoch ? ' in epoch ' + pastEpoch : '') + ': ' + (sol >= 0.005 ? formatNumber(sol, 2) : '0') + ' SOL';
            };
            const onlyHere = currentPoolGroup === 'OTHER' ? 'No pools or programs' : 'Only staked by this pool';
            const cellHtml = (cls, sign, c) => '<div class="' + cls + (c.zero ? ' is-zero' : '') + '"' +
                (c.tip ? ' data-cv-tip="' + escapeHtml(c.tip) + '"' : '') + '>' + sign +
                '<span class="cv-cell-text"><b' + (c.cls ? ' class="' + c.cls + '"' : '') + '>' + c.value + '</b><small>' + c.label + '</small></span></div>';
            // Up to five places for the other stakers: five logos, or four
            // and "+N". Their tooltips are built on demand (showAlsoTip).
            const othersHtml = (validator) => {
                const others = poolRowOthers(validator);
                if (others.length === 0) return '<div class="cv-vrow-others is-none"><small>' + onlyHere + '</small></div>';
                const shown = others.length > POOL_ROW_OTHERS ? POOL_ROW_OTHERS - 1 : others.length;
                return '<div class="cv-vrow-others"><small>Also staked by</small><span class="cv-vrow-logos" data-vote="' +
                    escapeHtml(validator.info.vote_pubkey || '') + '">' +
                    others.slice(0, shown).map((g, i) => '<span class="cv-vrow-other" data-cv-also="' + i + '">' +
                        cvSourceLogoMini({ name: g.name, def: cvSourceDef(g.name) }) + '</span>').join('') +
                    (others.length > shown ? '<span class="cv-vrow-more" data-cv-also="more">+' + (others.length - shown) + '</span>' : '') +
                    '</span></div>';
            };

            const ageEpoch = poolAgeEpoch();
            const rowHtml = (validator) => {
                const rawName = cleanText(validator.info.name).trim();
                const realName = hasRealName(rawName);
                const name = realName ? rawName : shortenPubkey(rawName || validator.info.vote_pubkey);
                const nameHtml = escapeHtml(name);
                const vHref = escapeHtml(validatorHref(validator.info.vote_pubkey, epochValue));

                // Avatar
                const rawImageUrl = validator.info?.icon_url || '';
                const imageUrl = isValidHttpUrl(rawImageUrl) ? rawImageUrl : '';
                const identityPubkey = validator.info?.identity_pubkey || '';
                const votePubkey = validator.info?.vote_pubkey || '';
                const isKnownBroken = brokenImages.has(imageUrl);
                const isDelinquent = !!(validator.meta && validator.meta.delinquent === true);
                // "New" and "leaving": all the stake of this pool with the
                // validator arrives or leaves (the dashed outline and the
                // word of the other views; the word stands at the end of
                // the name line, the corner of the tile of the validator,
                // so the chips and the keys keep their places).
                const ring = poolBadgeRing(validator.poolStake.active_lamports || 0, validator.poolStake.activating_lamports || 0,
                    validator.poolStake.deactivating_lamports || 0);
                const state = ring.activatingOnly ? 'new' : (ring.cls === ' is-exiting' ? 'leaving' : '');
                const stateHtml = state ? '<span class="cv-state is-' + state + '" data-cv-tip="All pool stake here is ' +
                    (state === 'new' ? 'activating' : 'deactivating') + '">' + state + '</span>' : '';
                const chipsHtml = buildMetaChipsHtml(validator.meta, poolScriptInfo);
                const metaHtml = poolDetailSortMode === 'age' ? cvWithAgeChip(chipsHtml, cvListAge(validator, ageEpoch)) : chipsHtml;

                const avatarHtml = (imageUrl && !isKnownBroken) ?
                    `<div class="validator-image-wrapper">
                        <img class="validator-image" src="${escapeHtml(imageUrl)}" alt="${nameHtml}" loading="lazy"
                            data-fb-name="${nameHtml}" data-fb-key="${escapeHtml(identityPubkey)}">
                    </div>` :
                    `<div class="validator-image-wrapper">
                        ${createFallbackImage(name, identityPubkey)}
                    </div>`;

                const total = flowCell('active-stake', 'Total stake', validator.totals.total_active_lamports, pastEpoch);
                const inPool = flowCell('', 'In this pool', validator.poolStake.active_lamports, pastEpoch);
                inPool.tip = tileTip('Stake in this pool', validator.poolStake.active_lamports);
                const activating = flowCell('activating', 'Activating', validator.poolStake.activating_lamports, pastEpoch);
                const deactivating = flowCell('deactivating', 'Deactivating', validator.poolStake.deactivating_lamports, pastEpoch);
                activating.tip = tileTip('Activating in this pool', validator.poolStake.activating_lamports);
                deactivating.tip = tileTip('Deactivating in this pool', validator.poolStake.deactivating_lamports);

                return `
                    <div class="cv-vrow${isDelinquent ? ' is-delinquent' : ''}${state ? ' is-' + state : ''}">
                        <div class="cv-vrow-who">
                            <span class="pv-rank" data-cv-tip="Rank by stake in this pool, of ${poolValidators.length}">#${poolRankByVote.get(validator.info.vote_pubkey) || '-'}</span>
                            <a class="cv-vlink cv-vlink-avatar" data-cv-nav href="${vHref}" tabindex="-1" aria-hidden="true">${avatarHtml}</a>
                            <div class="cv-vrow-name cv-name-line">
                                <a class="cv-name-text cv-vlink" data-cv-nav href="${vHref}" data-cv-tip="${nameHtml}" data-cv-tip-when="clipped">${nameHtml}${CV_GO_SVG}</a>
                                ${realName ? copyButtonHtml(rawName, 'Copy name') : ''}${stateHtml}
                            </div>
                            <div class="cv-vrow-sub cv-chipline">${metaHtml}${validatorKeySignsHtml(identityPubkey, votePubkey)}</div>
                        </div>
                        <div class="cv-vrow-cells">
                            <div class="cv-vrow-total">${cellHtml('cv-head', vrowIco('active-stake'), total)}${othersHtml(validator)}</div>
                            ${cellHtml('cv-head cv-vrow-in', poolSign, inPool)}
                            ${cellHtml('cv-cell cv-vrow-flow', flowSign('activating'), activating)}
                            ${cellHtml('cv-cell cv-vrow-flow', flowSign('deactivating'), deactivating)}
                        </div>
                    </div>
                `;
            };

            const rowsHtml = (from, to) => displayValidators.slice(from, to).map(rowHtml).join('');
            // Images that failed before the error listener could see them.
            const checkImages = () => container.querySelectorAll('img.validator-image').forEach(img => {
                if (img.complete && img.naturalHeight === 0) {
                    window.handleValidatorImage(img, img.dataset.fbName || '', img.dataset.fbKey || '');
                }
            });
            container.innerHTML = '<div class="cv-vrows">' + rowsHtml(0, poolRowsVisible) + '</div>' + moreHtml();
            checkImages();
            container.onclick = (e) => {
                const btn = e.target && e.target.closest ? e.target.closest('#pool-rows-more') : null;
                if (!btn) return;
                const from = poolRowsVisible;
                poolRowsVisible += VALIDATORS_PER_PAGE;
                btn.parentElement.remove();
                container.querySelector('.cv-vrows').insertAdjacentHTML('beforeend', rowsHtml(from, poolRowsVisible));
                container.insertAdjacentHTML('beforeend', moreHtml());
                checkImages();
            };
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
        
        // The switch of the view: a list of rows or a map of bubbles.
        const poolViewToggle = document.getElementById('pool-validators-view-toggle');
        if (poolViewToggle) {
            poolViewToggle.addEventListener('click', (e) => {
                const btn = e.target && e.target.closest ? e.target.closest('button[data-view]') : null;
                if (!btn) return;
                const view = btn.getAttribute('data-view') === 'bubbles' ? 'bubbles' : 'list';
                if (view === poolValidatorsView) return;
                poolValidatorsView = view;
                safeStorage.setItem('poolValidatorsView', view);
                renderPoolValidatorsTable();
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