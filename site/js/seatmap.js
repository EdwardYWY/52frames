// A hidden extra: keep the mouse on a showtime for 1.5 seconds, or press and hold it on a touch
// screen, to see that show's live seat map, straight from the chain (GSC or TGV). Nothing is
// fetched until the hold is complete. A plain tap or click still opens the booking page.

export const HOLD_MS = 1500;
const TRACE_DELAY_MS = 300; // the outline starts after this, so passing over a time doesn't flash it
const MOVE_PX = 10; // a finger that moves this far is scrolling, not holding
const CLOSE_DELAY_MS = 250; // mouse: time to travel from the showtime into the seat map

const STATE_LABEL = { free: "available", sold: "sold", blocked: "unavailable" };

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined && child !== false) node.append(child);
  return node;
}

const clock = () => new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kuala_Lumpur", hour: "2-digit", minute: "2-digit" });

/** The seat grid, screen at the top. */
export function seatGrid(plan) {
  const columns = Math.max(0, ...plan.rows.map((row) => row.seats.length));
  const rows = plan.rows.map((row) => {
    if (!row.seats.some(Boolean)) return el("div", { class: "seat-aisle", "aria-hidden": "true" });
    // Twin seats side by side join into one box with a line between them (pair-l | pair-r).
    const side = [];
    row.seats.forEach((seat, i) => {
      if (seat?.pair && !side[i] && row.seats[i + 1]?.pair) {
        side[i] = " pair-l";
        side[i + 1] = " pair-r";
      }
    });
    return [
      el("span", { class: "seat-row" }, row.label),
      row.seats.map((seat, i) =>
        seat
          ? el("span", {
              class: `seat ${seat.state}${seat.pair ? " pair" : ""}${seat.oku ? " oku" : ""}${side[i] || ""}`,
              title: `${seat.number}${seat.oku ? " · OKU" : ""} · ${STATE_LABEL[seat.state]}`,
            })
          : el("span", { class: "seat-gap" }),
      ),
      el("span", { class: "seat-row" }, row.label),
    ];
  });
  return el("div", { class: "seat-grid", style: `--cols: ${columns}`, role: "img", "aria-label": `${plan.free} of ${plan.total} seats available` }, rows);
}

/** Match tickets to the seat categories actually in this hall, keeping concessions labelled. */
export function seatPriceEntries(plan, prices) {
  const seats = plan.rows.flatMap((row) => row.seats).filter(Boolean);
  const entries = new Map();
  for (const ticket of prices) {
    const seat = seats.find((seat) => seat.category && seat.category === ticket.category);
    if (!seat) continue;
    const name = seat.categoryName || (seat.pair ? "Twin" : seat.oku ? "Wheelchair" : "Normal");
    const label = /^(adult|single|twin)$/i.test(ticket.label) ? name : `${name} (${ticket.label})`;
    const unit = ticket.seatsTaken === 2 ? " (pair)" : ticket.seatsTaken > 2 ? ` (${ticket.seatsTaken} seats)` : "";
    const text = `${label} · RM ${ticket.amount.toFixed(2)}${unit}`;
    entries.set(text, { text, pair: seat.pair, oku: seat.oku });
  }
  return [...entries.values()];
}

/**
 * Watch `root` for holds on elements matching `selector`.
 * showFor(element) gives the show behind a showtime; fetchPlan(show, signal) its seat plan.
 * fetchPrices(show, signal) runs alongside it; unavailable prices leave the seats alone.
 */
export function enableSeatPreview(root, { selector, showFor, fetchPlan, fetchPrices = async () => [], onEvent = () => {} }) {
  const report = (name, show) => {
    try { onEvent(name, { chain: show.chain }); } catch {}
  };
  let timer = null;
  let holding = null; // the showtime being held
  let origin = null; // where the finger went down
  let anchor = null; // the showtime whose seat map is open
  let mode = "mouse";
  let controller = null;
  let closeTimer = null;
  let swallowClick = false;

  const pop = el("div", { class: "seatmap", role: "dialog", "aria-label": "Live seat map", hidden: true });
  document.body.append(pop);

  /**
   * The outline that runs round a held showtime. Drawn in the element's own pixels, so the line
   * moves at the same speed along the long and the short sides.
   */
  function traceOutline(target) {
    // Drawn just outside the showtime, on the page's dark background, where yellow shows up.
    const pad = 3;
    // Exact (fractional) size: a rounded one made the browser shrink and centre the drawing,
    // which pulled the side lines into the row.
    const box = target.getBoundingClientRect();
    const w = box.width + pad * 2;
    const h = box.height + pad * 2;
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "hold-trace");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.style.setProperty("--hold-ms", `${HOLD_MS - TRACE_DELAY_MS}ms`);
    svg.style.setProperty("--hold-delay", `${TRACE_DELAY_MS}ms`);
    // From the top middle, clockwise, back to the top middle, over a black track.
    const d = `M${w / 2} 1.5H${w - 1.5}V${h - 1.5}H1.5V1.5Z`;
    for (const cls of ["hold-track", "hold-line"]) {
      const path = document.createElementNS(ns, "path");
      path.setAttribute("class", cls);
      path.setAttribute("d", d);
      path.setAttribute("pathLength", "1");
      svg.append(path);
    }
    target.append(svg);
    return svg;
  }

  let trace = null;
  function cancelHold() {
    clearTimeout(timer);
    timer = null;
    holding?.classList.remove("holding");
    holding = null;
    trace?.remove();
    trace = null;
  }

  function startHold(target, e) {
    cancelHold();
    const show = showFor(target);
    if (!show) return;
    holding = target;
    origin = { x: e.clientX, y: e.clientY };
    const type = e.pointerType;
    target.classList.add("holding");
    trace = traceOutline(target);
    timer = setTimeout(() => {
      cancelHold();
      // The finger is still down: the click that follows its release must not open the booking page.
      if (type !== "mouse") swallowClick = true;
      open(target, show, type === "mouse" ? "mouse" : "touch");
    }, HOLD_MS);
  }

  function close() {
    clearTimeout(closeTimer);
    controller?.abort();
    controller = null;
    anchor = null;
    pop.hidden = true;
    pop.replaceChildren();
  }

  const closeSoon = () => {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, CLOSE_DELAY_MS);
  };

  /** Next to the showtime with a mouse; a bottom sheet on touch screens. */
  function place() {
    pop.classList.toggle("as-sheet", mode === "touch");
    if (mode === "touch" || !anchor) {
      pop.style.left = pop.style.top = "";
      return;
    }
    const box = anchor.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    const left = Math.min(Math.max(8, box.left), window.innerWidth - width - 8);
    const below = box.bottom + 6;
    const top = below + height <= window.innerHeight - 8 ? below : Math.max(8, box.top - height - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function open(target, show, how) {
    report("seat_preview_open", show);
    close();
    anchor = target;
    mode = how;
    pop.dataset.chain = show.chain;
    controller = new AbortController();
    const { signal } = controller;
    const head = el(
      "div",
      { class: "seatmap-head" },
      el("b", {}, show.start.slice(11, 16)),
      el("span", {}, [show.hall, show.experience].filter(Boolean).join(" · ")),
      el("button", { type: "button", class: "seatmap-close", "aria-label": "Close seat map", onclick: close }, "✕"),
    );
    const sub = el("div", { class: "seatmap-sub mono" }, show.cinema_name);
    const body = el("div", { class: "seatmap-body" }, el("p", { class: "seatmap-note mono" }, "Loading live seats…"));
    pop.replaceChildren(head, sub, body);
    pop.hidden = false;
    place();
    const priceLegend = el("div", { class: "seat-legend seat-prices mono", "aria-live": "polite" });
    let loadedPlan = null;
    let prices = [];
    const showPrices = () => {
      if (signal.aborted || !loadedPlan) return;
      const entries = seatPriceEntries(loadedPlan, prices);
      priceLegend.replaceChildren(
        ...entries.map((entry) => el("span", {}, el("i", { class: `seat ${entry.pair ? "twin" : "free"}${entry.oku ? " oku" : ""}` }), entry.text)),
        ...(entries.length && show.chain === "TGV" ? [el("small", { class: "seat-price-note" }, "RM 0.50 processing fee at checkout")] : []),
      );
      place();
    };
    fetchPrices(show, signal).then((value) => {
      prices = value;
      showPrices();
    }).catch(() => {}); // prices are optional; the live seats stand on their own
    fetchPlan(show, signal).then(
      (plan) => {
        if (signal.aborted) return;
        report("seat_preview_loaded", show);
        loadedPlan = plan;
        sub.textContent = `${show.cinema_name} · ${plan.free} of ${plan.total} seats left`;
        body.replaceChildren(
          el("div", { class: "seat-screen" }, "Screen"),
          seatGrid(plan),
          el(
            "div",
            { class: "seat-legend mono" },
            el("span", {}, el("i", { class: "seat free" }), "Available"),
            el("span", {}, el("i", { class: "seat sold" }), "Sold"),
            el("span", {}, el("i", { class: "seat blocked" }), "Unavailable"),
            // Twin and sofa seats are sold in pairs; only shown when the hall has them.
            plan.rows.some((row) => row.seats.some((seat) => seat?.pair)) ? el("span", {}, el("i", { class: "seat twin" }), "Twin seat") : null,
            plan.rows.some((row) => row.seats.some((seat) => seat?.oku)) ? el("span", {}, el("i", { class: "seat free oku" }), "OKU") : null,
            el("span", { class: "seat-when" }, `Live from ${show.chain} · ${clock()}`),
          ),
          priceLegend,
        );
        showPrices();
        place();
      },
      (err) => {
        if (signal.aborted) return;
        report("seat_preview_failed", show);
        body.replaceChildren(el("p", { class: "seatmap-note mono" }, `Couldn't load seats: ${err.message || err}`));
        place();
      },
    );
  }

  const showtimeAt = (node) => {
    const target = node instanceof Element ? node.closest(selector) : null;
    return target && root.contains(target) ? target : null;
  };

  // Mouse: resting on a showtime starts the clock; leaving it stops the clock or closes the map.
  root.addEventListener("pointerover", (e) => {
    if (e.pointerType !== "mouse") return;
    const target = showtimeAt(e.target);
    if (target && target === anchor) clearTimeout(closeTimer);
    else if (target && target !== holding) startHold(target, e);
  });
  root.addEventListener("pointerout", (e) => {
    if (e.pointerType !== "mouse") return;
    const target = showtimeAt(e.target);
    if (!target || target.contains(e.relatedTarget)) return;
    if (target === holding) cancelHold();
    if (target === anchor && mode === "mouse" && !pop.contains(e.relatedTarget)) closeSoon();
  });
  pop.addEventListener("pointerenter", () => clearTimeout(closeTimer));
  pop.addEventListener("pointerleave", (e) => {
    if (mode === "mouse" && !(anchor && anchor.contains(e.relatedTarget))) closeSoon();
  });

  // Touch and pen: press and hold without moving. A link's own long-press menu (open in new tab,
  // preview, copy) appears before the hold completes, and some phones won't let a page cancel it, so while a
  // finger is down the showtime isn't a link. It is again by the time a quick tap's click arrives.
  let pressed = null;
  const unlink = (target) => {
    pressed = target;
    if (!target.hasAttribute("href")) return;
    target.dataset.href = target.getAttribute("href");
    target.removeAttribute("href");
  };
  const relink = () => {
    if (pressed?.dataset.href) {
      pressed.setAttribute("href", pressed.dataset.href);
      delete pressed.dataset.href;
    }
    pressed = null;
  };
  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    const target = showtimeAt(e.target);
    if (!target) return;
    relink();
    unlink(target);
    startHold(target, e);
  });
  root.addEventListener("pointermove", (e) => {
    if (!holding || e.pointerType === "mouse") return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > MOVE_PX) cancelHold();
  });
  for (const type of ["pointerup", "pointercancel"]) {
    root.addEventListener(type, (e) => {
      if (e.pointerType === "mouse") return;
      cancelHold();
      relink();
    });
  }
  // Belt and braces: no long-press menu while a finger is on a showtime.
  root.addEventListener("contextmenu", (e) => {
    if (holding || pressed || swallowClick) e.preventDefault();
  });
  root.addEventListener(
    "click",
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  // A touch that starts somewhere else is the next thing the visitor does: forget the swallow.
  document.addEventListener("pointerdown", (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !(mode === "mouse" && anchor?.contains(e.target))) close();
    if (e.pointerType !== "mouse" && !showtimeAt(e.target)) swallowClick = false;
  });

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape" || pop.hidden) return;
      e.stopPropagation(); // close the seat map only, not the movie view behind it
      close();
    },
    true,
  );
  // Scrolling moves the showtime away from a map placed next to it.
  window.addEventListener(
    "scroll",
    (e) => {
      if (!pop.hidden && mode === "mouse" && !pop.contains(e.target)) close();
    },
    true,
  );
  window.addEventListener("resize", () => !pop.hidden && place());

  return { close };
}
