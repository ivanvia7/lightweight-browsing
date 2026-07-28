/**
 * Lightweight Browsing — service worker.
 *
 * Owns everything that mutates the blocking engine:
 *   - static rulesets (one per tracker category) enabled/disabled via updateEnabledRulesets
 *   - dynamic rules: per-site allowlist exceptions + the user's custom blocklist
 *   - per-tab blocked-request counter + toolbar badge
 *
 * Settings live in chrome.storage.sync so they follow the user across installs.
 * Counters live in chrome.storage.session (throwaway, per browser session).
 */

// Ruleset ids must match "declarative_net_request.rule_resources" in manifest.json.
const CATEGORIES = [
    'analytics',
    'ads',
    'chat-widgets',
    'session-recording',
    'fonts',
    'icon-fonts',
    'small-images',
];

// These categories start off: they change how pages look rather than only what
// they phone home. "fonts" keeps icon fonts working via allow rules, so enabling
// "icon-fonts" too is what turns Font Awesome and Material Icons into empty
// boxes. "small-images" guesses from the URL and will occasionally guess wrong.
const DEFAULT_OFF = ['fonts', 'icon-fonts', 'small-images'];

// Dynamic rule id ranges. Kept far away from the static ranges (1000-4999) so the
// two never collide while debugging with getMatchedRules().
const ALLOWLIST_ID_BASE = 800000; // one "allowAllRequests" rule per excluded domain
const CUSTOM_ID_BASE = 900000; // one "block" rule per custom blocklist domain

// Resource types we ever block. main_frame is deliberately absent: blocking a
// top-level navigation would break the page instead of speeding it up.
const BLOCKED_RESOURCE_TYPES = [
    'script',
    'xmlhttprequest',
    'image',
    'ping',
    'sub_frame',
    'websocket',
    'other',
];

const DEFAULTS = {
    enabled: true,
    categories: Object.fromEntries(CATEGORIES.map((c) => [c, !DEFAULT_OFF.includes(c)])),
    excludedDomains: [], // sites where the extension does nothing
    customDomains: [], // extra third-party domains the user wants blocked
};

/** Read settings, filling in defaults for anything never written yet. */
async function getSettings() {
    const stored = await chrome.storage.sync.get(DEFAULTS);
    return {
        enabled: stored.enabled !== false,
        categories: { ...DEFAULTS.categories, ...(stored.categories || {}) },
        excludedDomains: Array.isArray(stored.excludedDomains) ? stored.excludedDomains : [],
        customDomains: Array.isArray(stored.customDomains) ? stored.customDomains : [],
    };
}

/** Turn "https://www.Example.com/x" or " Example.com " into "example.com". */
function normalizeDomain(input) {
    let value = String(input || '').trim().toLowerCase();
    if (!value) return '';
    value = value.replace(/^[a-z]+:\/\//, ''); // strip scheme
    value = value.split('/')[0]; // strip path
    value = value.split('?')[0];
    value = value.split(':')[0]; // strip port
    value = value.replace(/^\*\./, ''); // strip a leading wildcard label
    // Reject anything that is not a plausible hostname.
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return '';
    return value;
}

/** Enable exactly the rulesets the current settings ask for. */
async function syncRulesets() {
    const settings = await getSettings();
    const wanted = settings.enabled
        ? CATEGORIES.filter((category) => settings.categories[category])
        : [];

    // Enabling an already-enabled ruleset (or disabling a disabled one) is a
    // no-op, so the current state does not need reading first.
    await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: wanted,
        disableRulesetIds: CATEGORIES.filter((category) => !wanted.includes(category)),
    });
}

/**
 * Rebuild the dynamic rule set from scratch: allowlist exceptions first, then
 * the user's custom blocklist. Rebuilding wholesale keeps ids predictable and
 * avoids drift between storage and the engine.
 */
async function syncDynamicRules() {
    const settings = await getSettings();
    const rules = [];

    // Per-site exceptions. "allowAllRequests" on the document request means every
    // sub-request made by that page is exempt, which is what "disable on this
    // site" has to mean. Registered even when the extension is globally off so
    // the state is consistent; harmless because no block rules are active then.
    settings.excludedDomains.forEach((domain, index) => {
        const host = normalizeDomain(domain);
        if (!host) return;
        rules.push({
            id: ALLOWLIST_ID_BASE + index,
            priority: 100, // must beat every block rule, static and custom alike
            action: { type: 'allowAllRequests' },
            condition: {
                // requestDomains matches the document URL itself, and covers subdomains.
                requestDomains: [host],
                resourceTypes: ['main_frame', 'sub_frame'],
            },
        });
    });

    // Custom blocklist. Same third-party-only safety rule as the static files.
    if (settings.enabled) {
        settings.customDomains.forEach((domain, index) => {
            const host = normalizeDomain(domain);
            if (!host) return;
            rules.push({
                id: CUSTOM_ID_BASE + index,
                priority: 1, // same priority as the static block rules
                action: { type: 'block' },
                condition: {
                    urlFilter: `||${host}^`,
                    domainType: 'thirdParty',
                    resourceTypes: BLOCKED_RESOURCE_TYPES,
                },
            });
        });
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map((rule) => rule.id),
        addRules: rules,
    });
}

// One sync at a time. Two overlapping runs both read getDynamicRules() and then
// try to remove the same ids, and the loser rejects.
let syncing = Promise.resolve();

function syncAll() {
    syncing = syncing
        .then(() => syncRulesets())
        .then(() => syncDynamicRules())
        .catch((error) => console.error('Lightweight Browsing: rule sync failed', error));
    return syncing;
}

/* ------------------------------------------------------------------ counters */

const COUNT_KEY_PREFIX = 'blocked:';

// tabId -> blocked requests since that tab's last committed navigation. Counting
// happens here, in memory, because a read-modify-write through storage loses
// updates: a page that fires twenty blocked requests in one tick would have all
// twenty handlers read the same stored value and land on a count of one.
const counts = {};

// storage.session only survives the worker being idled out, so the map is
// seeded from it once and written through afterwards. Every counter path awaits
// this first, which also serialises the increments.
const restored = chrome.storage.session.get(null).then((stored) => {
    Object.entries(stored).forEach(([key, value]) => {
        if (key.startsWith(COUNT_KEY_PREFIX)) counts[key.slice(COUNT_KEY_PREFIX.length)] = value;
    });
});

async function getCount(tabId) {
    await restored;
    return counts[tabId] || 0;
}

/**
 * Deliberately synchronous: the map assignment must happen in the same tick as
 * the caller's read, or two handlers can interleave and one increment is lost.
 * The storage and badge writes are fire-and-forget.
 */
function setCount(tabId, count) {
    counts[tabId] = count;
    chrome.storage.session.set({ [COUNT_KEY_PREFIX + tabId]: count });
    chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {
        // Tab closed between the count and the badge write. Nothing to do.
    });
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#3b7d4f' }).catch(() => {});
}

/**
 * onRuleMatchedDebug only exists for unpacked extensions with the
 * "declarativeNetRequestFeedback" permission, which is exactly how this
 * extension is meant to be loaded. Without it the counter stays at 0; blocking
 * itself is unaffected.
 */
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
        const tabId = info.request.tabId;
        if (tabId < 0) return; // not attached to a tab (e.g. a worker request)
        if (info.rule.ruleId >= ALLOWLIST_ID_BASE && info.rule.ruleId < CUSTOM_ID_BASE) return;
        await restored;
        setCount(tabId, (counts[tabId] || 0) + 1); // read and write in one tick
    });
}

// Reset on a committed top-level navigation only. tabs.onUpdated with
// status === 'loading' fires several times per navigation, and a late one wipes
// trackers that were already blocked earlier in the same page load.
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
    if (frameId === 0) setCount(tabId, 0);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    delete counts[tabId];
    chrome.storage.session.remove(COUNT_KEY_PREFIX + tabId);
});

/* ------------------------------------------------------------------ plumbing */

chrome.runtime.onInstalled.addListener(async () => {
    // Write the defaults once so the options page has something concrete to show.
    const settings = await getSettings();
    await chrome.storage.sync.set(settings);
    await syncAll();
});

// Any settings change (popup, options page, or a sync from another install)
// re-derives the engine state. Single code path, no duplicated rule building.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const relevant = ['enabled', 'categories', 'excludedDomains', 'customDomains'];
    if (relevant.some((key) => key in changes)) syncAll();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'getCount') {
        getCount(message.tabId).then((count) => sendResponse({ count }));
        return true; // async response
    }
    return false;
});

// Runs on every worker start, browser startup included, so the engine state is
// re-asserted after the worker has been idled out.
syncAll();
