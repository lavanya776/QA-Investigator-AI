/**
 * Runs inside the page via page.evaluate. Must be self-contained (no imports,
 * no references to module scope). Returns a structured, size-bounded snapshot.
 */
export function inPageInspect(opts: { maxItems: number; marker?: string }) {
  const max = opts.maxItems;
  const cssEscape = (v: string) => (window.CSS && CSS.escape ? CSS.escape(v) : v.replace(/[^a-zA-Z0-9_-]/g, "\\$&"));
  const clip = (v: string | null | undefined, n = 120) => {
    const s = (v ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };

  const selectorFor = (el: Element): string => {
    if (el.id && document.querySelectorAll(`#${cssEscape(el.id)}`).length === 1) return `#${cssEscape(el.id)}`;
    const tag = el.tagName.toLowerCase();
    const testId = el.getAttribute("data-testid");
    if (testId) return `[data-testid="${testId}"]`;
    const name = el.getAttribute("name");
    if (name && document.querySelectorAll(`${tag}[name="${name}"]`).length === 1) return `${tag}[name="${name}"]`;
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && cur !== document.body && parts.length < 6) {
      const t = cur.tagName.toLowerCase();
      if (cur.id && document.querySelectorAll(`#${cssEscape(cur.id)}`).length === 1) {
        parts.unshift(`#${cssEscape(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
        parts.unshift(same.length > 1 ? `${t}:nth-of-type(${same.indexOf(cur) + 1})` : t);
      } else parts.unshift(t);
      cur = parent;
    }
    return parts.join(" > ");
  };

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0";
  };

  const labelText = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const by = el.getAttribute("aria-labelledby");
    if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    const input = el as HTMLInputElement;
    if (input.labels && input.labels.length) return Array.from(input.labels).map((l) => l.textContent ?? "").join(" ");
    return el.getAttribute("title") ?? "";
  };

  const accessibleName = (el: Element): string => {
    const lbl = labelText(el);
    if (lbl.trim()) return lbl;
    const text = (el as HTMLElement).innerText ?? el.textContent ?? "";
    if (text.trim()) return text;
    const img = el.querySelector("img[alt]");
    return img?.getAttribute("alt") ?? (el as HTMLInputElement).value ?? "";
  };

  const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
    .filter(visible)
    .slice(0, max)
    .map((h) => ({ level: Number(h.tagName[1]), text: clip(h.textContent) }));

  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, max)
    .map((a) => ({ text: clip(accessibleName(a), 80), href: (a as HTMLAnchorElement).href, selector: selectorFor(a), visible: visible(a), target: a.getAttribute("target") ?? undefined }));

  const buttons = Array.from(document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]"))
    .slice(0, max)
    .map((b) => ({ name: clip(accessibleName(b), 80), type: b.getAttribute("type") ?? undefined, disabled: (b as HTMLButtonElement).disabled === true || b.getAttribute("aria-disabled") === "true", visible: visible(b), selector: selectorFor(b) }));

  const describeField = (f: Element) => {
    const i = f as HTMLInputElement;
    const type = (f.getAttribute("type") ?? f.tagName.toLowerCase()).toLowerCase();
    return {
      tag: f.tagName.toLowerCase(),
      type,
      name: i.name || undefined,
      id: i.id || undefined,
      label: clip(labelText(f), 80) || undefined,
      placeholder: i.placeholder || undefined,
      required: i.required || f.getAttribute("aria-required") === "true",
      pattern: f.getAttribute("pattern") ?? undefined,
      min: f.getAttribute("min") ?? undefined,
      max: f.getAttribute("max") ?? undefined,
      maxlength: f.getAttribute("maxlength") ?? undefined,
      autocomplete: f.getAttribute("autocomplete") ?? undefined,
      value: type === "password" ? (i.value ? "[masked]" : "") : clip(i.value, 60),
      invalid: typeof i.checkValidity === "function" ? !i.checkValidity() : undefined,
      validationMessage: i.validationMessage || undefined,
      ariaInvalid: f.getAttribute("aria-invalid") ?? undefined,
      disabled: i.disabled || undefined,
      visible: visible(f),
      selector: selectorFor(f),
    };
  };

  const fieldSel = "input:not([type=hidden]), select, textarea";
  const forms = Array.from(document.querySelectorAll("form"))
    .slice(0, 20)
    .map((form) => ({
      selector: selectorFor(form),
      action: form.getAttribute("action") ?? undefined,
      method: (form.getAttribute("method") ?? "get").toLowerCase(),
      novalidate: form.noValidate || undefined,
      hasCsrfLikeField: Array.from(form.querySelectorAll("input[type=hidden]")).some((h) => /csrf|xsrf|token|nonce/i.test(h.getAttribute("name") ?? "")),
      fields: Array.from(form.querySelectorAll(fieldSel)).slice(0, max).map(describeField),
    }));
  const looseFields = Array.from(document.querySelectorAll(fieldSel))
    .filter((f) => !f.closest("form"))
    .slice(0, max)
    .map(describeField);

  // Messages: alerts, live regions, validation and error text
  const messages = Array.from(document.querySelectorAll("[role=alert], [role=status], [aria-live], .error, .alert, .message, .toast, .notice, .warning"))
    .filter(visible)
    .slice(0, 30)
    .map((m) => ({ text: clip((m as HTMLElement).innerText, 200), selector: selectorFor(m) }))
    .filter((m) => m.text);

  const loadingIndicators = Array.from(document.querySelectorAll("[aria-busy=true], [role=progressbar], .spinner, .loading, .loader"))
    .filter(visible)
    .slice(0, 10)
    .map((l) => ({ selector: selectorFor(l), text: clip((l as HTMLElement).innerText, 80) }));

  // Accessibility heuristics (common, automatable checks; not a full audit)
  const a11y: Array<{ rule: string; selector: string; detail: string }> = [];
  const addA = (rule: string, el: Element | null, detail: string) => {
    if (a11y.length < max) a11y.push({ rule, selector: el ? selectorFor(el) : "document", detail: clip(detail, 160) });
  };
  if (!document.documentElement.getAttribute("lang")) addA("html-lang-missing", null, "<html> has no lang attribute");
  document.querySelectorAll("img").forEach((img) => {
    if (!img.hasAttribute("alt") && visible(img)) addA("img-alt-missing", img, img.getAttribute("src") ?? "");
  });
  document.querySelectorAll(fieldSel).forEach((f) => {
    if (!visible(f)) return;
    const type = f.getAttribute("type");
    if (type === "submit" || type === "button" || type === "reset") return;
    if (!labelText(f).trim()) addA("form-field-no-accessible-name", f, `placeholder="${f.getAttribute("placeholder") ?? ""}" name="${f.getAttribute("name") ?? ""}"`);
  });
  document.querySelectorAll("button, [role=button], a[href]").forEach((b) => {
    if (visible(b) && !accessibleName(b).trim()) addA("control-no-accessible-name", b, b.outerHTML.slice(0, 120));
  });
  const ids = new Map<string, number>();
  document.querySelectorAll("[id]").forEach((e) => ids.set(e.id, (ids.get(e.id) ?? 0) + 1));
  for (const [id, n] of ids) if (n > 1) addA("duplicate-id", document.getElementById(id), `id="${id}" used ${n} times`);
  const h1s = headings.filter((h) => h.level === 1).length;
  if (h1s === 0) addA("no-h1", null, "Page has no visible <h1>");
  for (let i = 1; i < headings.length; i++) {
    if (headings[i].level - headings[i - 1].level > 1) addA("heading-level-skip", null, `h${headings[i - 1].level} -> h${headings[i].level} ("${headings[i].text}")`);
  }
  document.querySelectorAll("[tabindex]").forEach((e) => {
    if (Number(e.getAttribute("tabindex")) > 0) addA("positive-tabindex", e, `tabindex=${e.getAttribute("tabindex")}`);
  });

  // Layout: horizontal overflow and overlapping interactive elements
  const vw = window.innerWidth;
  const docWidth = document.documentElement.scrollWidth;
  const overflowing = Array.from(document.body.querySelectorAll("*"))
    .filter((e) => visible(e) && e.getBoundingClientRect().right > vw + 1)
    .filter((e, _i, arr) => !arr.some((o) => o !== e && o.contains(e)))
    .slice(0, 10)
    .map((e) => ({ selector: selectorFor(e), right: Math.round(e.getBoundingClientRect().right), width: Math.round(e.getBoundingClientRect().width) }));
  const interactive = Array.from(document.querySelectorAll("a[href], button, input, select, textarea, [role=button]")).filter(visible).slice(0, 150);
  const overlaps: Array<{ a: string; b: string; overlapRatio: number }> = [];
  for (let i = 0; i < interactive.length && overlaps.length < 10; i++) {
    for (let j = i + 1; j < interactive.length && overlaps.length < 10; j++) {
      const A = interactive[i];
      const B = interactive[j];
      if (A.contains(B) || B.contains(A)) continue;
      const ra = A.getBoundingClientRect();
      const rb = B.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 0 && h > 0) {
        const ratio = (w * h) / Math.min(ra.width * ra.height, rb.width * rb.height);
        if (ratio > 0.3) overlaps.push({ a: selectorFor(A), b: selectorFor(B), overlapRatio: Math.round(ratio * 100) / 100 });
      }
    }
  }

  let markerReflection: { inText: boolean; inHtml: boolean; asElement: boolean } | undefined;
  if (opts.marker) {
    const html = document.documentElement.outerHTML;
    markerReflection = {
      inText: document.body.innerText.includes(opts.marker),
      inHtml: html.includes(opts.marker),
      asElement: document.getElementsByTagName(opts.marker).length > 0,
    };
  }

  return {
    title: document.title,
    url: location.href,
    lang: document.documentElement.getAttribute("lang") ?? undefined,
    metaViewport: document.querySelector("meta[name=viewport]")?.getAttribute("content") ?? undefined,
    headings,
    landmarks: Array.from(document.querySelectorAll("header, nav, main, footer, aside, [role=main], [role=navigation]")).length,
    links,
    buttons,
    forms,
    looseFields,
    messages,
    loadingIndicators,
    accessibilityIssues: a11y,
    layout: {
      viewport: { width: vw, height: window.innerHeight },
      documentWidth: docWidth,
      horizontalOverflow: docWidth > vw + 1,
      overflowingElements: overflowing,
      overlappingInteractive: overlaps,
    },
    markerReflection,
    visibleText: clip(document.body.innerText, 2500),
    counts: {
      links: document.querySelectorAll("a[href]").length,
      buttons: document.querySelectorAll("button, [role=button], input[type=submit]").length,
      forms: document.querySelectorAll("form").length,
      images: document.images.length,
    },
  };
}

/** Describe the currently focused element and whether a focus indicator is visible. */
export function inPageFocusState() {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return { tag: "body", name: "", focusIndicator: false };
  const cs = getComputedStyle(el);
  const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
  const shadow = cs.boxShadow !== "none";
  const name = (el.getAttribute("aria-label") ?? el.innerText ?? (el as HTMLInputElement).value ?? el.getAttribute("name") ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return { tag: el.tagName.toLowerCase(), id: el.id || undefined, name, focusIndicator: outline || shadow };
}
