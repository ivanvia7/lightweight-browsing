/**
 * Options page: global switch, per-category switches, excluded-site list and
 * custom blocklist. Writes to chrome.storage.sync only — the service worker
 * turns the settings into declarativeNetRequest rules.
 */

const CATEGORY_LABELS = {
    analytics: ['Analytics', 'Google Analytics, Tag Manager, Segment, Mixpanel, Amplitude, HubSpot'],
    ads: ['Ads', 'DoubleClick, Google Ads, Meta Pixel, LinkedIn, TikTok, Bing UET, Criteo, Taboola'],
    'chat-widgets': ['Chat widgets', 'Intercom, Drift, Zendesk, Tawk.to, LiveChat, Crisp'],
    'session-recording': ['Session recording', 'Hotjar, Microsoft Clarity, FullStory, LogRocket, Smartlook'],
    fonts: [
        'Web fonts (off by default)',
        'Google Fonts, Typekit, Monotype, Bunny — pages fall back to system fonts. Icon fonts keep working',
    ],
    'icon-fonts': [
        'Icon fonts (off by default)',
        'Font Awesome, Material Icons, Iconfont — icons render as empty boxes or blank space',
    ],
    'small-images': [
        'Small images (off by default)',
        'Third-party avatars and favicons under 100 px, matched by the size in the URL. Saves requests, not much bandwidth, and can misfire on small content images',
    ],
};

// Mirrors DEFAULT_OFF in background.js: a category with nothing stored yet is on
// unless it is listed here.
const DEFAULT_OFF = ['fonts', 'icon-fonts', 'small-images'];

/** Same normalisation as background.js so storage never holds a bad entry. */
function normalizeDomain(input) {
    let value = String(input || '').trim().toLowerCase();
    if (!value) return '';
    value = value.replace(/^[a-z]+:\/\//, '');
    value = value.split('/')[0].split('?')[0].split(':')[0];
    value = value.replace(/^\*\./, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return '';
    return value;
}

/** One reusable domain-list widget: add, remove, search. */
function domainList({ storageKey, listEl, inputEl, addButton, searchEl, errorEl }) {
    let domains = [];
    let filter = '';

    function paint() {
        const visible = domains.filter((domain) => domain.includes(filter));
        listEl.replaceChildren();

        if (!visible.length) {
            const empty = document.createElement('li');
            empty.className = 'empty';
            empty.textContent = domains.length ? 'No match.' : 'Nothing here yet.';
            listEl.append(empty);
            return;
        }

        visible.forEach((domain) => {
            const item = document.createElement('li');
            const name = document.createElement('span');
            name.textContent = domain;
            const remove = document.createElement('button');
            remove.className = 'remove';
            remove.textContent = 'Remove';
            remove.title = `Remove ${domain}`;
            remove.addEventListener('click', () => save(domains.filter((d) => d !== domain)));
            item.append(name, remove);
            listEl.append(item);
        });
    }

    async function save(next) {
        domains = [...new Set(next)].sort();
        await chrome.storage.sync.set({ [storageKey]: domains });
        paint();
    }

    async function add() {
        errorEl.textContent = '';
        const domain = normalizeDomain(inputEl.value);
        if (!domain) {
            errorEl.textContent = 'Enter a domain like example.com';
            return;
        }
        if (domains.includes(domain)) {
            errorEl.textContent = `${domain} is already in the list.`;
            return;
        }
        inputEl.value = '';
        await save([...domains, domain]);
    }

    addButton.addEventListener('click', add);
    inputEl.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') add();
    });
    searchEl.addEventListener('input', () => {
        filter = searchEl.value.trim().toLowerCase();
        paint();
    });

    return {
        set(next) {
            domains = [...next].sort();
            paint();
        },
    };
}

function renderCategories(categories) {
    const container = document.getElementById('categories');
    container.replaceChildren();

    Object.entries(CATEGORY_LABELS).forEach(([key, [title, examples]]) => {
        const row = document.createElement('div');
        row.className = 'item';

        const text = document.createElement('div');
        const name = document.createElement('div');
        name.textContent = title;
        const desc = document.createElement('div');
        desc.className = 'desc';
        desc.textContent = examples;
        text.append(name, desc);

        const label = document.createElement('label');
        label.className = 'switch';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = categories[key] ?? !DEFAULT_OFF.includes(key);
        input.addEventListener('change', async () => {
            const { categories: current = {} } = await chrome.storage.sync.get('categories');
            await chrome.storage.sync.set({
                categories: { ...current, [key]: input.checked },
            });
        });
        label.append(input, document.createElement('span'));

        row.append(text, label);
        container.append(row);
    });
}

const excluded = domainList({
    storageKey: 'excludedDomains',
    listEl: document.getElementById('excludedList'),
    inputEl: document.getElementById('excludedInput'),
    addButton: document.getElementById('excludedAdd'),
    searchEl: document.getElementById('excludedSearch'),
    errorEl: document.getElementById('excludedError'),
});

const custom = domainList({
    storageKey: 'customDomains',
    listEl: document.getElementById('customList'),
    inputEl: document.getElementById('customInput'),
    addButton: document.getElementById('customAdd'),
    searchEl: document.getElementById('customSearch'),
    errorEl: document.getElementById('customError'),
});

const enabledToggle = document.getElementById('enabled');
enabledToggle.addEventListener('change', () => {
    chrome.storage.sync.set({ enabled: enabledToggle.checked });
});

async function load() {
    const stored = await chrome.storage.sync.get([
        'enabled',
        'categories',
        'excludedDomains',
        'customDomains',
    ]);
    enabledToggle.checked = stored.enabled !== false;
    renderCategories(stored.categories || {});
    excluded.set(stored.excludedDomains || []);
    custom.set(stored.customDomains || []);
}

// Keep the page truthful when the popup (or another device) changes something.
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if ('enabled' in changes) enabledToggle.checked = changes.enabled.newValue !== false;
    if ('categories' in changes) renderCategories(changes.categories.newValue || {});
    if ('excludedDomains' in changes) excluded.set(changes.excludedDomains.newValue || []);
    if ('customDomains' in changes) custom.set(changes.customDomains.newValue || []);
});

load();
