import type { Page } from "playwright";
import { engine, eventsSince, currentSeq, resolveTarget, type BrowserName, type BrowserSession, type TargetSpec } from "./engine.js";
import { inPageFocusState, inPageInspect } from "./inspect.js";
import { assertInScope, assertInputSize, consumeBrowserActions, consumeRequestBudget, isInScope, makeProbeMarker } from "../core/safety.js";
import { resolveSecret } from "../core/secrets.js";
import { redactDeep, redactText, redactUrl, SENSITIVE_KEY } from "../core/redact.js";
import { requireMission, saveEvidence } from "../core/store.js";
import { errorMessage, truncate } from "../core/util.js";
import type { Evidence } from "../core/types.js";

export interface SessionOpts {
  session?: string;
  browser?: BrowserName;
  viewport?: { width: number; height: number };
}

async function openSession(o: SessionOpts): Promise<BrowserSession> {
  return engine.session(o.session ?? "default", o.browser ?? "chromium", o.viewport);
}

async function gotoChecked(page: Page, url: string) {
  assertInScope(url);
  const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: requireMission().mission.limits.timeoutMs });
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);
  return resp;
}

// ---------------------------------------------------------------- inspect_page

export async function inspectPage(input: SessionOpts & { url?: string; maxItems?: number; checkLinks?: boolean; tabStops?: number; marker?: string }) {
  const s = await openSession(input);
  const since = currentSeq();
  let navStatus: number | undefined;
  if (input.url) {
    consumeBrowserActions(1);
    const resp = await gotoChecked(s.page, input.url);
    navStatus = resp?.status();
  }
  if (s.page.url() === "about:blank") throw new Error("No page loaded in this session. Provide url.");
  const snapshot = await s.page.evaluate(inPageInspect, { maxItems: input.maxItems ?? 40, marker: input.marker });

  let focusOrder: Array<Record<string, unknown>> | undefined;
  if (input.tabStops && input.tabStops > 0) {
    consumeBrowserActions(input.tabStops);
    await s.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    focusOrder = [];
    for (let i = 0; i < Math.min(input.tabStops, 40); i++) {
      await s.page.keyboard.press("Tab");
      focusOrder.push({ step: i + 1, ...(await s.page.evaluate(inPageFocusState)) });
    }
  }

  let linkCheck: Array<{ href: string; status?: number; error?: string }> | undefined;
  if (input.checkLinks) {
    const hrefs = [...new Set(snapshot.links.map((l) => l.href.split("#")[0]))].filter((h) => isInScope(h)).slice(0, 40);
    linkCheck = [];
    for (const href of hrefs) {
      try {
        await consumeRequestBudget();
        const r = await s.context.request.get(href, { timeout: requireMission().mission.limits.timeoutMs, maxRedirects: 0 });
        linkCheck.push({ href: redactUrl(href), status: r.status() });
      } catch (err) {
        linkCheck.push({ href: redactUrl(href), error: errorMessage(err).split("\n")[0] });
      }
    }
  }

  const result = redactDeep({
    session: s.name,
    browser: s.browserName,
    navigationStatus: navStatus,
    ...snapshot,
    focusOrder,
    linkCheck: linkCheck ? { checked: linkCheck.length, broken: linkCheck.filter((l) => l.error || (l.status ?? 0) >= 400), redirects: linkCheck.filter((l) => l.status && l.status >= 300 && l.status < 400) } : undefined,
    events: eventsSince(s, since),
  });
  const ev = saveEvidence({
    kind: "page_inspection",
    label: `inspect ${new URL(s.page.url()).pathname}`,
    source: s.page.url(),
    summary: `${snapshot.title} | ${snapshot.accessibilityIssues.length} a11y issues | overflow=${snapshot.layout.horizontalOverflow}`,
    ext: "json",
    data: JSON.stringify(result, null, 2),
  });
  return { evidenceId: ev.id, ...result };
}

// ---------------------------------------------------------- interact_with_page

export interface Action {
  type:
    | "navigate"
    | "click"
    | "fill"
    | "clear"
    | "select"
    | "check"
    | "uncheck"
    | "press"
    | "hover"
    | "scroll"
    | "wait"
    | "setViewport"
    | "goBack"
    | "goForward"
    | "reload"
    | "simulateNetwork"
    | "clearSimulations"
    | "clearSession";
  url?: string;
  target?: TargetSpec;
  value?: string;
  secretRef?: string;
  useProbeMarker?: boolean;
  key?: string;
  repeat?: number;
  intervalMs?: number;
  ms?: number;
  waitFor?: { target?: TargetSpec; state?: "visible" | "hidden" | "attached" | "detached"; urlIncludes?: string };
  width?: number;
  height?: number;
  y?: number;
  simulation?: { urlIncludes: string; mode: "abort" | "status" | "delay"; status?: number; body?: string; delayMs?: number };
  clearCookies?: boolean;
  clearStorage?: boolean;
}

export async function interact(input: SessionOpts & { actions: Action[]; stopOnError?: boolean; screenshotAfter?: boolean; label?: string }) {
  const s = await openSession(input);
  const page = s.page;
  const since = currentSeq();
  const timeout = Math.min(requireMission().mission.limits.timeoutMs, 15000);
  const results: Array<Record<string, unknown>> = [];
  let probeMarker: string | undefined;
  consumeBrowserActions(input.actions.reduce((n, a) => n + Math.max(1, a.repeat ?? 1), 0));

  for (const [i, a] of input.actions.entries()) {
    const step: Record<string, unknown> = { step: i + 1, type: a.type };
    const before = currentSeq();
    try {
      switch (a.type) {
        case "navigate": {
          if (!a.url) throw new Error("navigate requires url");
          const resp = await gotoChecked(page, a.url);
          step.status = resp?.status();
          break;
        }
        case "click": {
          const t = await resolveTarget(page, a.target ?? {});
          step.target = t.description;
          if (t.count === 0) throw new Error(`No element matches ${t.description}`);
          const times = Math.min(a.repeat ?? 1, 5);
          for (let n = 0; n < times; n++) {
            // force on repeats so rapid double-submission is actually attempted
            await t.locator.click({ timeout, force: n > 0, noWaitAfter: true });
            if (n < times - 1) await page.waitForTimeout(Math.min(a.intervalMs ?? 50, 2000));
          }
          if (times > 1) step.clicks = times;
          break;
        }
        case "fill": {
          const t = await resolveTarget(page, a.target ?? {});
          step.target = t.description;
          let value = a.value ?? "";
          if (a.secretRef) {
            value = resolveSecret(a.secretRef);
            step.value = `[secret:${a.secretRef}]`;
          } else if (a.useProbeMarker) {
            probeMarker = probeMarker ?? makeProbeMarker();
            value = `${a.value ?? ""}${probeMarker}`;
            step.value = value;
          } else {
            step.value = truncate(value, 80);
          }
          assertInputSize(value, "fill value");
          await t.locator.fill(value, { timeout });
          break;
        }
        case "clear": {
          const t = await resolveTarget(page, a.target ?? {});
          step.target = t.description;
          await t.locator.fill("", { timeout });
          break;
        }
        case "select": {
          const t = await resolveTarget(page, a.target ?? {});
          step.target = t.description;
          step.selected = await t.locator.selectOption(a.value ?? "", { timeout });
          break;
        }
        case "check":
        case "uncheck": {
          const t = await resolveTarget(page, a.target ?? {});
          step.target = t.description;
          await (a.type === "check" ? t.locator.check({ timeout }) : t.locator.uncheck({ timeout }));
          break;
        }
        case "press": {
          if (!a.key) throw new Error("press requires key");
          if (a.target) {
            const t = await resolveTarget(page, a.target);
            step.target = t.description;
            await t.locator.press(a.key, { timeout });
          } else {
            for (let n = 0; n < Math.min(a.repeat ?? 1, 40); n++) await page.keyboard.press(a.key);
          }
          if (a.key === "Tab") step.focused = await page.evaluate(inPageFocusState);
          break;
        }
        case "hover": {
          const t = await resolveTarget(page, a.target ?? {});
          step.target = t.description;
          await t.locator.hover({ timeout });
          break;
        }
        case "scroll": {
          if (a.target) {
            const t = await resolveTarget(page, a.target);
            await t.locator.scrollIntoViewIfNeeded({ timeout });
          } else await page.mouse.wheel(0, a.y ?? 600);
          break;
        }
        case "wait": {
          if (a.waitFor?.target) {
            const t = await resolveTarget(page, a.waitFor.target);
            step.target = t.description;
            // elements may not exist yet at resolve time; wait on the first (or nth) match
            const loc = a.waitFor.target.nth === undefined ? t.locator.first() : t.locator;
            await loc.waitFor({ state: a.waitFor.state ?? "visible", timeout: Math.min(a.ms ?? timeout, 30000) });
          } else if (a.waitFor?.urlIncludes) {
            const frag = a.waitFor.urlIncludes;
            await page.waitForURL((u) => u.toString().includes(frag), { timeout: Math.min(a.ms ?? timeout, 30000) });
          } else {
            await page.waitForTimeout(Math.min(a.ms ?? 500, 10000));
          }
          break;
        }
        case "setViewport":
          await page.setViewportSize({ width: a.width ?? 1280, height: a.height ?? 800 });
          break;
        case "goBack":
          await page.goBack({ timeout });
          break;
        case "goForward":
          await page.goForward({ timeout });
          break;
        case "reload":
          step.status = (await page.reload({ timeout }))?.status();
          break;
        case "simulateNetwork": {
          if (!a.simulation) throw new Error("simulateNetwork requires simulation");
          // Fault injection applies only to this investigator's own browser session.
          s.simulations.push(a.simulation);
          step.simulation = a.simulation;
          break;
        }
        case "clearSimulations":
          s.simulations.length = 0;
          break;
        case "clearSession": {
          if (a.clearCookies !== false) await s.context.clearCookies();
          if (a.clearStorage) await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); }).catch(() => undefined);
          break;
        }
        default:
          throw new Error(`Unsupported action type ${(a as Action).type}`);
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => undefined);
      step.ok = true;
    } catch (err) {
      step.ok = false;
      step.error = redactText(errorMessage(err).split("\n")[0]);
    }
    step.url = redactUrl(page.url());
    const ev = eventsSince(s, before);
    if (ev.consoleErrors.length) step.newConsoleErrors = ev.consoleErrors.map((c) => c.text);
    if (ev.failedRequests.length) step.failedRequests = ev.failedRequests.map((r) => `${r.method} ${r.url} -> ${r.status ?? r.failure}`);
    if (ev.blockedNavigations.length) step.blockedNavigations = ev.blockedNavigations.map((b) => b.to);
    if (ev.dialogs.length) step.dialogs = ev.dialogs.map((d) => `${d.type}: ${d.message}`);
    results.push(step);
    if (!step.ok && input.stopOnError !== false) break;
  }
  await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => undefined);

  const pageState = await page
    .evaluate(() => {
      const vis = (e: Element) => (e as HTMLElement).offsetParent !== null;
      return {
        title: document.title,
        messages: Array.from(document.querySelectorAll("[role=alert], [role=status], [aria-live], .error, .alert, .message, .toast"))
          .filter(vis)
          .map((e) => (e as HTMLElement).innerText.trim())
          .filter(Boolean)
          .slice(0, 10),
        invalidFields: Array.from(document.querySelectorAll("input, select, textarea"))
          .filter((f) => !(f as HTMLInputElement).checkValidity?.() || f.getAttribute("aria-invalid") === "true")
          .map((f) => ({ name: f.getAttribute("name") ?? f.id, message: (f as HTMLInputElement).validationMessage }))
          .slice(0, 10),
        loading: Array.from(document.querySelectorAll("[aria-busy=true], .spinner, .loading, [role=progressbar]")).filter(vis).length,
        textExcerpt: document.body.innerText.replace(/\s+/g, " ").slice(0, 800),
      };
    })
    .catch(() => undefined);

  let screenshot: Evidence | undefined;
  if (input.screenshotAfter) {
    screenshot = saveEvidence({
      kind: "screenshot",
      label: input.label ?? "after interaction",
      source: page.url(),
      summary: `Screenshot after ${input.actions.length} action(s)`,
      ext: "png",
      data: await page.screenshot({ fullPage: true }),
    });
  }

  return redactDeep({
    session: s.name,
    browser: s.browserName,
    finalUrl: page.url(),
    probeMarker,
    steps: results,
    pageState,
    events: eventsSince(s, since),
    activeSimulations: s.simulations,
    screenshotEvidenceId: screenshot?.id,
  });
}

// ------------------------------------------------------------ capture_evidence

export type CaptureKind = "screenshot" | "dom" | "console" | "network" | "storage" | "cookies";

export async function captureEvidence(input: SessionOpts & { kinds: CaptureKind[]; label: string; fullPage?: boolean; selector?: string; networkFilter?: { urlIncludes?: string; minStatus?: number; apiOnly?: boolean } }) {
  const s = await openSession(input);
  const page = s.page;
  const url = page.url();
  const saved: Array<{ id: string; kind: string; file: string; summary: string }> = [];
  const observations: string[] = [];
  const add = (ev: Evidence) => saved.push({ id: ev.id, kind: ev.kind, file: ev.file, summary: ev.summary });

  for (const kind of input.kinds) {
    if (kind === "screenshot") {
      const buf = input.selector ? await page.locator(input.selector).first().screenshot() : await page.screenshot({ fullPage: input.fullPage ?? true });
      const vp = page.viewportSize();
      add(saveEvidence({ kind: "screenshot", label: input.label, source: url, summary: `Screenshot ${vp?.width}x${vp?.height}${input.selector ? ` of ${input.selector}` : ""}`, ext: "png", data: buf }));
    } else if (kind === "dom") {
      const html = await page.content();
      add(saveEvidence({ kind: "dom", label: input.label, source: url, summary: `DOM snapshot (${html.length} chars)`, ext: "html", data: html }));
    } else if (kind === "console") {
      const entries = s.console.slice(-300);
      const errors = entries.filter((c) => c.type === "error" || c.type === "pageerror");
      add(saveEvidence({ kind: "console", label: input.label, source: url, summary: `${entries.length} console entries, ${errors.length} errors`, ext: "json", data: JSON.stringify(entries, null, 2) }));
      for (const e of errors.slice(0, 5)) observations.push(`Console ${e.type} on ${e.url}: ${e.text}`);
    } else if (kind === "network") {
      const f = input.networkFilter ?? {};
      const entries = s.network
        .filter((n) => (!f.urlIncludes || n.url.includes(f.urlIncludes)) && (!f.minStatus || (n.status ?? 999) >= f.minStatus) && (!f.apiOnly || n.resourceType === "fetch" || n.resourceType === "xhr"))
        .slice(-400);
      const failed = entries.filter((n) => n.failure || (n.status ?? 0) >= 400);
      add(saveEvidence({ kind: "network", label: input.label, source: url, summary: `${entries.length} requests, ${failed.length} failed/4xx/5xx`, ext: "json", data: JSON.stringify({ entries, blockedNavigations: s.blockedNavigations }, null, 2) }));
      for (const n of failed.slice(0, 5)) observations.push(`Network: ${n.method} ${n.url} -> ${n.status ?? n.failure}`);
      for (const b of s.blockedNavigations.slice(-3)) observations.push(`Navigation to out-of-scope URL was blocked: ${b.to} (from ${b.from})`);
    } else if (kind === "storage") {
      const storage = await page.evaluate(() => {
        const dump = (st: Storage) => Object.fromEntries(Array.from({ length: st.length }, (_, i) => st.key(i) as string).map((k) => [k, st.getItem(k) ?? ""]));
        return { localStorage: dump(localStorage), sessionStorage: dump(sessionStorage) };
      });
      const masked: Record<string, Record<string, string>> = {};
      for (const [area, entries] of Object.entries(storage)) {
        masked[area] = {};
        for (const [k, v] of Object.entries(entries)) {
          const jwtLike = /^eyJ[\w-]+\.[\w-]+\./.test(v);
          const sensitive = SENSITIVE_KEY.test(k) || jwtLike;
          masked[area][k] = sensitive ? `[REDACTED len=${v.length}${jwtLike ? " jwt" : ""}]` : truncate(redactText(v), 200);
          if (sensitive) observations.push(`Sensitive-looking value stored in ${area} under key "${k}" (value masked)`);
        }
      }
      add(saveEvidence({ kind: "storage", label: input.label, source: url, summary: `localStorage ${Object.keys(masked.localStorage).length} keys, sessionStorage ${Object.keys(masked.sessionStorage).length} keys`, ext: "json", data: JSON.stringify(masked, null, 2) }));
    } else if (kind === "cookies") {
      const cookies = (await s.context.cookies()).map((c) => ({ name: c.name, domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite, expires: c.expires, valueLength: c.value.length }));
      const isHttps = url.startsWith("https:");
      for (const c of cookies) {
        const sessionLike = /sess|sid|auth|token|jwt/i.test(c.name);
        if (sessionLike && !c.httpOnly) observations.push(`Session-like cookie "${c.name}" lacks HttpOnly (readable by page scripts)`);
        if (sessionLike && c.sameSite === "None") observations.push(`Session-like cookie "${c.name}" has SameSite=None`);
        if (sessionLike && !c.secure) observations.push(`Session-like cookie "${c.name}" lacks Secure${isHttps ? "" : " (site served over http; expected on https deployments)"}`);
      }
      add(saveEvidence({ kind: "cookies", label: input.label, source: url, summary: `${cookies.length} cookies (values not stored)`, ext: "json", data: JSON.stringify(cookies, null, 2) }));
    }
  }
  return { session: s.name, url: redactUrl(url), evidence: saved, observations, note: "Observations are automated indicators for the investigator to assess; they are not findings until recorded and verified." };
}
