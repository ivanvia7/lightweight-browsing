# Lightweight Browsing

Chrome Manifest V3 extension that blocks well-known third-party tracking, analytics, ad and
session-recording requests so pages load faster. No remote rule lists, no remote code, no
network calls of its own — everything ships as static JSON in this folder.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the toolbar icon if you want the popup one click away.

Loading unpacked also grants `declarativeNetRequestFeedback`, which is what feeds the live
blocked-request counter (`onRuleMatchedDebug`). Blocking works either way; in a packed/store
build that permission is unavailable and the counter simply stays at 0.

The count is per tab and resets on each committed top-level navigation
(`webNavigation.onCommitted`, `frameId === 0`). Requests with no owning tab — service worker,
prerender and preload traffic — are blocked but not counted, because there is no tab to
attribute them to.

## Files

| File | Role |
| --- | --- |
| `manifest.json` | MV3 manifest, permissions, the seven static rulesets |
| `shared.js` | Category list, defaults and domain normalisation, imported by the worker and options page |
| `rules/analytics.json` | Analytics and product-telemetry domains |
| `rules/ads.json` | Ad networks, retargeting and conversion pixels |
| `rules/chat-widgets.json` | Support/chat widget and product-tour bundles |
| `rules/session-recording.json` | Session replay and heatmap trackers |
| `rules/fonts.json` | Third-party text-font CDNs, plus allow rules that spare icon fonts. **Off by default** |
| `rules/icon-fonts.json` | Icon-font CDNs (Font Awesome, Material Icons). **Off by default** |
| `rules/small-images.json` | Third-party avatars and favicons, matched on the size in the URL. **Off by default** |
| `background.js` | Service worker: rule syncing, dynamic rules, per-tab counter |
| `ui.css` | Theme variables and the switch component, shared by both pages |
| `popup.html` / `popup.js` | Global toggle, per-site exception, blocked count |
| `options.html` / `options.js` | Category toggles, excluded sites, custom blocklist |

## How it blocks

Every static rule has the same shape:

```json
{
  "id": 1001,
  "priority": 1,
  "action": { "type": "block" },
  "condition": {
    "urlFilter": "||google-analytics.com^",
    "domainType": "thirdParty",
    "resourceTypes": ["script", "xmlhttprequest", "image", "ping", "sub_frame", "websocket", "other"]
  }
}
```

Two safety properties come from that shape:

- `domainType: "thirdParty"` — a request is only blocked when its domain differs from the page's.
  First-party assets such as `console.apify.com/assets/*` can never match, so site functionality
  is left alone.
- `main_frame` is absent from `resourceTypes` — the extension never blocks a top-level navigation.

Rule ids are allocated per category so a rule is easy to trace back from
`chrome.declarativeNetRequest.getMatchedRules()`:

| Range | Source |
| --- | --- |
| 1000–1999 | `rules/analytics.json` |
| 2000–2999 | `rules/ads.json` |
| 3000–3999 | `rules/chat-widgets.json` |
| 4000–4999 | `rules/session-recording.json` |
| 5000–5899 | `rules/fonts.json` block rules |
| 5900–5999 | `rules/fonts.json` icon-font allow rules |
| 6000–6999 | `rules/icon-fonts.json` |
| 7000–7999 | `rules/small-images.json` |
| 800000+ | dynamic per-site allowlist exceptions |
| 900000+ | dynamic rules from the user's custom blocklist |

## Controls

**Global toggle** (popup) — flips `enabled` in `chrome.storage.sync`. The worker responds by
disabling every ruleset and dropping the custom block rules, so nothing is filtered at all.

**Per-site exception** (popup, or the options page list) — adds the hostname to
`excludedDomains`. Each entry becomes one dynamic rule:

```json
{
  "id": 800000,
  "priority": 100,
  "action": { "type": "allowAllRequests" },
  "condition": { "requestDomains": ["example.com"], "resourceTypes": ["main_frame", "sub_frame"] }
}
```

`allowAllRequests` on the document exempts every sub-request that document makes, and
`requestDomains` covers subdomains, so one entry disables the extension for the whole site. The
popup reloads the tab after the change because rules only apply to requests made after they land.

**Category toggles** (options page) — each category is a separate static ruleset, switched with
`chrome.declarativeNetRequest.updateEnabledRulesets`. No rules are rewritten, so toggling is
instant. First-party CSS is never blocked — it *is* the page layout, and no rule here matches
`stylesheet` from the page's own domain.

Three categories ship disabled (`DEFAULT_OFF` in `shared.js`) because they change how a page looks
rather than only what it phones home:

- **Web fonts** — text-font CDNs (Google Fonts, Typekit, Monotype, Bunny). Pages fall back to
  system fonts. Icons keep working.
- **Icon fonts** — Font Awesome, Material Icons, Iconfont. Icons become empty boxes or blank space.

Material Icons are served from the same hosts as Google's text fonts, and a `urlFilter` cannot
negate a substring, so the split needs a priority ladder:

```text
priority 1  block   ||fonts.googleapis.com^ , ||fonts.gstatic.com^     (fonts.json)
priority 2  allow   /icon? , family=material , /s/materialicons ,      (fonts.json)
                    /s/materialsymbols
priority 3  block   the same four icon patterns                        (icon-fonts.json)
```

So `fonts` alone strips text fonts and keeps icons; enabling `icon-fonts` as well strips both. The
per-site exception sits at priority 100 and still beats every rule above.

The priority-2 allow rules live in the 5900–5999 range for one reason beyond tidiness:
`onRuleMatchedDebug` fires for allow rules too, and `isAllowRule()` in `background.js` uses that
range to keep them out of the blocked count.

### Small images

`rules/small-images.json` targets the other kind of icon: 16–96 px avatars and favicons served as
real image files. A rule can only see the URL, never the `<img width="24">` attribute, so this
category matches the resizing conventions image CDNs put in the path or query string:

| Convention | Example URL fragment | Used by |
| --- | --- | --- |
| imgproxy / Thumbor | `/rs:fill:48:48/` | Apify, Evil Martians stack |
| Cloudinary transforms | `/w_48,h_48/` | Cloudinary |
| width query param | `?w=48`, `?width=32` | imgix, Next.js, WordPress.com |
| size query param | `?s=64`, `?size=24` | Gravatar, GitHub |
| dimension suffix | `_48x48.png`, `-24x24.webp` | Shopify, WordPress |
| dimension directory | `/32x32/` | many self-hosted resizers |

Plus a few hosts that only ever serve avatars or favicons: `gravatar.com`,
`avatars.githubusercontent.com`, `ui-avatars.com`, `icons.duckduckgo.com`,
`google.com/s2/favicons`.

Two caveats, which is why it ships disabled:

- **It guesses.** A genuine 80 px content image behind `?w=80` is blocked too. Nothing in the URL
  distinguishes a decorative avatar from a small photo that matters.
- **The saving is request count, not bandwidth.** A 48×48 JPEG is around 2 KB, so a page with
  thirty avatars saves ~60 KB but drops thirty connections and thirty decodes.

`domainType: "thirdParty"` still applies, so a site's own image server is never touched — only
external CDNs. Per-site exceptions work here exactly as for every other category.

**Custom blocklist** (options page) — user-supplied domains, stored in
`chrome.storage.sync.customDomains` and turned into dynamic block rules with the same
third-party-only condition as the static files.

All four settings live in `chrome.storage.sync` and follow the Chrome profile across installs.
The service worker watches `chrome.storage.onChanged` and rebuilds engine state from a single
code path, so the popup and the options page never need to know how rules are built.

## Extending the blocklist

Add an object to the matching file in `rules/`, using the next free id in that category's range,
and reload the extension on `chrome://extensions`. Keep `domainType: "thirdParty"` and leave
`main_frame` out. A domain that only ever appears as a tracker on other people's sites belongs
here; anything that also serves site content belongs in the custom blocklist instead, where the
user can drop it.

To add a whole new category: create `rules/<name>.json`, register it under
`declarative_net_request.rule_resources` in `manifest.json`, append the id to `CATEGORIES` in
`shared.js` (and to `DEFAULT_OFF` there if it should ship disabled), and add a label to
`CATEGORY_LABELS` in `options.js`.

## Notes and limits

- Chrome caps static rules and dynamic rules per extension. The counts here are small (123 static
  rules, 6 of them regex), so there is a lot of headroom, but a very large custom blocklist will
  eventually hit the dynamic-rule limit.
- Only network requests are blocked. Inline tracking code served by the page itself is untouched,
  by design, since cutting first-party scripts is how ad blockers break sites.
- No icons are bundled, so Chrome shows the default action icon. Drop 16/32/48/128 px PNGs in an
  `icons/` folder and add an `"icons"` plus `"action.default_icon"` block to the manifest if you
  want branding.
