/**
 * Constants and helpers used by both the service worker and the options page.
 * Imported as an ES module, so background.js is declared with "type": "module"
 * and options.html loads options.js with type="module".
 */

// Ruleset ids must match "declarative_net_request.rule_resources" in manifest.json.
export const CATEGORIES = [
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
