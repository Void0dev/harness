const STYLE_PATH = "/__harness/task-card.css";
const SCRIPT_PATH = "/__harness/task-card.mjs";

export function injectHarnessAssets(html) {
  if (typeof html !== "string" || !/<html(?:\s|>)/i.test(html)) return html;
  if (html.includes(SCRIPT_PATH) || html.includes(STYLE_PATH)) return html;
  const style = `<link rel="stylesheet" href="${STYLE_PATH}">`;
  const script = `<script type="module" src="${SCRIPT_PATH}"></script>`;
  const withStyle = /<\/head>/i.test(html)
    ? html.replace(/<\/head>/i, `${style}</head>`)
    : `${style}${html}`;
  return /<\/body>/i.test(withStyle)
    ? withStyle.replace(/<\/body>/i, `${script}</body>`)
    : `${withStyle}${script}`;
}
