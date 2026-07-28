// Service worker. Sole owner of every declarativeNetRequest mutation and of the
// per-tab blocked-request counter.

import { CATEGORIES, DEFAULT_OFF, normalizeDomain } from './shared.js';

// Dynamic ids sit far above the static ranges (1000-7999) so a matched rule is
// always traceable to its source.
const ALLOWLIST_ID_BASE = 800000;
const CUSTOM_ID_BASE = 900000;

// The icon-font exemptions in rules/fonts.json. They are allow rules, and an
// allow means nothing was blocked, so the counter has to skip them.
const ICON_ALLOW_ID_MIN = 5900;
const ICON_ALLOW_ID_MAX = 5999;

const ALLOWLIST_PRIORITY = 100; // must beat every block rule, static and custom
const BADGE_COLOR = '#3b7d4f';

// main_frame is deliberately absent: blocking a top-level navigation breaks the
// page rather than speeding it up.
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
    excludedDomains: [],
    customDomains: [],
};

// get(DEFAULTS) returns the default for every key the profile has never written.
function getSettings() {
    return chrome.storage.sync.get(DEFAULTS);
}

async function syncRulesets() {
    const settings = await getSettings();
    const wanted = settings.enabled
        ? CATEGORIES.filter((category) => settings.categories[category])
        : [];

    // Enabling an already-enabled ruleset is a no-op, so the current state does
    // not need reading first.
    await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: wanted,
        disableRulesetIds: CATEGORIES.filter((category) => !wanted.includes(category)),
    });
}

/**
 * "allowAllRequests" on the document exempts every sub-request that document
 * makes, which is what "disable on this site" has to mean. requestDomains
 * matches the document URL and covers subdomains.
 */
function allowlistRule(host, index) {
    return {
        id: ALLOWLIST_ID_BASE + index,
        priority: ALLOWLIST_PRIORITY,
        action: { type: 'allowAllRequests' },
        condition: {
            requestDomains: [host],
            resourceTypes: ['main_frame', 'sub_frame'],
        },
    };
}

function customBlockRule(host, index) {
    return {
        id: CUSTOM_ID_BASE + index,
        priority: 1,
        action: { type: 'block' },
        condition: {
            urlFilter: `||${host}^`,
            domainType: 'thirdParty',
            resourceTypes: BLOCKED_RESOURCE_TYPES,
        },
    };
}

/**
 * Rebuilt wholesale rather than patched: ids stay predictable and storage can
 * never drift from the engine. Allowlist rules are registered even when blocking
 * is globally off, which is harmless because no block rules are active then.
 */
async function syncDynamicRules() {
    const settings = await getSettings();
    const hosts = (domains) => domains.map(normalizeDomain).filter(Boolean);
    const rules = hosts(settings.excludedDomains).map(allowlistRule);

    if (settings.enabled) {
        rules.push(...hosts(settings.customDomains).map(customBlockRule));
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: existing.map((rule) => rule.id),
        addRules: rules,
    });
}

// One sync at a time. Two overlapping runs read getDynamicRules() and then try
// to remove the same ids, and the loser rejects.
let syncing = Promise.resolve();

function syncAll() {
    syncing = syncing
        .then(() => syncRulesets())
        .then(() => syncDynamicRules())
        .catch((error) => console.error('Lightweight Browsing: rule sync failed', error));
    return syncing;
}

const COUNT_KEY_PREFIX = 'blocked:';

// tabId -> blocked requests since that tab's last committed navigation. Held in
// memory because a read-modify-write through storage loses updates: twenty
// blocked requests in one tick would all read the same value and land on 1.
const counts = {};

// storage.session survives the worker being idled out, so the map is seeded from
// it once and written through afterwards. Every counter path awaits this.
const restored = chrome.storage.session.get(null).then((stored) => {
    Object.entries(stored).forEach(([key, value]) => {
        if (key.startsWith(COUNT_KEY_PREFIX)) counts[key.slice(COUNT_KEY_PREFIX.length)] = value;
    });
});

function isAllowRule(ruleId) {
    if (ruleId >= ICON_ALLOW_ID_MIN && ruleId <= ICON_ALLOW_ID_MAX) return true;
    return ruleId >= ALLOWLIST_ID_BASE && ruleId < CUSTOM_ID_BASE;
}

chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });

/**
 * Synchronous on purpose: the assignment has to land in the same tick as the
 * caller's read, or two handlers interleave and one increment is lost. The
 * storage and badge writes are fire-and-forget; the badge rejects on a tab that
 * closed in between, which needs no handling.
 */
function setCount(tabId, count) {
    counts[tabId] = count;
    chrome.storage.session.set({ [COUNT_KEY_PREFIX + tabId]: count });
    chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }).catch(() => {});
}

// onRuleMatchedDebug needs "declarativeNetRequestFeedback", which only unpacked
// extensions get. Packed, the counter stays at 0 and blocking is unaffected.
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(async (info) => {
        const tabId = info.request.tabId;
        if (tabId < 0) return; // no owning tab, e.g. a service-worker request
        if (isAllowRule(info.rule.ruleId)) return;
        await restored;
        setCount(tabId, (counts[tabId] || 0) + 1);
    });
}

// Committed navigations only. tabs.onUpdated with status 'loading' fires several
// times per navigation and a late one wipes trackers already blocked in the same
// load. The restore is awaited first, or it would put the old count back.
chrome.webNavigation.onCommitted.addListener(async ({ tabId, frameId }) => {
    if (frameId !== 0) return;
    await restored;
    setCount(tabId, 0);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    delete counts[tabId];
    chrome.storage.session.remove(COUNT_KEY_PREFIX + tabId);
});

// Single re-derivation path for the popup, the options page and a sync from
// another install.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const relevant = ['enabled', 'categories', 'excludedDomains', 'customDomains'];
    if (relevant.some((key) => key in changes)) syncAll();
});

// Re-asserts engine state on every worker start, browser startup included.
syncAll();
