import { describe, expect, test } from "bun:test";
import { decideWrite, installInterceptor, InterceptorUnavailable, type AuthorizedBatch } from "../../src/banner/interceptor";
import { FakeBrowser } from "../auth/fake-browser";

const BASE = "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb";
const AUTH: AuthorizedBatch = { term: "120271", addCrns: ["31187", "31225"], dropCrn: null };
const add = (body: string, url = `${BASE}/classRegistration/addCRNRegistrationItems`) => ({ method: "POST", url, postData: body });
const submit = (update: unknown[], extra: Record<string, unknown> = {}) => ({
  method: "POST",
  url: `${BASE}/classRegistration/submitRegistration/batch`,
  postData: JSON.stringify({ create: [], update, destroy: [], uniqueSessionId: "abcde1", ...extra }),
});
const ACTIONS = [
  { courseRegistrationStatus: "RW", description: "**Web Registered**" },
  { courseRegistrationStatus: "DW", description: "Web Drop" },
];
const model = (crn: string, term = "120271", selectedAction = "RW") => ({ courseReferenceNumber: crn, term, registrationActions: ACTIONS, selectedAction });
const drop = (crn: string) => model(crn, "120271", "DW");

describe("decideWrite: reads", () => {
  test("allows ordinary reads and non-Banner hosts", () => {
    for (const url of [
      `${BASE}/classRegistration/classRegistration`,
      `${BASE}/classRegistration/getRegistrationEvents?termFilter=120271`,
      `${BASE}/classRegistration/reset?selectedTab=true&term=120271`,
      `${BASE}/searchResults/getEnrollmentInfo?term=120271&courseReferenceNumber=31187`,
      `${BASE}/term/termSelection?mode=registration`,
      "https://banner.apps.uillinois.edu/StudentRegistrationSSB/saml2/authenticate/studentregistrationssb",
      "https://login.microsoftonline.com/common/login",
    ]) {
      expect(decideWrite({ method: "GET", url }, null)).toBe("allow");
    }
    expect(decideWrite({ method: "POST", url: `${BASE}/term/search?mode=registration`, postData: "term=120271" }, null)).toBe("allow");
    expect(decideWrite({ method: "POST", url: `${BASE}/classSearch/resetDataForm` }, null)).toBe("allow");
  });
});

describe("decideWrite: writes without authorization", () => {
  test("blocks every write path", () => {
    expect(decideWrite(add("crnList=31187,31225&term=120271"), null)).toBe("block");
    expect(decideWrite(submit([model("31187"), model("31225")]), null)).toBe("block");
    expect(decideWrite({ method: "POST", url: `${BASE}/classRegistration/addRegistrationItem`, postData: "term=120271&courseReferenceNumber=31187" }, null)).toBe("block");
    expect(decideWrite({ method: "GET", url: `${BASE}/classRegistration/addCRNRegistrationItems?crnList=31187&term=120271` }, null)).toBe("block");
    expect(decideWrite({ method: "GET", url: `${BASE}/classRegistration/submitRegistration/batch` }, null)).toBe("block");
  });

  test("blocks unknown classRegistration calls and lookalike paths", () => {
    for (const req of [
      { method: "POST", url: `${BASE}/classRegistration/someNewWrite` },
      { method: "GET", url: `${BASE}/classRegistration/dropCourse?crn=1` },
      { method: "POST", url: `${BASE}/classRegistration/reset` },
      { method: "POST", url: `${BASE.toLowerCase()}/CLASSREGISTRATION/ADDCRNREGISTRATIONITEMS`, postData: "crnList=31187,31225&term=120271" },
      { method: "POST", url: `${BASE}//classRegistration//submitRegistration/batch` },
      { method: "POST", url: `${BASE}/classRegistration;jsessionid=x/submitRegistration/batch` },
      { method: "POST", url: `${BASE}/classRegistration/%73ubmitRegistration/batch` },
      { method: "POST", url: `${BASE}/foo/../classRegistration/submitRegistration/batch` },
      { method: "POST", url: "not a url" },
    ]) {
      expect(decideWrite(req, null)).toBe("block");
    }
  });
});

describe("decideWrite: authorized batch", () => {
  test("allows the exact add set on the term", () => {
    expect(decideWrite(add("crnList=31187,31225&term=120271"), AUTH)).toBe("allow");
    expect(decideWrite(add("crnList=31225%2C31187&term=120271"), AUTH)).toBe("allow");
    expect(decideWrite(submit([model("31187"), model("31225")]), AUTH)).toBe("allow");
  });

  test("blocks a different term, extra, missing, or repeated CRNs", () => {
    expect(decideWrite(add("crnList=31187,31225&term=120268"), AUTH)).toBe("block");
    expect(decideWrite(add("crnList=31187,31225,40000&term=120271"), AUTH)).toBe("block");
    expect(decideWrite(add("crnList=31187&term=120271"), AUTH)).toBe("block");
    expect(decideWrite(add("crnList=31187,31187,31225&term=120271"), AUTH)).toBe("block");
    expect(decideWrite(add("crnList=31187,31225"), AUTH)).toBe("block");
    expect(decideWrite(add("crnList=31187,31225&term=120271", `${BASE}/classRegistration/addCRNRegistrationItems?term=120268`), AUTH)).toBe("block");
    expect(decideWrite(submit([model("31187"), model("31225", "120268")]), AUTH)).toBe("block");
    expect(decideWrite(submit([model("31187"), model("31225"), model("40000")]), AUTH)).toBe("block");
    expect(decideWrite(submit([model("31187")]), AUTH)).toBe("block");
    expect(decideWrite(submit([model("31187"), model("31187"), model("31225")]), AUTH)).toBe("block");
  });

  test("blocks create/destroy arrays and unparseable bodies", () => {
    expect(decideWrite(submit([model("31187"), model("31225")], { destroy: [model("11111")] }), AUTH)).toBe("block");
    expect(decideWrite(submit([model("31187"), model("31225")], { create: [model("11111")] }), AUTH)).toBe("block");
    expect(decideWrite({ method: "POST", url: `${BASE}/classRegistration/submitRegistration/batch`, postData: "{oops" }, AUTH)).toBe("block");
    expect(decideWrite({ method: "POST", url: `${BASE}/classRegistration/submitRegistration/batch` }, AUTH)).toBe("block");
    expect(decideWrite({ ...submit([model("31187"), model("31225")]), postData: null, bodyUnavailable: true }, AUTH)).toBe("block");
  });

  test("allows at most the named drop", () => {
    const swap: AuthorizedBatch = { term: "120271", addCrns: ["31187"], dropCrn: "22222" };
    expect(decideWrite(submit([model("31187"), drop("22222")]), swap)).toBe("allow");
    expect(decideWrite(submit([model("31187"), drop("22222"), drop("33333")]), swap)).toBe("block");
    expect(decideWrite(submit([model("31187"), drop("33333")]), swap)).toBe("block");
    expect(decideWrite(submit([model("31187"), drop("22222")]), { ...swap, dropCrn: null })).toBe("block");
    expect(decideWrite(add("crnList=31187,22222&term=120271"), swap)).toBe("block");
  });
});

describe("decideWrite: submit body shape", () => {
  test("each model must carry the right action kind", () => {
    const swap: AuthorizedBatch = { term: "120271", addCrns: ["31187"], dropCrn: "22222" };
    // An add CRN carrying a drop action (would drop instead of add).
    expect(decideWrite(submit([drop("31187"), drop("22222")]), swap)).toBe("block");
    // The named drop carrying an add action.
    expect(decideWrite(submit([model("31187"), model("22222")]), swap)).toBe("block");
    // Missing, unknown, or ambiguous selected actions.
    expect(decideWrite(submit([{ ...model("31187"), selectedAction: null }]), { ...swap, dropCrn: null })).toBe("block");
    expect(decideWrite(submit([{ ...model("31187"), selectedAction: "ZZ" }]), { ...swap, dropCrn: null })).toBe("block");
    expect(decideWrite(submit([{ ...model("31187"), registrationActions: undefined }]), { ...swap, dropCrn: null })).toBe("block");
  });

  test("rejects unknown top-level keys", () => {
    expect(decideWrite(submit([model("31187"), model("31225")], { extra: 1 }), AUTH)).toBe("block");
    expect(decideWrite(submit([model("31187"), model("31225")], { term: "120271" }), AUTH)).toBe("block");
    expect(decideWrite({ method: "POST", url: `${BASE}/classRegistration/submitRegistration/batch`, postData: JSON.stringify([model("31187")]) }, AUTH)).toBe("block");
  });

  test("Banner on any port or scheme is still Banner", () => {
    for (const origin of ["https://banner.apps.uillinois.edu:8443", "http://banner.apps.uillinois.edu", "https://BANNER.apps.uillinois.edu.", "https://banner.apps.uillinois.edu:443"]) {
      expect(decideWrite({ method: "POST", url: `${origin}/StudentRegistrationSSB/ssb/classRegistration/submitRegistration/batch`, postData: "{}" }, null)).toBe("block");
    }
  });

  test("writes from a subframe or an unattributed source are blocked even when authorized", () => {
    const ok = submit([model("31187"), model("31225")]);
    expect(decideWrite({ ...ok, fromMainFrame: false }, AUTH)).toBe("block");
    expect(decideWrite({ ...add("crnList=31187,31225&term=120271"), fromMainFrame: false }, AUTH)).toBe("block");
    expect(decideWrite({ method: "GET", url: `${BASE}/classRegistration/getRegistrationEvents?termFilter=1`, fromMainFrame: false }, null)).toBe("allow");
  });
});

describe("installInterceptor", () => {
  test("refuses the webkit backend", async () => {
    const browser = new FakeBrowser(() => ({ url: "about:blank" }), "webkit");
    await expect(installInterceptor(browser, () => null, () => {})).rejects.toBeInstanceOf(InterceptorUnavailable);
  });

  function cdpFake(mainFrame = "MAIN") {
    const browser = new FakeBrowser(() => ({ url: "about:blank" }));
    const sent: { method: string; params: any }[] = [];
    const handlers = new Map<string, (p: any) => void>();
    browser.cdp = async <T,>(method: string, params?: Record<string, unknown>): Promise<T> => {
      sent.push({ method, params });
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: mainFrame } } } as T;
      return {} as T;
    };
    browser.onCdpEvent = (name: string, fn: (p: any) => void) => {
      handlers.set(name, fn);
      return () => handlers.delete(name);
    };
    return { browser, sent, handlers };
  }

  test("intercepts all requests, disables service workers, observes child targets", async () => {
    const { browser, sent } = cdpFake();
    await installInterceptor(browser, () => null, () => {});
    const enable = sent.find(s => s.method === "Fetch.enable")!;
    expect(enable.params.patterns).toEqual([{ urlPattern: "*", requestStage: "Request" }]);
    const script = sent.find(s => s.method === "Page.addScriptToEvaluateOnNewDocument")!;
    expect(script.params.source).toContain("serviceWorker");
    expect(sent.find(s => s.method === "Target.setAutoAttach")!.params).toMatchObject({ autoAttach: true, flatten: true });
  });

  test("continues reads and non-Banner requests, fails writes", async () => {
    const { browser, sent, handlers } = cdpFake();
    const blocked: string[] = [];
    const installed = await installInterceptor(browser, () => null, info => blocked.push(info.url));
    const paused = handlers.get("Fetch.requestPaused")!;
    paused({ requestId: "r1", frameId: "MAIN", request: { method: "GET", url: `${BASE}/classRegistration/getRegistrationEvents?termFilter=120271` } });
    paused({ requestId: "r2", frameId: "MAIN", request: { method: "POST", url: `${BASE}/classRegistration/submitRegistration/batch?x=secret`, postData: "{}" } });
    paused({ requestId: "r3", request: { method: "POST", url: "https://login.microsoftonline.com/common/login", postData: "x" } });
    await Bun.sleep(0);
    expect(sent.find(s => s.params?.requestId === "r1")!.method).toBe("Fetch.continueRequest");
    const failed = sent.find(s => s.params?.requestId === "r2")!;
    expect(failed.method).toBe("Fetch.failRequest");
    expect(failed.params.errorReason).toBe("BlockedByClient");
    expect(sent.find(s => s.params?.requestId === "r3")!.method).toBe("Fetch.continueRequest");
    expect(blocked).toEqual([`${BASE}/classRegistration/submitRegistration/batch`]);
    expect(installed.blockedCount()).toBe(1);
    await installed.uninstall();
    expect(handlers.size).toBe(0);
  });

  test("an authorized write from a subframe is failed", async () => {
    const { browser, sent, handlers } = cdpFake("MAIN");
    const auth: AuthorizedBatch = { term: "120271", addCrns: ["31187"], dropCrn: null };
    await installInterceptor(browser, () => auth, () => {});
    const paused = handlers.get("Fetch.requestPaused")!;
    const body = "crnList=31187&term=120271";
    await paused({ requestId: "main", frameId: "MAIN", request: { method: "POST", url: `${BASE}/classRegistration/addCRNRegistrationItems`, postData: body } });
    await paused({ requestId: "child", frameId: "CHILD", request: { method: "POST", url: `${BASE}/classRegistration/addCRNRegistrationItems`, postData: body } });
    await paused({ requestId: "none", request: { method: "POST", url: `${BASE}/classRegistration/addCRNRegistrationItems`, postData: body } });
    await Bun.sleep(0);
    expect(sent.find(s => s.params?.requestId === "main")!.method).toBe("Fetch.continueRequest");
    expect(sent.find(s => s.params?.requestId === "child")!.method).toBe("Fetch.failRequest");
    expect(sent.find(s => s.params?.requestId === "none")!.method).toBe("Fetch.failRequest");
  });

  test("a Banner child target is reported", async () => {
    const { browser, handlers } = cdpFake();
    const blocked: string[] = [];
    await installInterceptor(browser, () => null, info => blocked.push(info.method));
    handlers.get("Target.attachedToTarget")!({ targetInfo: { type: "service_worker", url: `${BASE}/sw.js` } });
    handlers.get("Target.attachedToTarget")!({ targetInfo: { type: "iframe", url: "about:blank" } });
    expect(blocked).toEqual(["child_target:service_worker"]);
  });
});
