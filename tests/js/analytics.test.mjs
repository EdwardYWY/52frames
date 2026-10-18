import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnalytics, MEASUREMENT_ID } from "../../site/js/analytics.js";

function browser(hostname = "edwardywy.github.io") {
  const win = { location: { hostname, pathname: "/52frames/", origin: `https://${hostname}` }, navigator: {} };
  const scripts = [];
  const doc = { referrer: "https://example.com/link?private=secret#hidden", createElement: () => ({}), head: { append: (script) => scripts.push(script) } };
  return { win, doc, scripts, analytics: createAnalytics(win, doc) };
}
const commands = (win) => win.dataLayer.map((a) => [...a]);

test("production setup disables ads before loading Google and strips URL details", () => {
  const { win, scripts, analytics } = browser();
  analytics.init();
  analytics.init();
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].async, true);
  assert.ok(scripts[0].src.endsWith(MEASUREMENT_ID));
  const calls = commands(win);
  assert.deepEqual(calls[0], ["consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" }]);
  const config = calls.find(([type]) => type === "config")[2];
  assert.equal(config.allow_google_signals, false);
  assert.equal(config.allow_ad_personalization_signals, false);
  assert.equal(config.send_page_view, false);
  assert.equal(config.page_location, "https://edwardywy.github.io/52frames/");
  assert.equal(config.page_referrer, "https://example.com/link");
  assert.equal(calls.filter(([type, name]) => type === "event" && name === "page_view").length, 1);
});

test("events allow only declared fields, omit search text and coordinates, and bound strings", () => {
  const { win, analytics } = browser();
  analytics.init();
  analytics.track("search_used", { query: "private", latitude: 3 });
  analytics.track("booking_click", { chain: "GSC", movie: "a".repeat(200), url: "secret" });
  analytics.track("unknown", { secret: "private" });
  assert.deepEqual(commands(win).slice(-2), [["event", "search_used", {}], ["event", "booking_click", {chain:"GSC",movie:"a".repeat(100)}]]);
});

test("development, other Pages projects and privacy opt-outs send nothing", () => {
  for (const change of [(b) => b.win.location.hostname = "localhost", (b) => b.win.location.pathname = "/other/", (b) => b.win.navigator.doNotTrack = "1", (b) => b.win.navigator.globalPrivacyControl = true]) {
    const b = browser();
    change(b);
    b.analytics.init();
    b.analytics.track("search_used");
    assert.equal(b.scripts.length, 0);
    assert.equal(b.win.dataLayer, undefined);
  }
});

test("blocked Google scripts and broken analytics never throw or grow the queue forever", () => {
  const { win, scripts, analytics } = browser();
  analytics.init();
  for (let i = 0; i < 200; i++) analytics.track("search_used");
  assert.equal(win.dataLayer.length, 100);
  scripts[0].onerror();
  analytics.track("search_used");
  assert.equal(win.dataLayer.length, 0);
  assert.doesNotThrow(() => createAnalytics(undefined, undefined).init());
  const other = browser();
  other.analytics.init();
  other.win.gtag = () => { throw new Error("extension blocked tracking"); };
  assert.doesNotThrow(() => other.analytics.track("stars_open"));
});
