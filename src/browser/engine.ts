import fs from "node:fs";
import { chromium, firefox, webkit, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { isInScope } from "../core/safety.js";
import { redactText, redactUrl } from "../core/redact.js";
import { nowIso, truncate } from "../core/util.js";

export type BrowserName = "chromium" | "firefox" | "webkit";

export interface ConsoleEntry {
  seq: number;
  at: string;
  type: string;
  text: string;
  url: string;
}

export interface NetworkEntry {
  seq: number;
  at: string;
  method: string;
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
  durationMs?: number;
  simulated?: string;
  contentType?: string;
}

export interface BlockedNavigation {
  seq: number;
  at: string;
  from: string;
  to: string;
}

export interface Simulation {
  urlIncludes: string;
  mode: "abort" | "status" | "delay";
  status?: number;
  body?: string;
  delayMs?: number;
}

export interface BrowserSession {
  name: string;
  browserName: BrowserName;
  context: BrowserContext;
  page: Page;
  console: ConsoleEntry[];
  network: NetworkEntry[];
  blockedNavigations: BlockedNavigation[];
  dialogs: Array<{ seq: number; at: string; type: string; message: string }>;
  simulations: Simulation[];
}

const RING = 1000;
let seq = 0;
const nextSeq = () => ++seq;
export const currentSeq = () => seq;

function push<T>(arr: T[], item: T): void {
  arr.push(item);
  if (arr.length > RING) arr.splice(0, arr.length - RING);
}

const launchers = { chromium, firefox, webkit };

export function browserAvailability(): Record<BrowserName, boolean> {
  const out = {} as Record<BrowserName, boolean>;
  for (const name of Object.keys(launchers) as BrowserName[]) {
    try {
      out[name] = fs.existsSync(launchers[name].executablePath());
    } catch {
      out[name] = false;
    }
  }
  return out;
}

class Engine {
  private browsers = new Map<BrowserName, Browser>();
  private sessions = new Map<string, BrowserSession>();

  async session(name = "default", browserName: BrowserName = "chromium", viewport?: { width: number; height: number }): Promise<BrowserSession> {
    const existing = this.sessions.get(name);
    if (existing && !existing.page.isClosed()) {
      if (viewport) await existing.page.setViewportSize(viewport);
      return existing;
    }
    if (!browserAvailability()[browserName]) {
      throw new Error(
        `Browser "${browserName}" is not installed for this Playwright version. Install with: npx playwright install ${browserName}. Record cross-browser checks for it as Blocked.`,
      );
    }
    let browser = this.browsers.get(browserName);
    if (!browser || !browser.isConnected()) {
      browser = await launchers[browserName].launch({ headless: process.env.QA_HEADLESS !== "false" });
      this.browsers.set(browserName, browser);
    }
    const context = await browser.newContext({ viewport: viewport ?? { width: 1280, height: 800 }, ignoreHTTPSErrors: false });
    const page = await context.newPage();
    const s: BrowserSession = {
      name,
      browserName,
      context,
      page,
      console: [],
      network: [],
      blockedNavigations: [],
      dialogs: [],
      simulations: [],
    };
    this.wire(s);
    this.sessions.set(name, s);
    return s;
  }

  listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  all(): BrowserSession[] {
    return [...this.sessions.values()];
  }

  async closeSession(name: string): Promise<void> {
    const s = this.sessions.get(name);
    if (s) {
      await s.context.close().catch(() => undefined);
      this.sessions.delete(name);
    }
  }

  async shutdown(): Promise<void> {
    for (const name of [...this.sessions.keys()]) await this.closeSession(name);
    for (const b of this.browsers.values()) await b.close().catch(() => undefined);
    this.browsers.clear();
  }

  private wire(s: BrowserSession): void {
    const { page, context } = s;
    const started = new Map<object, number>();

    page.on("console", (msg) => {
      push(s.console, { seq: nextSeq(), at: nowIso(), type: msg.type(), text: redactText(truncate(msg.text(), 1500)), url: redactUrl(page.url()) });
    });
    page.on("pageerror", (err) => {
      push(s.console, { seq: nextSeq(), at: nowIso(), type: "pageerror", text: redactText(truncate(`${err.name}: ${err.message}`, 1500)), url: redactUrl(page.url()) });
    });
    page.on("dialog", async (dialog) => {
      s.dialogs.push({ seq: nextSeq(), at: nowIso(), type: dialog.type(), message: redactText(dialog.message()) });
      // Dismiss by default: safer for confirm() prompts guarding destructive actions.
      await dialog.dismiss().catch(() => undefined);
    });
    page.on("request", (req) => started.set(req, Date.now()));
    page.on("requestfinished", async (req) => {
      const resp = await req.response().catch(() => null);
      push(s.network, {
        seq: nextSeq(),
        at: nowIso(),
        method: req.method(),
        url: redactUrl(req.url()),
        resourceType: req.resourceType(),
        status: resp?.status(),
        contentType: resp?.headers()["content-type"],
        durationMs: started.has(req) ? Date.now() - (started.get(req) as number) : undefined,
      });
      started.delete(req);
    });
    page.on("requestfailed", (req) => {
      push(s.network, {
        seq: nextSeq(),
        at: nowIso(),
        method: req.method(),
        url: redactUrl(req.url()),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText ?? "failed",
        durationMs: started.has(req) ? Date.now() - (started.get(req) as number) : undefined,
      });
      started.delete(req);
    });

    void context.route("**/*", async (route) => {
      const req = route.request();
      const url = req.url();
      // Navigation guard: never follow top-level navigation outside the authorised scope.
      if (req.isNavigationRequest() && req.frame() === page.mainFrame() && /^https?:/.test(url) && !isInScope(url)) {
        push(s.blockedNavigations, { seq: nextSeq(), at: nowIso(), from: redactUrl(page.url()), to: redactUrl(url) });
        await route.abort("blockedbyclient");
        return;
      }
      const sim = s.simulations.find((x) => url.includes(x.urlIncludes));
      if (sim) {
        if (sim.mode === "abort") {
          await route.abort("failed");
          return;
        }
        if (sim.mode === "delay") {
          await new Promise((r) => setTimeout(r, Math.min(sim.delayMs ?? 5000, 30000)));
          await route.continue().catch(() => undefined);
          return;
        }
        await route.fulfill({ status: sim.status ?? 503, contentType: "application/json", body: sim.body ?? JSON.stringify({ error: "simulated failure (QA investigator)" }) });
        return;
      }
      await route.continue().catch(() => undefined);
    });
  }
}

export const engine = new Engine();

export interface TargetSpec {
  selector?: string;
  role?: string;
  name?: string;
  label?: string;
  text?: string;
  placeholder?: string;
  testId?: string;
  nth?: number;
  exact?: boolean;
}

export async function resolveTarget(page: Page, t: TargetSpec): Promise<{ locator: Locator; count: number; description: string }> {
  let loc: Locator;
  let description: string;
  if (t.selector) {
    loc = page.locator(t.selector);
    description = `selector=${t.selector}`;
  } else if (t.role) {
    loc = page.getByRole(t.role as Parameters<Page["getByRole"]>[0], t.name ? { name: t.name, exact: t.exact ?? false } : undefined);
    description = `role=${t.role}${t.name ? ` name="${t.name}"` : ""}`;
  } else if (t.label) {
    loc = page.getByLabel(t.label, { exact: t.exact ?? false });
    description = `label="${t.label}"`;
  } else if (t.placeholder) {
    loc = page.getByPlaceholder(t.placeholder, { exact: t.exact ?? false });
    description = `placeholder="${t.placeholder}"`;
  } else if (t.testId) {
    loc = page.getByTestId(t.testId);
    description = `testId=${t.testId}`;
  } else if (t.text) {
    loc = page.getByText(t.text, { exact: t.exact ?? false });
    description = `text="${t.text}"`;
  } else {
    throw new Error("Target needs one of: selector, role(+name), label, placeholder, testId, text");
  }
  const count = await loc.count();
  if (t.nth !== undefined) {
    loc = loc.nth(t.nth);
    description += ` nth=${t.nth}`;
  } else if (count > 1) {
    loc = loc.first();
    description += ` (first of ${count})`;
  }
  return { locator: loc, count, description };
}

export function eventsSince(s: BrowserSession, sinceSeq: number) {
  return {
    consoleErrors: s.console.filter((c) => c.seq > sinceSeq && (c.type === "error" || c.type === "pageerror")),
    consoleWarnings: s.console.filter((c) => c.seq > sinceSeq && c.type === "warning").length,
    failedRequests: s.network.filter((n) => n.seq > sinceSeq && (n.failure || (n.status ?? 0) >= 400)),
    apiCalls: s.network
      .filter((n) => n.seq > sinceSeq && (n.resourceType === "fetch" || n.resourceType === "xhr"))
      .map((n) => ({ method: n.method, url: n.url, status: n.status, failure: n.failure, durationMs: n.durationMs, simulated: n.simulated })),
    blockedNavigations: s.blockedNavigations.filter((b) => b.seq > sinceSeq),
    dialogs: s.dialogs.filter((d) => d.seq > sinceSeq),
  };
}
