// Isometric skyline viewer — fetches /skyline.svg, recovers the real
// bearing/height samples from its rendered polyline (the endpoint only
// returns SVG, not raw JSON, so this is the same "decode the server's own
// rendered output" approach sketch.js already uses for elevation tiles),
// then re-projects them as a ring in isometric view instead of an unrolled
// strip. No p5.js dependency, despite living alongside the sketches that do.

const LON_DEFAULT = -1.6;
const LAT_DEFAULT = 55.0;
const RADIUS_KM_DEFAULT = 15;
const DIRECTIONS_DEFAULT = 360;

// Ground-plane render constants
const R = 230;                        // ring radius, SVG user units
const KX = Math.cos(Math.PI / 6);     // true isometric ground-line angle (30deg)
const KY = Math.sin(Math.PI / 6);
const PX_PER_M = 0.5;                 // vertical legibility scale — no real horizontal
                                       // distance axis here to tie a "true scale" to
const RING_SAMPLES = 144;
const PAD = 24;

// Isometric projection rotates a true ground-plane circle into a screen
// ellipse. Bearing 0 (north) only lands at the ellipse's screen-top vertex
// if the ground angle is offset by -45deg first — see the derivation notes
// in the main README's Skyline profile section.
function groundPoint(bearingDeg) {
  const t = ((bearingDeg - 45) * Math.PI) / 180;
  return { dx: R * Math.sin(t), dy: -R * Math.cos(t) };
}

function isoProject(dx, dy, z) {
  return { x: (dx - dy) * KX, y: (dx + dy) * KY - z };
}

function parseSkylineSVG(svgText, radiusKm) {
  const widthMatch = svgText.match(/<svg[^>]*\swidth="([\d.]+)"/);
  const pointsMatch = svgText.match(/points="([^"]+)"/);
  if (!widthMatch || !pointsMatch) throw new Error("Couldn't parse /skyline.svg response");

  const width = parseFloat(widthMatch[1]);
  const scale = width / (radiusKm * 1000); // px per metre, matches the server's own formula
  const pts = pointsMatch[1].trim().split(" ").map(p => {
    const [x, y] = p.split(",").map(Number);
    return { x, y };
  });

  const n = pts.length - 1; // drop the duplicated closing point (bearing 360 === bearing 0)
  const data = new Array(n);
  for (let i = 0; i < n; i++) {
    data[i] = { bearing: (i / n) * 360, heightM: -pts[i].y / scale };
  }
  return data;
}

function buildIsometricSVG(data) {
  const linePts = data.map(({ bearing, heightM }) => {
    const { dx, dy } = groundPoint(bearing);
    return isoProject(dx, dy, heightM * PX_PER_M);
  });
  linePts.push(linePts[0]); // close the loop exactly

  const ringPts = [];
  for (let i = 0; i <= RING_SAMPLES; i++) {
    const { dx, dy } = groundPoint((i / RING_SAMPLES) * 360);
    ringPts.push(isoProject(dx, dy, 0));
  }

  const compass = [["N", 0], ["E", 90], ["S", 180], ["W", 270]].map(([label, bearing]) => {
    const { dx, dy } = groundPoint(bearing);
    return { label, ...isoProject(dx * 1.12, dy * 1.12, 0) };
  });

  const start = linePts[0];

  const all = [...linePts, ...ringPts, ...compass];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of all) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  minX -= PAD; maxX += PAD; minY -= PAD; maxY += PAD;
  const vbW = maxX - minX, vbH = maxY - minY;
  const fmt = p => `${(p.x - minX).toFixed(1)},${(p.y - minY).toFixed(1)}`;

  const compassEls = compass.map(c =>
    `<text class="compass" x="${(c.x - minX).toFixed(1)}" y="${(c.y - minY).toFixed(1)}">${c.label}</text>`
  ).join("");

  return `<svg viewBox="0 0 ${vbW.toFixed(1)} ${vbH.toFixed(1)}" xmlns="http://www.w3.org/2000/svg">` +
    `<polyline class="ring" points="${ringPts.map(fmt).join(" ")}" />` +
    `<polyline class="skyline" points="${linePts.map(fmt).join(" ")}" />` +
    compassEls +
    `<circle class="start" cx="${(start.x - minX).toFixed(1)}" cy="${(start.y - minY).toFixed(1)}" r="3.5" />` +
    `</svg>`;
}

async function loadSkyline(lon, lat, radiusKm, directions) {
  const statusEl = document.getElementById("status");
  statusEl.textContent = "loading…";

  try {
    const url = `/skyline.svg?lon=${lon}&lat=${lat}&radius=${radiusKm}&directions=${directions}&heightScale=1&width=800`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Server returned ${res.status}`);

    const data = parseSkylineSVG(await res.text(), radiusKm);
    document.getElementById("stage").innerHTML = buildIsometricSVG(data);

    document.getElementById("centre-info").textContent = `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
    document.getElementById("radius-info").textContent = `${radiusKm}km`;
    document.getElementById("bearings-info").textContent = `${directions} bearings`;
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = err.message;
  }
}

function goToLocation(event) {
  event.preventDefault();
  const lon = parseFloat(document.getElementById("lon-input").value);
  const lat = parseFloat(document.getElementById("lat-input").value);
  const radiusKm = parseFloat(document.getElementById("radius-input").value);
  const directions = parseInt(document.getElementById("directions-input").value);
  if ([lon, lat, radiusKm, directions].some(isNaN)) return;
  loadSkyline(lon, lat, radiusKm, directions);
}

(function init() {
  const params = new URLSearchParams(window.location.search);
  const lon = parseFloat(params.get("lon")) || LON_DEFAULT;
  const lat = parseFloat(params.get("lat")) || LAT_DEFAULT;
  const radiusKm = parseFloat(params.get("radius")) || RADIUS_KM_DEFAULT;
  const directions = parseInt(params.get("directions")) || DIRECTIONS_DEFAULT;

  document.getElementById("lon-input").value = lon;
  document.getElementById("lat-input").value = lat;
  document.getElementById("radius-input").value = radiusKm;
  document.getElementById("directions-input").value = directions;

  loadSkyline(lon, lat, radiusKm, directions);
})();
