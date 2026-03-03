// All tiles are composited into a flat off-screen buffer first,
// then the whole buffer is projected isometrically as one image.
// This eliminates seams between tiles entirely.

const LON         = -122.4194;
const LAT         = 37.7749;
const RADIUS_KM   = 5;
const DATA_ZOOM   = 14;
const TILE_SIZE   = 256;
const BUFFER_SIZE = 2048;

let centerX, centerY;
let areaW, areaH;
let cellW, cellH;
let tileCache = {};
let terrain;          // flat off-screen canvas
let isDragging = false;

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('map');
  terrain = createGraphics(BUFFER_SIZE, BUFFER_SIZE);
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

// Composite all loaded tiles into the flat terrain buffer
function updateTerrainBuffer() {
  const tileMinX = centerX - areaW / 2;
  const tileMaxX = centerX + areaW / 2;
  const tileMinY = centerY - areaH / 2;
  const tileMaxY = centerY + areaH / 2;

  terrain.clear();

  const tx0 = Math.floor(tileMinX);
  const tx1 = Math.ceil(tileMaxX);
  const ty0 = Math.floor(tileMinY);
  const ty1 = Math.ceil(tileMaxY);
  const maxTile = Math.pow(2, DATA_ZOOM);

  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      if (ty < 0 || ty >= maxTile) continue;

      const wrappedTx = ((tx % maxTile) + maxTile) % maxTile;
      const key = `${DATA_ZOOM}/${wrappedTx}/${ty}`;

      if (!tileCache[key]) {
        tileCache[key] = { img: null, status: 'loading' };
        loadImage(
          `/tiles/${DATA_ZOOM}/${wrappedTx}/${ty}.png`,
          img => { tileCache[key] = { img, status: 'loaded' }; },
          ()  => { tileCache[key] = { img: null, status: 'error' }; }
        );
      }

      const entry = tileCache[key];
      if (entry.status !== 'loaded' || !entry.img) continue;

      // Flat 2D position within the buffer
      const bx = (tx - tileMinX) / areaW * BUFFER_SIZE;
      const by = (ty - tileMinY) / areaH * BUFFER_SIZE;
      const bw = BUFFER_SIZE / areaW;
      const bh = BUFFER_SIZE / areaH;

      terrain.image(entry.img, bx, by, bw, bh);
    }
  }
}

function draw() {
  background(15);

  const tileMinX = centerX - areaW / 2;
  const tileMaxX = centerX + areaW / 2;
  const tileMinY = centerY - areaH / 2;
  const tileMaxY = centerY + areaH / 2;

  updateTerrainBuffer();

  // Derive affine transform from the three corners of the destination rhombus
  const N = nVertex(tileMinX, tileMinY);  // buffer (0, 0)
  const E = nVertex(tileMaxX, tileMinY);  // buffer (BUFFER_SIZE, 0)
  const W = nVertex(tileMinX, tileMaxY);  // buffer (0, BUFFER_SIZE)

  push();
  applyMatrix(
    (E.x - N.x) / BUFFER_SIZE,
    (E.y - N.y) / BUFFER_SIZE,
    (W.x - N.x) / BUFFER_SIZE,
    (W.y - N.y) / BUFFER_SIZE,
    N.x,
    N.y
  );
  image(terrain, 0, 0, BUFFER_SIZE, BUFFER_SIZE);
  pop();

  updateInfo();
}

function updateInfo() {
  document.getElementById('coords').textContent =
    `${tileYToLat(centerY, DATA_ZOOM).toFixed(4)}°, ${tileXToLon(centerX, DATA_ZOOM).toFixed(4)}°`;
  document.getElementById('zoom-level').textContent = `${RADIUS_KM * 2}km`;
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
