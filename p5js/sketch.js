// --- Configuration ---
// Change LON/LAT to centre on a different location.
// RADIUS_KM controls how much terrain is shown (half-width of the square view).
// ELEV_DISPLAY_MAX sets the elevation (metres above sea level) that reaches
// the top of the colour scale; anything higher is clamped.

const LON_DEFAULT      = -1.6;
const LAT_DEFAULT      = 55.0;
const RADIUS_KM        = 20;        // 40 km total view
let DATA_ZOOM          = 11;        // computed in preload() to match SRTM resolution
const TILE_SIZE        = 256;       // pixels per tile (matches server)
const ELEV_MIN         = -500;      // must match server ELEV_MIN
const ELEV_RANGE       = 9000;      // must match server ELEV_RANGE
const ELEV_DISPLAY_MAX = 300;       // metres at which the colour scale tops out
const MAX_BARS         = 120;       // max bars per axis — caps draw cost for large views

// --- State ---

let centerX, centerY;   // current view centre in fractional tile coordinates
let areaW, areaH;       // view width/height in tile units
let cellW, cellH;       // screen pixels per tile unit (cellH = cellW/2 for 2:1 iso)
let tileMinX, tileMinY; // top-left corner of the view in tile coordinates
let tileCache = {};     // keyed by "z/x/y"; stores { pixels, status }
let isDragging = false;
let GRID_W = 100;       // bars across — computed in setup() from /info pixelDeg
let GRID_H = 100;       // bars deep

let _srtmInfo;  // loaded in preload(), consumed in setup()

// p5.js preload: use the return value (not a callback) so setup() is
// guaranteed to block until the data is available.
function preload() {
  _srtmInfo = loadJSON('/info');
}

function setup() {
  // Compute grid size and tile zoom from SRTM resolution now that _srtmInfo is ready
  const pixelDeg = _srtmInfo.pixelDeg;
  const lonSpan  = 2 * RADIUS_KM / (111.32 * Math.cos(LAT_DEFAULT * Math.PI / 180));
  const latSpan  = 2 * RADIUS_KM / 111.32;
  GRID_W    = Math.min(MAX_BARS, Math.round(lonSpan / pixelDeg));
  GRID_H    = Math.min(MAX_BARS, Math.round(latSpan / pixelDeg));
  DATA_ZOOM = Math.round(Math.log2(360 / (TILE_SIZE * pixelDeg)));

  createCanvas(windowWidth, windowHeight).parent('map');

  // Initialise centre from URL params (?lat=…&lon=…) or fall back to defaults
  const params = new URLSearchParams(window.location.search);
  const lon = parseFloat(params.get('lon')) || LON_DEFAULT;
  const lat = parseFloat(params.get('lat')) || LAT_DEFAULT;
  centerX = lonToTileX(lon, DATA_ZOOM);
  centerY = latToTileY(lat, DATA_ZOOM);

  // Pre-fill the form
  document.getElementById('lon-input').value = lon;
  document.getElementById('lat-input').value = lat;

  computeLayout();
  requestMissingTiles();
  noLoop();
  redraw();
}

// Called by the location form — recentres the map without a page reload
function goToLocation(event) {
  event.preventDefault();
  const lon = parseFloat(document.getElementById('lon-input').value);
  const lat = parseFloat(document.getElementById('lat-input').value);
  if (isNaN(lon) || isNaN(lat)) return;
  centerX  = lonToTileX(lon, DATA_ZOOM);
  centerY  = latToTileY(lat, DATA_ZOOM);
  tileCache = {};
  requestMissingTiles();
  redraw();
}

function computeLayout() {
  const lonOffset = RADIUS_KM / (111.32 * Math.cos(LAT_DEFAULT * Math.PI / 180));
  const latOffset = RADIUS_KM / 111.32;

  areaW = lonToTileX(LON_DEFAULT + lonOffset, DATA_ZOOM) - lonToTileX(LON_DEFAULT - lonOffset, DATA_ZOOM);
  areaH = latToTileY(LAT_DEFAULT - latOffset, DATA_ZOOM) - latToTileY(LAT_DEFAULT + latOffset, DATA_ZOOM);

  const fitW = min(width * 0.85, height * 1.7) / 2;
  cellW = fitW / areaW;
  cellH = cellW / 2;
}

// Screen position of a fractional tile coordinate
function nVertex(tx, ty) {
  const dx = tx - centerX;
  const dy = ty - centerY;
  return {
    x: width  / 2 + (dx - dy) * cellW / 2,
    y: height / 2 + (dx + dy) * cellH / 2,
  };
}

// Update tileMinX/Y from current centre — called at the start of every draw()
function updateTileBounds() {
  tileMinX = centerX - areaW / 2;
  tileMinY = centerY - areaH / 2;
}

// Request any tiles in the current view that aren't already cached.
// Called only when the view changes (drag, location change, setup) — never from draw().
function requestMissingTiles() {
  updateTileBounds();
  const tx0 = Math.floor(tileMinX);
  const tx1 = Math.ceil(centerX + areaW / 2);
  const ty0 = Math.floor(tileMinY);
  const ty1 = Math.ceil(centerY + areaH / 2);
  const maxTile = Math.pow(2, DATA_ZOOM);

  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= maxTile) continue;
      const wtx = ((tx % maxTile) + maxTile) % maxTile;
      const key = `${DATA_ZOOM}/${wtx}/${ty}`;
      if (tileCache[key]) continue;  // already loading, loaded, or errored

      tileCache[key] = { pixels: null, status: 'loading' };
      loadImage(
        `/tiles/${DATA_ZOOM}/${wtx}/${ty}.png`,
        img => {
          img.loadPixels();
          tileCache[key] = { pixels: new Uint8Array(img.pixels), status: 'loaded' };
          redraw();
        },
        () => { tileCache[key] = { pixels: null, status: 'error' }; }
      );
    }
  }
}

// Sample elevation (metres) at grid cell centre; returns NaN if no data
function sampleElevation(gx, gy) {
  const tx = tileMinX + (gx + 0.5) / GRID_W * areaW;
  const ty = tileMinY + (gy + 0.5) / GRID_H * areaH;
  const itx = Math.floor(tx);
  const ity = Math.floor(ty);
  const px  = Math.min(TILE_SIZE - 1, Math.floor((tx - itx) * TILE_SIZE));
  const py  = Math.min(TILE_SIZE - 1, Math.floor((ty - ity) * TILE_SIZE));

  const maxTile = Math.pow(2, DATA_ZOOM);
  const wtx = ((itx % maxTile) + maxTile) % maxTile;
  const entry = tileCache[`${DATA_ZOOM}/${wtx}/${ity}`];
  if (!entry || entry.status !== 'loaded') return NaN;

  const idx = (py * TILE_SIZE + px) * 4;
  if (entry.pixels[idx + 3] < 128) return NaN;
  return (entry.pixels[idx] / 255) * ELEV_RANGE + ELEV_MIN;
}

function draw() {
  background(15);
  updateTileBounds();

  // Build elevation grid
  const elevGrid = new Float32Array(GRID_W * GRID_H);

  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      elevGrid[gy * GRID_W + gx] = sampleElevation(gx, gy);
    }
  }

  const barFootprint = (areaW / GRID_W) * cellW;  // screen px width of one bar
  const maxBarH = barFootprint * 4;
  const cellTW  = areaW / GRID_W;
  const cellTH  = areaH / GRID_H;

  drawSoilLayer(maxBarH);
  drawSeaLayer();

  // Painter's algorithm: render back-to-front along ascending gx+gy diagonals
  for (let sum = 0; sum < GRID_W + GRID_H - 1; sum++) {
    for (let gx = max(0, sum - GRID_H + 1); gx <= min(sum, GRID_W - 1); gx++) {
      const gy   = sum - gx;
      const elev = elevGrid[gy * GRID_W + gx];
      if (isNaN(elev) || elev <= 0) continue;  // sea level covered by sea layer

      const t    = elev / ELEV_DISPLAY_MAX;
      const barH = t * maxBarH;
      const tx   = tileMinX + gx / GRID_W * areaW;
      const ty   = tileMinY + gy / GRID_H * areaH;
      drawBar(tx, ty, cellTW, cellTH, barH);
    }
  }

  drawSkyLayer(maxBarH);

  updateInfo();
}

// Flat blue diamond at sea level (0 m) — replaces individual sea-level bars
function drawSeaLayer() {
  const TL = nVertex(tileMinX,         tileMinY);
  const TR = nVertex(tileMinX + areaW, tileMinY);
  const BR = nVertex(tileMinX + areaW, tileMinY + areaH);
  const BL = nVertex(tileMinX,         tileMinY + areaH);
  noStroke();
  fill(0, 44, 170);
  quad(TL.x, TL.y, TR.x, TR.y, BR.x, BR.y, BL.x, BL.y);
}

// Flat earthy-brown diamond dropped below ground level by the same offset as the sky
function drawSoilLayer(maxBarH) {
  const drop = maxBarH * 5.75;
  const TL = nVertex(tileMinX,         tileMinY);
  const TR = nVertex(tileMinX + areaW, tileMinY);
  const BR = nVertex(tileMinX + areaW, tileMinY + areaH);
  const BL = nVertex(tileMinX,         tileMinY + areaH);
  noStroke();
  fill(101, 58, 22);
  quad(TL.x, TL.y + drop, TR.x, TR.y + drop, BR.x, BR.y + drop, BL.x, BL.y + drop);
}

// Semi-transparent sky-blue diamond floating above the tallest bars
function drawSkyLayer(maxBarH) {
  const lift = maxBarH * 5.75;
  const TL = nVertex(tileMinX,         tileMinY);
  const TR = nVertex(tileMinX + areaW, tileMinY);
  const BR = nVertex(tileMinX + areaW, tileMinY + areaH);
  const BL = nVertex(tileMinX,         tileMinY + areaH);
  noStroke();
  fill(40, 120, 255, 70);
  quad(TL.x, TL.y - lift, TR.x, TR.y - lift, BR.x, BR.y - lift, BL.x, BL.y - lift);
}

// Draw one isometric bar (above sea level only): top + right face + front face
function drawBar(tx, ty, tw, th, barH) {
  const TL = nVertex(tx,      ty);
  const TR = nVertex(tx + tw, ty);
  const BR = nVertex(tx + tw, ty + th);
  const BL = nVertex(tx,      ty + th);

  noStroke();
  fill(0, 155, 0);
  quad(TR.x, TR.y, BR.x, BR.y, BR.x, BR.y - barH, TR.x, TR.y - barH);  // right face
  fill(0, 115, 0);
  quad(BL.x, BL.y, BR.x, BR.y, BR.x, BR.y - barH, BL.x, BL.y - barH);  // front face
  fill(0, 220, 0);
  quad(TL.x, TL.y - barH, TR.x, TR.y - barH, BR.x, BR.y - barH, BL.x, BL.y - barH);  // top
}

// --- Interaction ---

function mousePressed()  { isDragging = true; }
function mouseReleased() {
  isDragging = false;
  requestMissingTiles();  // fetch tiles for final position once drag ends
  redraw();
}

function mouseDragged() {
  if (!isDragging) return;
  const dMX = mouseX - pmouseX;
  const dMY = mouseY - pmouseY;
  centerX -= (dMX + 2 * dMY) / cellW;
  centerY += (dMX - 2 * dMY) / cellW;
  redraw();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  computeLayout();
  redraw();
}

function updateInfo() {
  document.getElementById('coords').textContent =
    `${tileYToLat(centerY, DATA_ZOOM).toFixed(4)}°, ${tileXToLon(centerX, DATA_ZOOM).toFixed(4)}°`;
  document.getElementById('zoom-level').textContent = `${RADIUS_KM * 2}km`;
}

// --- Tile coordinate math ---

function lonToTileX(lon, z) {
  return (lon + 180) / 360 * Math.pow(2, z);
}

function latToTileY(lat, z) {
  const rad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
}

function tileXToLon(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}

function tileYToLat(y, z) {
  return Math.atan(Math.sinh(Math.PI * (1 - 2 * y / Math.pow(2, z)))) * 180 / Math.PI;
}
