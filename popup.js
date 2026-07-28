// Popup: global on/off, per-site exception for the active tab, blocked count.
// Writes to chrome.storage.sync only; the worker rebuilds the rules from there.

const globalToggle = document.getElementById('globalToggle');
const globalState = document.getElementById('globalState');
const siteToggle = document.getElementById('siteToggle');
const siteRow = document.getElementById('siteRow');
const hostnameEl = document.getElementById('hostname');
const countEl = document.getElementById('count');

let activeTab = null;
let host = '';

/** Registrable hostname of a tab URL, or '' for pages we can never act on. */
function hostOf(url) {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

/** True when `hostname` is covered by an entry in the excluded list, subdomains included. */
function isExcluded(list, hostname) {
    return list.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

// The worker writes every count through to storage.session, which extension
// pages can read directly.
async function loadCount() {
    if (!activeTab) return;
    const key = `blocked:${activeTab.id}`;
    const stored = await chrome.storage.session.get(key);
    countEl.textContent = stored[key] ?? 0;
}

async function render() {
    const { enabled = true, excludedDomains = [] } = await chrome.storage.sync.get([
        'enabled',
        'excludedDomains',
    ]);

    globalToggle.checked = enabled;
    globalState.textContent = enabled ? 'on' : 'off — nothing is blocked';

    if (host) {
        hostnameEl.textContent = host;
        siteToggle.checked = isExcluded(excludedDomains, host);
        siteRow.classList.toggle('off', !enabled);
    } else {
        hostnameEl.textContent = 'Not a web page';
        siteToggle.checked = false;
        siteRow.classList.add('off');
    }

    await loadCount();
}

globalToggle.addEventListener('change', async () => {
    await chrome.storage.sync.set({ enabled: globalToggle.checked });
    await render();
});

siteToggle.addEventListener('change', async () => {
    if (!host) return;
    const { excludedDomains = [] } = await chrome.storage.sync.get('excludedDomains');
    const next = siteToggle.checked
        ? [...new Set([...excludedDomains, host])]
        // Drop every entry that covers this host, parent domains included —
        // otherwise a site excluded via "example.com" could never be re-enabled
        // from a "sub.example.com" page.
        : excludedDomains.filter(
              (domain) => domain !== host && !host.endsWith(`.${domain}`),
          );
    await chrome.storage.sync.set({ excludedDomains: next });
    await render();
    // Rules only apply to requests made after they land, so reload to show it.
    if (activeTab) chrome.tabs.reload(activeTab.id);
});

document.getElementById('openOptions').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
});

(async function init() {
    [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    host = hostOf(activeTab?.url);
    await render();
})();
