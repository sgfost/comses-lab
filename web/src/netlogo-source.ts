/** Locate code without serializing the model's widgets, shapes, or metadata. */
export function netLogoCodeSection(source: string, path: string): {
  code: string;
  replace: (code: string) => string;
} {
  if (/\.nlogo$/i.test(path)) {
    const delimiter = /^@#\$#@#\$#@\r?$/m.exec(source);
    if (!delimiter) throw new Error("This model has no NetLogo section separator. Edit the full model to repair it.");
    const end = delimiter.index;
    return { code: source.slice(0, end), replace: code => code + (/\r?\n$/.test(code) ? "" : "\n") + source.slice(end) };
  }
  if (/<!DOCTYPE/i.test(source)) throw new Error("Models with XML document types must be edited as full source.");
  // DOMParser receives decoded text; retain the BOM in source, not parser input.
  const document = new DOMParser().parseFromString(source.replace(/^\uFEFF/, ""), "application/xml");
  if (document.querySelector("parsererror")) throw new Error("The model XML is invalid. Edit the full model to repair it.");
  const root = document.documentElement;
  const sections = Array.from(root.children).filter(child => child.tagName === "code");
  if (root.tagName !== "model" || sections.length !== 1 || sections[0]!.children.length) {
    throw new Error("Cannot locate a single NetLogo code section. Edit the full model instead.");
  }
  // Skip comments, CDATA and processing instructions before looking for tags.
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[A-Za-z_][\w:.-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/g;
  let depth = 0;
  let start = -1;
  let openingStart = -1;
  for (const token of source.matchAll(tokens)) {
    const text = token[0];
    if (text.startsWith("<!") || text.startsWith("<?")) continue;
    const closing = text.startsWith("</");
    const selfClosing = /\/\s*>$/.test(text);
    const name = /^<\/?([\w:.-]+)/.exec(text)?.[1];
    if (closing) {
      depth--;
      if (name === "code" && depth === 1 && start >= 0) {
        const end = token.index;
        return {
          code: sections[0]!.textContent ?? "",
          replace: code => source.slice(0, start) + xmlCode(code) + source.slice(end),
        };
      }
    } else {
      if (name === "code" && depth === 1) {
        openingStart = token.index;
        start = token.index + text.length;
        if (selfClosing) return {
          code: "",
          replace: code => source.slice(0, openingStart) + text.replace(/\/\s*>$/, ">") + xmlCode(code) + "</code>" + source.slice(start),
        };
      }
      if (!selfClosing) depth++;
    }
  }
  throw new Error("Cannot locate the NetLogo code section. Edit the full model instead.");
}
function xmlCode(code: string) {
  // Split CDATA terminators so every valid NetLogo string round-trips as XML.
  return "<![CDATA[" + code.replaceAll("]]>", "]]]]><![CDATA[>") + "]]>";
}
