// Fixed isometric view of a single 1km × 1km area.
// Tiles are clipped to the exact geographic bounds of the square.

const LON       = -122.4194;
const LAT       = 37.7749;
const RADIUS_KM = 0.5;       // 0.5km radius = 1km × 1km total area
const DATA_ZOOM = 14;
const TILE_SIZE = 256;

let tileMinX, tileMaxX, tileMinY, tileMaxY;
let centerX, centerY;
let cellW, cellH;
let tileCache = {};

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('map');
  computeBounds();
}

function computeBounds() {
  const lonOffset = RADIUS_KM / (111.32 * Math.cos(LAT * Math.PI / 180));
  const latOffset = RADIUS_KM / 111.32;

  tileMinX = lonToTileX(LON - lonOffset, DATA_ZOOM);
  tileMaxX = lonToTileX(LON + lonOffset, DATA_ZOOM);
  tileMinY = latToTileY(LAT + latOffset, DATA_ZOOM); // north = smaller tile Y
  tileMaxY = latToTileY(LAT - latOffset, DATA_ZOOM);

  centerX = (tileMinX + tileMaxX) / 2;
  centerY = (tileMinY + tileMaxY) / 2;

  // Scale cell size so the 1km area fills most of the screen
  const areaW  = tileMaxX - tileMinX;
  const fitW   = min(width * 0.85, height * 1.7);
  cellW = fitW / areaW;
  cellH = cellW / 2;
}

// Screen position of the N vertex (NW corner of tile) for any fractional tile pos
function nVertex(tx, ty) {
  const dx = tx - centerX;
  const dy = ty - centerY;
  return {
    x: width  / 2 + (dx - dy) * cellW / 2,
    y: height / 2 + (dx + dy) * cellH / 2,
  };
}

function draw() {
  background(15);

  const N = nVertex(tileMinX, tileMinY);
  const E = nVertex(tileMaxX, tileMinY);
  const S = nVertex(tileMaxX, tileMaxY);
  const W = nVertex(tileMinX, tileMaxY);

  // Clip all subsequent drawing to the rhombus
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.moveTo(N.x, N.y);
  drawingContext.lineTo(E.x, E.y);
  drawingContext.lineTo(S.x, S.y);
  drawingContext.lineTo(W.x, W.y);
  drawingContext.closePath();
  drawingContext.clip();

  const tx0     = Math.floor(tileMinX);
  const tx1     = Math.ceil(tileMaxX);
  const ty0     = Math.floor(tileMinY);
  const ty1     = Math.ceil(tileMaxY);
  const maxTile = Math.pow(2, DATA_ZOOM);

  // Painter's algorithm: ascending (tx + ty) = back to front
  for (let sum = tx0 + ty0; sum <= tx1 + ty1; sum++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const ty = sum - tx;
      if (ty < ty0 || ty > ty1) continue;
      if (ty < 0   || ty >= maxTile) continue;

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

      const { x: nx, y: ny } = nVertex(tx, ty);

      push();
      applyMatrix(0.5, 0.25, -0.5, 0.25, nx, ny);
      image(entry.img, 0, 0, TILE_SIZE, TILE_SIZE);
      pop();
    }
  }

  drawingContext.restore();

  updateInfo();
}

function updateInfo() {
  document.getElementById('coords').textContent =
    `${LAT.toFixed(4)}°, ${LON.toFixed(4)}°`;
  document.getElementById('zoom-level').textContent =
    `${RADIUS_KM * 2}km`;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  computeBounds();
}

// --- Tile coordinate math ---

function lonToTileX(lon, z) {
  return (lon + 180) / 360 * Math.pow(2, z);
}

function latToTileY(lat, z) {
  const rad = lat * Math.PI / 180;
  return (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z);
}
