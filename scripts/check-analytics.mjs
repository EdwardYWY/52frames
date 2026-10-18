#!/usr/bin/env node
// Browser regression checks with deterministic provider fixtures; no real analytics is sent.
// Requires Playwright + Chromium, installed separately (not a website dependency).
// node scripts/check-analytics.mjs [--site /path/to/baseline/site]
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { createRequire } from "node:module";
import { encodeSnapshot } from "../site/js/snapshot.js";
import { parseGscCinemas, parseGscShowtimes, parseTgvCinemas, parseTgvShowtimes } from "../site/js/providers.js";
import { parseXml } from "./xml.mjs";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const baseline = process.argv.includes("--site");
const site = resolve(baseline ? process.argv[process.argv.indexOf("--site") + 1] : "site");
const fixture = (name) => readFileSync(new URL(`../tests/fixtures/${name}`, import.meta.url), "utf8").replace(/^\uFEFF/, "");
const gscCinemas = parseGscCinemas(JSON.parse(fixture("gsc_locations.json")));
const tgvCinemas = parseTgvCinemas(JSON.parse(fixture("tgv_states.json")));
const gscShows = parseGscShowtimes(fixture("gsc_showtimes_120.xml"), gscCinemas[0], parseXml);
const tgvShows = parseTgvShowtimes(JSON.parse(fixture("tgv_sessions_PKL.json").replaceAll("2026-10-14", "2026-10-15")), tgvCinemas[0]);
const tomorrow = gscShows.map((s) => ({ ...s, business_date: "2026-10-16", start: s.start.replace("2026-10-16", "2026-10-17").replace("2026-10-15", "2026-10-16") }));
const concert = { ...gscShows[0], movie_title: "Test Concert", movie_key: "test concert", genres: ["Concert"] };
const cinemas = [...gscCinemas, ...tgvCinemas];
const snapshot = encodeSnapshot([
  { date: "2026-10-15", cinemas, showtimes: [...gscShows, ...tgvShows, concert], errors: [] },
  { date: "2026-10-16", cinemas, showtimes: tomorrow, errors: [] },
], "2026-10-15T04:00:00Z");
const origin = "https://edwardywy.github.io";
const mime = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".svg":"image/svg+xml", ".woff2":"font/woff2" };
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ["--disable-dev-shm-usage", "--disable-gpu"] });
try {
  for (const mobile of [false, true]) for (const blocked of [false, true, "module"]) {
    const context = await browser.newContext({ viewport: mobile ? {width:390,height:844} : {width:1280,height:900}, isMobile:mobile, hasTouch:mobile,
      geolocation:{latitude:3.14,longitude:101.69}, permissions:["geolocation"] });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    console.log(`Checking ${mobile ? "mobile" : "desktop"}, tag ${blocked === "module" ? "module-blocked" : blocked ? "blocked" : "mocked"}`);
    await page.clock.install({ time: new Date("2026-10-15T04:00:00Z") });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let failSeats = false;
    const bookRequests = [];
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      const send = (body, type="application/json") => route.fulfill({status:200,contentType:type,body});
      if (url.hostname === "www.googletagmanager.com") return blocked ? route.abort() : send("/* mocked Google tag: no visitor data sent */", "text/javascript");
      if (blocked === "module" && url.pathname.endsWith("/analytics.js")) return route.abort();
      if (url.origin === origin) {
        if (url.pathname.endsWith("/data/showtimes.json")) return send(JSON.stringify(snapshot));
        const path = url.pathname.replace(/^\/52frames\//, "") || "index.html";
        try { return route.fulfill({status:200,contentType:mime[extname(path)] || "application/octet-stream",body:readFileSync(resolve(site,path))}); }
        catch { return route.fulfill({status:404,body:""}); }
      }
      if (url.href.includes("SeatStatus") || url.href.endsWith("getseatplan")) {
        if (failSeats) return route.fulfill({status:503,body:"unavailable"});
        return send(fixture(url.href.includes("SeatStatus") ? "gsc_seats_120_hall5.xml" : "tgv_seatplan_BU0_indulge.json").replaceAll("0000000025", "twin").replaceAll("0000000026", "single"), url.href.includes("SeatStatus") ? "text/xml" : "application/json");
      }
      if (url.href.includes("Pricing")) return send(fixture("gsc_tickets.xml"),"text/xml");
      if (url.href.endsWith("gettickets")) return send(fixture("tgv_tickets.json"));
      if (url.href.includes("getShowTimesByLocation")) return send(fixture("gsc_showtimes_120.xml"),"text/xml");
      if (url.href.endsWith("moviesession_get")) return send(fixture("tgv_sessions_PKL.json").replaceAll("2026-10-14","2026-10-15"));
      if (url.href.includes("GetEpaymentLocations")) return send(fixture("gsc_locations.json"));
      if (url.href.includes("getstatecinema")) return send(fixture("tgv_states.json"));
      if (route.request().isNavigationRequest()) { bookRequests.push(url.href); return send("Booking destination", "text/html"); }
      return route.abort();
    });
    await page.goto(origin + "/52frames/?private=not-collected");
    await page.waitForFunction(() => document.querySelectorAll("#grid a.card").length >= 2);
    const count = () => page.locator("#grid a.card").count();
    const initial = await count();
    const select = async (id, value) => page.locator(`#${id}`).selectOption(value, {force:true});
    if (mobile) await page.locator("#filters-toggle").click();
    // Search, language search, clear, and keyboard shortcut.
    await page.locator("#q").fill("Go For Broke");
    await page.waitForTimeout(900);
    assert.equal(await count(),1);
    await page.locator("#clear-search").click();
    assert.equal(await count(),initial);
    await page.locator("#q").fill("Cantonese");
    assert.ok(await count() >= 1);
    await page.locator("#q").press("Escape");
    assert.equal(await count(),initial);
    await page.locator("#q").blur();
    await page.keyboard.press("/");
    assert.equal(await page.locator("#q").evaluate((n)=>n===document.activeElement),true);
    await page.locator("#q").blur();
    // Content, region, chain, sort and cinema dropdowns.
    await page.locator("#hide-concerts").uncheck();
    assert.equal(await count(),initial+1);
    await page.locator("#hide-concerts").check();
    await select("region","Southern");
    assert.equal(await count(),0);
    await select("region","");
    await page.locator("label.toggle.tgv").click();
    await page.waitForFunction(()=>document.querySelectorAll("#grid a.card").length===2);
    await page.locator("label.toggle.tgv").click();
    await select("sort","title");
    // Exercise the real styled dropdown, then return to all cinemas.
    await page.locator("#region").locator("..").locator(".cselect-button").click();
    await page.getByRole("option",{name:"Klang Valley",exact:true}).click();
    assert.equal(await page.locator("#region").inputValue(),"Klang Valley");
    await select("region","");
    const cinemaValue = `GSC|${gscCinemas[0].name}`;
    assert.ok(cinemaValue);
    await select("cinema",[cinemaValue]);
    assert.equal(await count(),2);
    await select("cinema",[]);
    // Open movie, dates, subtitle details, grouping, cinema filtering and stars.
    await page.locator("#q").fill("Go For Broke");
    await page.locator("#grid a.card").first().click();
    await page.locator("#sheet").waitFor({state:"visible"});
    await page.locator("#m-schedule .trow").first().waitFor();
    assert.match(await page.locator("#m-title").textContent(),/Go For Broke/);
    assert.ok(await page.locator("#m-dates input").count()>=2);
    await page.locator('#m-dates input[value="2026-10-16"]').check({force:true});
    await page.locator('#m-dates input[value="2026-10-15"]').check({force:true});
    await select("m-after","18:00");
    assert.ok(await page.locator("#m-schedule .trow").count()<3);
    await select("m-after","");
    await page.locator('input[name=group][value=cinema]').check({force:true});
    await page.locator("#m-schedule .venue").first().waitFor();
    await select("m-sort","name");
    await page.locator("#m-schedule .star").first().click();
    assert.equal(await page.locator("#star-count").textContent(),"1");
    await select("m-cinema",["*starred"]);
    assert.ok(await page.locator("#m-schedule .venue").count()>=1);
    await select("m-cinema",[]);
    await page.locator('input[name=group][value=time]').check({force:true});
    // Both chains' seat previews are checked below using a movie specific to that chain.
    const preview = async (expectFailure=false) => {
      const target = page.locator("#m-schedule .seat-hold").first();
      await target.scrollIntoViewIfNeeded();
      if (mobile) {
        await target.dispatchEvent("pointerdown",{pointerType:"touch",clientX:50,clientY:100});
        await page.waitForTimeout(1600);
        await target.dispatchEvent("pointerup",{pointerType:"touch"});
      } else { await target.hover(); await page.waitForTimeout(1600); }
      await page.locator(".seatmap").waitFor({state:"visible"});
      if (expectFailure) await page.getByText(/Couldn't load seats:/).waitFor();
      else {
        await page.locator(".seatmap .seat-grid").waitFor();
        await page.waitForFunction(()=>document.querySelector(".seat-prices")?.textContent.includes("RM"));
      }
      // The post-hold touch click must not trigger booking.
      if (mobile) {
        const before=bookRequests.length;
        await target.dispatchEvent("click",{bubbles:true,cancelable:true});
        assert.equal(bookRequests.length,before);
      }
      await page.locator(".seatmap-close").click();
      if (!mobile) await page.mouse.move(0,0);
    };
    await preview();
    failSeats=true;
    await preview(true);
    failSeats=false;
    // Ordinary tap still opens the booking destination.
    const popupPromise=context.waitForEvent("page");
    await page.locator("#m-schedule a.seat-hold").first().click();
    const popup=await popupPromise;
    await popup.waitForLoadState();
    assert.ok(bookRequests.length>=1);
    await popup.close();
    await page.keyboard.press("Escape");
    await page.locator("#sheet").waitFor({state:"hidden"});
    await page.locator("#clear-search").click();
    // Pick a TGV movie and ensure its map and price legend still render.
    const tgvTitle=tgvShows.find(s=>!gscShows.some(g=>g.movie_key===s.movie_key))?.movie_title;
    assert.ok(tgvTitle);
    await page.locator("#q").fill(tgvTitle);
    await page.locator("#grid a.card").first().click();
    await page.locator("#m-schedule .seat-hold").first().waitFor();
    await preview();
    await page.keyboard.press("Escape");
    await page.locator("#sheet").waitFor({state:"hidden"});
    await page.locator("#clear-search").click();
    // Location, saved stars, clearing stars, history and persistence.
    await page.locator("#locate").click();
    await page.waitForFunction(()=>document.querySelector("#locate").getAttribute("aria-pressed")==="true");
    await page.locator("#open-stars").click();
    await page.locator("#stars-mine .star").waitFor();
    await page.locator("#stars-mine .star").click();
    await page.locator("#stars-all .star").first().click();
    page.once("dialog",d=>d.accept());
    await page.locator("#stars-clear").click();
    assert.equal(await page.locator("#stars-mine .star").count(),0);
    await page.keyboard.press("Escape");
    await page.locator("#stars").waitFor({state:"hidden"});
    assert.deepEqual(errors,[]);
    if (!baseline && !blocked) {
      const events=await page.evaluate(()=>window.dataLayer.filter(a=>a[0]==="event").map(a=>a[1]));
      for (const name of ["page_view","search_used","filter_change","movie_open","cinema_star","stars_open","stars_clear","location_toggle","seat_preview_open","seat_preview_loaded","seat_preview_failed","booking_click"]) assert.ok(events.includes(name),`Missing ${name}`);
      assert.equal(events.filter(n=>n==="page_view").length,1);
      assert.equal(events.filter(n=>n==="booking_click").length,1, "touch holds must not count as booking clicks");
    }
    if (!baseline && blocked === true) assert.equal(await page.evaluate(()=>window.dataLayer.length),0);
    if (!baseline && blocked === "module") assert.equal(await page.evaluate(()=>window.dataLayer),undefined);
    // Saved stars and location preferences survive a reload.
    await page.locator("#open-stars").click();
    await page.locator("#stars-all .star").first().click();
    await page.keyboard.press("Escape");
    await page.reload();
    await page.waitForFunction(()=>document.querySelectorAll("#grid a.card").length>=2);
    assert.equal(await page.locator("#star-count").textContent(),"1");
    await page.waitForFunction(()=>document.querySelector("#locate").getAttribute("aria-pressed")==="true");
    assert.deepEqual(errors,[]);
    console.log(`PASS ${baseline?"baseline":"analytics"} ${mobile?"mobile":"desktop"} tag=${blocked==="module"?"module-blocked":blocked?"blocked":"mocked"}: search, filters, dates, grouping, stars, location, GSC/TGV seats/prices, failure, booking, dialogs; no page errors`);
    await context.close();
  }
} finally { await browser.close(); }
