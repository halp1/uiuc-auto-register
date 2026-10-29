import { describe, expect, test } from "bun:test";
import { decideWrite, installInterceptor, InterceptorUnavailable, type AuthorizedBatch, type InterceptedRequest } from "../../src/banner/interceptor";
import { FakeBrowser } from "../auth/fake-browser";

const BASE = "https://banner.apps.uillinois.edu/StudentRegistrationSSB/ssb";
const ADD_URL = `${BASE}/classRegistration/addCRNRegistrationItems`;
const SUBMIT_URL = `${BASE}/classRegistration/submitRegistration/batch`;
const AUTH: AuthorizedBatch = { term: "120271", addCrns: ["31187", "31225"], dropCrn: null };
const SWAP: AuthorizedBatch = { term: "120271", addCrns: ["31187"], dropCrn: "22222" };
const ADD_ONLY: AuthorizedBatch = { ...SWAP, dropCrn: null };
const add = (body: string, url = ADD_URL): InterceptedRequest => ({ method: "POST", url, postData: body });
const submit = (update: unknown[], extra: Record<string, unknown> = {}): InterceptedRequest => ({
  method: "POST",
  url: SUBMIT_URL,
  postData: JSON.stringify({ create: [], update, destroy: [], uniqueSessionId: "abcde1", ...extra }),
});
const ACTIONS = [
  { courseRegistrationStatus: "RW", description: "**Web Registered**" },
  { courseRegistrationStatus: "DW", description: "Web Drop" },
];
const model = (crn: string, term = "120271", selectedAction = "RW") => ({ courseReferenceNumber: crn, term, registrationActions: ACTIONS, selectedAction });
const drop = (crn: string) => model(crn, "120271", "DW");
const OK_SUBMIT = submit([model("31187"), model("31225")]);

describe("decideWrite", () => {
  test.each<[string, InterceptedRequest, AuthorizedBatch | null]>([
    ["classRegistration page", { method: "GET", url: `${BASE}/classRegistration/classRegistration` }, null],
    ["calendar read", { method: "GET", url: `${BASE}/classRegistration/getRegistrationEvents?termFilter=120271` }, null],
    ["working-set reset GET", { method: "GET", url: `${BASE}/classRegistration/reset?selectedTab=true&term=120271` }, null],
    ["enrollment info", { method: "GET", url: `${BASE}/searchResults/getEnrollmentInfo?term=120271&courseReferenceNumber=31187` }, null],
    ["term selection", { method: "GET", url: `${BASE}/term/termSelection?mode=registration` }, null],
    ["SAML endpoint", { method: "GET", url: "https://banner.apps.uillinois.edu/StudentRegistrationSSB/saml2/authenticate/studentregistrationssb" }, null],
    ["non-Banner host", { method: "GET", url: "https://login.microsoftonline.com/common/login" }, null],
    ["term search POST", { method: "POST", url: `${BASE}/term/search?mode=registration`, postData: "term=120271" }, null],
    ["class search reset POST", { method: "POST", url: `${BASE}/classSearch/resetDataForm` }, null],
    ["subframe read", { method: "GET", url: `${BASE}/classRegistration/getRegistrationEvents?termFilter=1`, fromMainFrame: false }, null],
    ["authorized add set", add("crnList=31187,31225&term=120271"), AUTH],
    ["authorized add set, encoded and reordered", add("crnList=31225%2C31187&term=120271"), AUTH],
    ["authorized submit", OK_SUBMIT, AUTH],
    ["authorized swap with the named drop", submit([model("31187"), drop("22222")]), SWAP],
  ])("allows %s", (_name, req, auth) => {
    expect(decideWrite(req, auth)).toBe("allow");
  });

  test.each<[string, InterceptedRequest, AuthorizedBatch | null]>([
    // No authorization: every write path.
    ["unauthorized add", add("crnList=31187,31225&term=120271"), null],
    ["unauthorized submit", OK_SUBMIT, null],
    ["addRegistrationItem", { method: "POST", url: `${BASE}/classRegistration/addRegistrationItem`, postData: "term=120271&courseReferenceNumber=31187" }, null],
    ["add via GET", { method: "GET", url: `${ADD_URL}?crnList=31187&term=120271` }, null],
    ["submit via GET", { method: "GET", url: SUBMIT_URL }, null],
    // Unknown classRegistration calls and lookalike paths.
    ["unknown classRegistration POST", { method: "POST", url: `${BASE}/classRegistration/someNewWrite` }, null],
    ["unknown classRegistration GET", { method: "GET", url: `${BASE}/classRegistration/dropCourse?crn=1` }, null],
    ["reset via POST", { method: "POST", url: `${BASE}/classRegistration/reset` }, null],
    ["uppercase path", { method: "POST", url: `${BASE.toLowerCase()}/CLASSREGISTRATION/ADDCRNREGISTRATIONITEMS`, postData: "crnList=31187,31225&term=120271" }, null],
    ["doubled slashes", { method: "POST", url: `${BASE}//classRegistration//submitRegistration/batch` }, null],
    ["matrix params", { method: "POST", url: `${BASE}/classRegistration;jsessionid=x/submitRegistration/batch` }, null],
    ["percent-encoded path", { method: "POST", url: `${BASE}/classRegistration/%73ubmitRegistration/batch` }, null],
    ["dot-dot path", { method: "POST", url: `${BASE}/foo/../classRegistration/submitRegistration/batch` }, null],
    ["unparseable URL", { method: "POST", url: "not a url" }, null],
    ...["https://banner.apps.uillinois.edu:8443", "http://banner.apps.uillinois.edu", "https://BANNER.apps.uillinois.edu.", "https://banner.apps.uillinois.edu:443"].map(
      origin => [`Banner at ${origin}`, { method: "POST", url: `${origin}/StudentRegistrationSSB/ssb/classRegistration/submitRegistration/batch`, postData: "{}" }, null] as [string, InterceptedRequest, null],
    ),
    // Add items that do not match the authorized batch.
    ["add on another term", add("crnList=31187,31225&term=120268"), AUTH],
    ["add with an extra CRN", add("crnList=31187,31225,40000&term=120271"), AUTH],
    ["add missing a CRN", add("crnList=31187&term=120271"), AUTH],
    ["add with a repeated CRN", add("crnList=31187,31187,31225&term=120271"), AUTH],
    ["add without a term", add("crnList=31187,31225"), AUTH],
    ["add with body and query terms disagreeing", add("crnList=31187,31225&term=120271", `${ADD_URL}?term=120268`), AUTH],
    ["add including the drop CRN", add("crnList=31187,22222&term=120271"), SWAP],
    // Submit bodies that do not match the authorized batch.
    ["submit on another term", submit([model("31187"), model("31225", "120268")]), AUTH],
    ["submit with an extra CRN", submit([model("31187"), model("31225"), model("40000")]), AUTH],
    ["submit missing a CRN", submit([model("31187")]), AUTH],
    ["submit with a repeated CRN", submit([model("31187"), model("31187"), model("31225")]), AUTH],
    ["submit with destroy", submit([model("31187"), model("31225")], { destroy: [model("11111")] }), AUTH],
    ["submit with create", submit([model("31187"), model("31225")], { create: [model("11111")] }), AUTH],
    ["unparseable submit body", { method: "POST", url: SUBMIT_URL, postData: "{oops" }, AUTH],
    ["submit without a body", { method: "POST", url: SUBMIT_URL }, AUTH],
    ["submit whose body was not available", { ...OK_SUBMIT, postData: null, bodyUnavailable: true }, AUTH],
    ["submit with an unknown top-level key", submit([model("31187"), model("31225")], { extra: 1 }), AUTH],
    ["submit with a top-level term key", submit([model("31187"), model("31225")], { term: "120271" }), AUTH],
    ["submit body that is an array", { method: "POST", url: SUBMIT_URL, postData: JSON.stringify([model("31187")]) }, AUTH],
    // Drops and action kinds.
    ["a second drop", submit([model("31187"), drop("22222"), drop("33333")]), SWAP],
    ["a drop of a different CRN", submit([model("31187"), drop("33333")]), SWAP],
    ["a drop when none is authorized", submit([model("31187"), drop("22222")]), ADD_ONLY],
    ["an add CRN carrying a drop action", submit([drop("31187"), drop("22222")]), SWAP],
    ["the named drop carrying an add action", submit([model("31187"), model("22222")]), SWAP],
    ["no selected action", submit([{ ...model("31187"), selectedAction: null }]), ADD_ONLY],
    ["an unknown selected action", submit([{ ...model("31187"), selectedAction: "ZZ" }]), ADD_ONLY],
    ["no registration actions", submit([{ ...model("31187"), registrationActions: undefined }]), ADD_ONLY],
    // Frame attribution.
    ["an authorized submit from a subframe", { ...OK_SUBMIT, fromMainFrame: false }, AUTH],
    ["an authorized add from a subframe", { ...add("crnList=31187,31225&term=120271"), fromMainFrame: false }, AUTH],
  ])("blocks %s", (_name, req, auth) => {
    expect(decideWrite(req, auth)).toBe("block");
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
