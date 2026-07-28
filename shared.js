// Shared by the service worker and the options page. Both load as ES modules:
// background.js via "type": "module", options.js via <script type="module">.

// Must match "declarative_net_request.rule_resources" in manifest.json.
export const CATEGORIES = [
    'analytics',
    'ads',
    'chat-widgets',
    'session-recording',
    'fonts',
    'icon-fonts',
    'small-images',
];

// Off by default: these change how a page looks, not only what it phones home.
export const DEFAULT_OFF = ['fonts', 'icon-fonts', 'small-images'];

/** Turn "https://www.Example.com/x" or " Example.com " into "example.com". */
export function normalizeDomain(input) {
    let value = String(input || '').trim().toLowerCase();
    if (!value) return '';
    value = value.replace(/^[a-z]+:\/\//, ''); // strip scheme
    value = value.split('/')[0].split('?')[0].split(':')[0]; // strip path, query, port
    value = value.replace(/^\*\./, ''); // strip a leading wildcard label
    // Reject anything that is not a plausible hostname.
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) return '';
    return value;
}
