// Where each TGV cinema is, by TGV cinema id: [latitude, longitude].
//
// TGV's own data only gives coordinates for some cinemas (inside a Google Maps link in the
// sessions response), and at least one of those is wrong. These were looked up once from
// OpenStreetMap (© OpenStreetMap contributors, ODbL) and checked by hand; a few are only accurate
// to about 1 km. GSC sends coordinates in its cinema list, so it needs no table.
// New TGV cinema missing here? It falls back to TGV's map link, or shows no distance.

export const TGV_LOCATIONS = {
  "1SM": [3.12201, 101.73995], // 1 Shamelin
  "BU0": [3.14947, 101.61564], // 1 Utama
  "1AV": [5.41337, 100.33131], // 1St Avenue Penang
  "ALM": [2.93957, 101.71028], // Alamanda
  "AMP": [3.15781, 101.75095], // Ampang Point
  "AU2": [3.17759, 101.74961], // Au2 Setiawangsa
  "BIN": [3.20075, 113.04722], // Boulevard Bintulu
  "BI0": [1.48153, 103.65582], // Bukit Indah
  "BKM": [5.32018, 100.47826], // Bukit Mertajam
  "BR0": [3.06203, 101.47115], // Bukit Raja
  "BBT": [2.99468, 101.4455], // Bukit Tinggi
  "ICT": [3.06254, 101.48193], // Central I-City
  "CHR": [3.03336, 101.76289], // Cheras Selatan
  "CTR": [3.07758, 101.74353], // Cheras Sentral
  "CYB": [2.92209, 101.65108], // Dpulze Cyberjaya
  "GUR": [5.4358, 100.31103], // Gurney Paragon
  "JAY": [3.10902, 101.63705], // Jaya Seksyen 14
  "KP0": [3.21411, 101.6395], // Kepong
  "IP0": [4.61357, 101.11871], // Kinta City
  "KUL": [1.64042, 103.61718], // Kulaijaya
  "MSR": [4.44059, 103.44749], // Mesra Mall
  "MN0": [3.02795, 101.7184], // Mines
  "IMP": [4.39922, 113.9903], // Miri
  "PBJ": [3.05106, 101.67051], // Pavilion Bukit Jalil
  "PDH": [3.146, 101.66333], // Pavilion Damansara Heights (New)
  "PKL": [3.14915, 101.71295], // Pavilion Kuala Lumpur (New)
  "RWK": [3.31665, 101.5365], // Rawang
  "KLE": [4.66036, 101.10962], // Sentra Mall Klebang
  "S20": [2.70182, 101.91189], // Seremban 2
  "MAN": [4.21972, 100.67115], // Seri Manjung
  "STW": [3.02884, 101.61523], // Setiawalk Puchong
  "S18": [4.5457, 101.07033], // Station 18 Ipoh
  "STR": [3.15559, 101.59368], // Strand Kota Damansara
  "SWP": [3.16639, 101.69239], // Sunway Putra
  "SW0": [3.07249, 101.60655], // Sunway Pyramid
  "SWS": [3.0646, 101.60579], // Sunway Square (New)
  "SWV": [3.12736, 101.72402], // Sunway Velocity
  "WWM": [3.1991, 101.74147], // Sunway Wangsa Mall
  "KLC": [3.15738, 101.71238], // Suria Klcc
  "TAI": [4.87243, 100.72928], // Taiping
  "TSC": [1.51413, 103.65444], // Tasek Central
  "TBR": [1.54952, 103.79578], // Tebrau City
  "KSL": [2.95785, 101.46617], // Tgv Ksl Klang (New)
  "TOP": [1.55293, 103.79785], // Toppen
  "VIV": [1.5268, 110.3693], // Vivacity Kuching
};

// GSC premium halls that GSC lists as cinemas of their own, under the same location id as the
// cinema they're in. The site shows them as halls of that cinema (hall type Prestige / Premiere),
// like its 4DX or IMAX halls. Only these, by GSC hall group: a new one stays its own cinema until
// it's added here.
export const GSC_PREMIUM_HALL_GROUPS = new Set([
  "PRESTIGE_1U2", // GSC HLB Prestige - 1 Utama (New Wing)
  "PMPLUS_IC2", // GSC Premiere - IOI City Mall 2 (East)
  "PMPLUS_PJB", // GSC Premiere - Paradigm JB
]);

// TGV cinema names in GSC's "Town - Mall" style, by TGV cinema id. TGV's own names are
// "TGV <mall>" (the chain badge already says TGV) and some carry "(New)". Mall names were checked
// against OpenStreetMap when the coordinates above were looked up.
// New TGV cinema missing here? It shows as "<State> - <TGV's name>" without the prefix.
export const TGV_NAMES = {
  "1SM": "Kuala Lumpur - 1 Shamelin",
  "BU0": "Petaling Jaya - 1 Utama",
  "1AV": "Penang - 1st Avenue",
  "ALM": "Putrajaya - Alamanda",
  "AMP": "Ampang - Ampang Point",
  "AU2": "Kuala Lumpur - AEON AU2 Setiawangsa",
  "BIN": "Bintulu - Boulevard",
  "BI0": "Johor Bahru - AEON Bukit Indah",
  "BKM": "Bukit Mertajam - AEON Bukit Mertajam",
  "BR0": "Klang - AEON Bukit Raja",
  "BBT": "Klang - AEON Bukit Tinggi",
  "ICT": "Shah Alam - Central i-City",
  "CHR": "Cheras - AEON Cheras Selatan",
  "CTR": "Kuala Lumpur - Cheras Sentral",
  "CYB": "Cyberjaya - DPulze",
  "GUR": "Penang - Gurney Paragon",
  "JAY": "Petaling Jaya - Jaya Shopping Centre",
  "KP0": "Kepong - AEON Metro Prima",
  "IP0": "Ipoh - AEON Kinta City",
  "KUL": "Kulai - AEON Kulaijaya",
  "MSR": "Kemaman - Mesra Mall",
  "MN0": "Seri Kembangan - The Mines",
  "IMP": "Miri - Imperial Mall",
  "PBJ": "Kuala Lumpur - Pavilion Bukit Jalil",
  "PDH": "Kuala Lumpur - Pavilion Damansara Heights",
  "PKL": "Kuala Lumpur - Pavilion Kuala Lumpur",
  "RWK": "Rawang - AEON Rawang Anggun",
  "KLE": "Ipoh - Sentra Mall Klebang",
  "S20": "Seremban - AEON Seremban 2",
  "MAN": "Seri Manjung - AEON Seri Manjung",
  "STW": "Puchong - SetiaWalk",
  "S18": "Ipoh - AEON Station 18",
  "STR": "Petaling Jaya - The Strand Kota Damansara",
  "SWP": "Kuala Lumpur - Sunway Putra",
  "SW0": "Subang Jaya - Sunway Pyramid",
  "SWS": "Subang Jaya - Sunway Square",
  "SWV": "Kuala Lumpur - Sunway Velocity",
  "WWM": "Kuala Lumpur - Sunway Wangsa Walk",
  "KLC": "Kuala Lumpur - Suria KLCC",
  "TAI": "Taiping - AEON Taiping",
  "TSC": "Johor Bahru - Tasek Central",
  "TBR": "Johor Bahru - AEON Tebrau City",
  "KSL": "Klang - KSL Esplanade",
  "TOP": "Johor Bahru - Toppen",
  "VIV": "Kuching - Vivacity Megamall",
};

/**
 * A TGV cinema's display name: the table above, else TGV's own name without the "TGV" prefix and
 * "(New)" tag, led by the state. Already-converted names come back unchanged.
 */
export function tgvCinemaName(id, rawName, stateLabel = "") {
  if (TGV_NAMES[id]) return TGV_NAMES[id];
  const name = String(rawName || id).replace(/^tgv\s+/i, "").replace(/\s*\(new\)\s*$/i, "").trim() || String(id);
  return stateLabel && !name.includes(" - ") ? `${stateLabel} - ${name}` : name;
}
