const LON              = -122.4194;
const LAT              = 37.7749;
const RADIUS_KM        = 5;
const DATA_ZOOM        = 14;
const TILE_SIZE        = 256;
const ELEV_MIN         = -500;
const ELEV_RANGE       = 9000; // matches server constants
const ELEV_DISPLAY_MAX = 300; // metres — hot pink at 300m (Twin Peaks ~282m)

let centerX, centerY;
let areaW, areaH;
let cellW, cellH;
let tileMinX, tileMinY;
let tileCache = {};
let isDragging = false;
let GRID_W = 100;  // replaced in preload() once pixelDeg is known
let GRID_H = 100;

function preload() {
  loadJSON('/info', info => {
    const lonSpan = 2 * RADIUS_KM / (111.32 * Math.cos(LAT * Math.PI / 180));
    const latSpan = 2 * RADIUS_KM / 111.32;
    GRID_W = Math.round(lonSpan / info.pixelDeg);
    GRID_H = Math.round(latSpan / info.pixelDeg);
  });
}

function setup() {
  createCanvas(windowWidth, windowHeight).parent('map');
  computeLayout();
}

function computeLayout() {
  const lonOffset = RADIUS_KM / (111.32 * Math.cos(LAT * Math.PI / 180));
  const latOffset = RADIUS_KM / 111.32;

  if (!centerX) {
    centerX = lonToTileX(LON, DATA_ZOOM);
    centerY = latToTileY(LAT, DATA_ZOOM);
  }

  areaW = lonToTileX(LON + lonOffset, DATA_ZOOM) - lonToTileX(LON - lonOffset, DATA_ZOOM);
  areaH = latToTileY(LAT - latOffset, DATA_ZOOM) - latToTileY(LAT + latOffset, DATA_ZOOM);

  const fitW = min(width * 0.85, height * 1.7);
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

// Kick off loads for all tiles in view; cache pixel data on arrival
function ensureTilesLoaded() {
  tileMinX = centerX - areaW / 2;
  tileMinY = centerY - areaH / 2;

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
      if (tileCache[key]) continue;

      tileCache[key] = { pixels: null, status: 'loading' };
      loadImage(
        `/tiles/${DATA_ZOOM}/${wtx}/${ty}.png`,
        img => {
          img.loadPixels();
          tileCache[key] = { pixels: new Uint8Array(img.pixels), status: 'loaded' };
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
  ensureTilesLoaded();

  // Build elevation grid
  const elevGrid = new Float32Array(GRID_W * GRID_H);

  for (let gy = 0; gy < GRID_H; gy++) {
    for (let gx = 0; gx < GRID_W; gx++) {
      elevGrid[gy * GRID_W + gx] = sampleElevation(gx, gy);
    }
  }

  const maxBarH = height * 0.18;
  const cellTW     = areaW / GRID_W;
  const cellTH     = areaH / GRID_H;

  // Painter's algorithm: render back-to-front along ascending gx+gy diagonals
  for (let sum = 0; sum < GRID_W + GRID_H - 1; sum++) {
    for (let gx = max(0, sum - GRID_H + 1); gx <= min(sum, GRID_W - 1); gx++) {
      const gy   = sum - gx;
      const elev = elevGrid[gy * GRID_W + gx];
      if (isNaN(elev)) continue;

      const t    = Math.max(0, elev) / ELEV_DISPLAY_MAX;
      const barH = t * maxBarH;
      const tx   = tileMinX + gx / GRID_W * areaW;
      const ty   = tileMinY + gy / GRID_H * areaH;
      drawBar(tx, ty, cellTW, cellTH, barH, t);
    }
  }

  updateInfo();
}

// Draw one isometric bar: top + right face + front face
// Blue at sea level, green above
function drawBar(tx, ty, tw, th, barH, t) {
  const TL = nVertex(tx,      ty);
  const TR = nVertex(tx + tw, ty);
  const BR = nVertex(tx + tw, ty + th);
  const BL = nVertex(tx,      ty + th);

  const isSeaLevel = (t === 0);
  const top   = isSeaLevel ? [  0,  44, 170] : [  0, 220,   0];
  const right = isSeaLevel ? [  0,  28, 120] : [  0, 155,   0];
  const front = isSeaLevel ? [  0,  18,  88] : [  0, 115,   0];

  noStroke();

  if (barH > 0.5) {
    fill(...right);
    quad(TR.x, TR.y, BR.x, BR.y, BR.x, BR.y - barH, TR.x, TR.y - barH);

    fill(...front);
    quad(BL.x, BL.y, BR.x, BR.y, BR.x, BR.y - barH, BL.x, BL.y - barH);
  }

  fill(...top);
  quad(TL.x, TL.y - barH, TR.x, TR.y - barH, BR.x, BR.y - barH, BL.x, BL.y - barH);
}

// --- Interaction ---

function mousePressed()  { isDragging = true; }
function mouseReleased() { isDragging = false; }

function mouseDragged() {
  if (!isDragging) return;
  const dMX = mouseX - pmouseX;
  const dMY = mouseY - pmouseY;
  centerX -= (dMX + 2 * dMY) / cellW;
  centerY += (dMX - 2 * dMY) / cellW;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  computeLayout();
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
