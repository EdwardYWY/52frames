// Hall types: the chains label each show's hall with their own codes ("2D", "DELUXE", "ATMOS BIG
// DBOX", "INFINITY-V__ONYX", "IMAXLASER"). Each code is its own type, except the plain halls
// (Standard), the children's halls (Kids) and IMAX: TGV marks its laser halls IMAXLASER while GSC
// calls every IMAX hall plain IMAX, laser or not, so the two can't be told apart.
// A show can be several types at once: "ATMOS BIG DBOX" is Dolby Atmos, BIG and D-BOX.

const GROUPS = { "2D": "standard", DELUXE: "standard", PLAY: "kids", JUNIOR: "kids", IMAXLASER: "IMAX" };

const LABELS = {
  standard: "Standard · 2D, Deluxe",
  kids: "Kids · Play, Junior",
  INFINITY: "Infinity",
  "INFINITY-V": "Infinity-V",
  SCREENX: "ScreenX",
  DBOX: "D-BOX",
  ATMOS: "Dolby Atmos",
  GETHA: "Getha",
  PREMIERE: "Premiere",
  PRESTIGE: "Prestige",
  VELVET: "Velvet",
  INDULGE: "Indulge",
  "INDULGE-BED": "Indulge Bed",
  "INDULGE-COWAY-BEREX": "Indulge Coway Berex",
  CABIN: "Comfort Cabin",
  PRIVATE: "Private Screen",
  STUDIO: "Escape Studio",
  PLS: "Premium (PLS)",
  BEANIE: "Beanie",
};

/** What a hall type is called in the menu; unknown codes as the chain wrote them. */
export const hallLabel = (type) => LABELS[type] || type;

const FIRST = ["standard", "IMAX"];

/** Menu order: Standard and IMAX first, then the rest A–Z, then Kids. */
export function sortHallTypes(types) {
  const rank = (t) => (FIRST.includes(t) ? FIRST.indexOf(t) : t === "kids" ? FIRST.length + 1 : FIRST.length);
  return [...types].sort((a, b) => rank(a) - rank(b) || hallLabel(a).localeCompare(hallLabel(b)));
}

const seen = new Map(); // label -> types; the same few dozen labels repeat across ~25k shows

/** The hall types of a show's experience label, e.g. "ATMOS BIG" -> ["ATMOS", "BIG"]. */
export function hallTypes(experience) {
  const label = (experience || "").toUpperCase().trim();
  let types = seen.get(label);
  if (types) return types;
  const found = new Set();
  for (const code of label.split(/[\s_]+/).filter(Boolean)) {
    found.add(GROUPS[code] || GROUPS[code.split("-")[0]] || code); // JUNIOR-HOTWHEEL is Kids
  }
  // "Standard" only when nothing else is on the label (a plain 2D or Deluxe hall).
  if (found.size > 1) found.delete("standard");
  types = [...found];
  seen.set(label, types);
  return types;
}
