// Runs only when the icon-fonts category is on, which is when Material/FontAwesome/mdi
// glyphs fail to load and the page shows raw ligature text ("keyboard_arrow_up") instead.
// Injects CSS that hides that text and draws a plain placeholder dot in its place.
(async () => {
    const { enabled, categories } = await chrome.storage.sync.get({ enabled: true, categories: {} });
    if (!enabled || !categories['icon-fonts']) return;

    const ICON_FONT_SELECTOR = [
        '.material-icons', '.material-icons-outlined', '.material-icons-round', '.material-icons-sharp',
        '.material-symbols-outlined', '.material-symbols-rounded', '.material-symbols-sharp',
        '[class^="mdi-"]', '[class*=" mdi-"]',
        '.fa', '.fas', '.far', '.fab', '.fal',
        '.glyphicon',
    ].join(', ');

    const PLACEHOLDER_SVG =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E" +
        "%3Ccircle cx='12' cy='12' r='8' fill='%23999'/%3E%3C/svg%3E";

    const style = document.createElement('style');
    style.textContent = `
        ${ICON_FONT_SELECTOR} {
            color: transparent !important;
            position: relative !important;
        }
        ${ICON_FONT_SELECTOR}::before {
            content: "" !important;
            position: absolute;
            top: 50%;
            left: 50%;
            width: 1em;
            height: 1em;
            margin: -0.5em 0 0 -0.5em;
            background: no-repeat center / 70% url("${PLACEHOLDER_SVG}");
        }
    `;
    document.documentElement.appendChild(style);
})();
