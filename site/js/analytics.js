// GA4 is optional: never await it or let tracking failures affect the page.
export const MEASUREMENT_ID = "G-HJQD0PND68";
const EVENTS = {
  movie_open: ["movie"],
  search_used: [],
  filter_change: ["control", "value"],
  cinema_star: ["chain", "action"],
  cinema_open: ["chain"],
  stars_open: [],
  stars_clear: [],
  location_toggle: ["action"],
  booking_click: ["chain", "movie"],
  seat_preview_open: ["chain"],
  seat_preview_loaded: ["chain"],
  seat_preview_failed: ["chain"],
};

export function createAnalytics(win, doc) {
  let ready = false;
  // A blocked tag must not accumulate an unbounded queue during a long visit.
  const MAX_PENDING = 100;
  function command(...args) {
    if (!ready) return;
    // Google wraps push() when it processes the queue. A blocker can load a stub instead;
    // keep that still-native queue bounded even when the script's load event has fired.
    if (win.dataLayer.push === Array.prototype.push && win.dataLayer.length >= MAX_PENDING) return;
    win.gtag(...args);
  }
  function init() {
    if (ready) return;
    try {
      // Local development, PR previews and automated tests don't pollute the real property.
      if (win.location.hostname !== "edwardywy.github.io" || !win.location.pathname.startsWith("/52frames/")) return;
      if (win.navigator.globalPrivacyControl || win.navigator.doNotTrack === "1" ||
          win.doNotTrack === "1" || win.navigator.msDoNotTrack === "1") return;
      win.dataLayer = win.dataLayer || [];
      win.gtag = win.gtag || function () { win.dataLayer.push(arguments); };
      ready = true;
      command("consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" });
      command("set", "ads_data_redaction", true);
      command("js", new Date());
      // Omit query strings and movie hashes from automatically attached URL fields.
      let referrer = "";
      try { const url = new URL(doc.referrer); referrer = url.origin + url.pathname; } catch {}
      command("config", MEASUREMENT_ID, {
        allow_google_signals: false,
        allow_ad_personalization_signals: false,
        send_page_view: false,
        page_location: win.location.origin + win.location.pathname,
        page_referrer: referrer,
        page_title: "52 Frames",
      });
      command("event", "page_view");
      const script = doc.createElement("script");
      script.async = true;
      script.src = `https://www.googletagmanager.com/gtag/js?id=${MEASUREMENT_ID}`;
      script.onerror = () => { ready = false; win.dataLayer.length = 0; };
      doc.head.append(script);
    } catch {
      ready = false;
    }
  }
  function track(name, params = {}) {
    try {
      if (!Object.hasOwn(EVENTS, name)) return;
      const safe = {};
      for (const key of EVENTS[name]) {
        const value = params[key];
        if (typeof value === "string") safe[key] = value.slice(0, 100);
      }
      command("event", name, safe);
    } catch {
      // Analytics is never a prerequisite for browsing or booking.
    }
  }
  return { init, track };
}

const analytics = createAnalytics(globalThis.window, globalThis.document);
export const initAnalytics = analytics.init;
export const track = analytics.track;
