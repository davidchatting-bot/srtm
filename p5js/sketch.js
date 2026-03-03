const LON       = -122.4194;
const LAT       = 37.7749;
const RADIUS_KM = 5;         // 5km radius = 10km × 10km total area
const DATA_ZOOM = 14;
const TILE_SIZE = 256;

let centerX, centerY;  // fractional tile coords of screen centre (updated by drag)
let areaW, areaH;      // area extent in tiles
let cellW, cellH;      // pixels per tile on screen
let tileCache = {};
let isDragging = false;

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('map');
  computeLayout();
}

function computeLayout() {
  const lonOffset = RADIUS_KM / (111.32 * Math.cos(LAT * Math.PI / 180));
  const latOffset = RADIUS_KM / 111.32;

  // Keep centre fixed to original lat/lon on first call only
  if (!centerX) {
    centerX = lonToTileX(LON, DATA_ZOOM);
    centerY = latToTileY(LAT, DATA_ZOOM);
  }

  // Area half-extents in tile units (fixed to RADIUS_KM, doesn't change on pan)
  areaW = lonToTileX(LON + lonOffset, DATA_ZOOM) - lonToTileX(LON - lonOffset, DATA_ZOOM);
  areaH = latToTileY(LAT - latOffset, DATA_ZOOM) - latToTileY(LAT + latOffset, DATA_ZOOM);

  const fitW = min(width * 0.85, height * 1.7);
  cellW = fitW / areaW;
  cellH = cellW / 2;
}

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

  const tileMinX = centerX - areaW / 2;
  const tileMaxX = centerX + areaW / 2;
  const tileMinY = centerY - areaH / 2;
  const tileMaxY = centerY + areaH / 2;

  const N = nVertex(tileMinX, tileMinY);
  const E = nVertex(tileMaxX, tileMinY);
  const S = nVertex(tileMaxX, tileMaxY);
  const W = nVertex(tileMinX, tileMaxY);

  // Clip to the rhombus
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
      // Overdraw by 1px in image space to close sub-pixel gaps at tile edges
      image(entry.img, -0.5, -0.5, TILE_SIZE + 1, TILE_SIZE + 1);
      pop();
    }
  }

  drawingContext.restore();
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
  // Inverse isometric projection to tile-space delta
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
