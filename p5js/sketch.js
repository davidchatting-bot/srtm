// Each slippy tile is drawn as an isometric rhombus using a 2D affine transform.
// The image top-left (NW) maps to the rhombus N vertex, and so on.

const TILE_SIZE = 256;
const CELL_W    = TILE_SIZE;      // rhombus width  (E–W span)
const CELL_H    = CELL_W / 2;     // rhombus height (N–S span)
const MIN_ZOOM  = 5;
const MAX_ZOOM  = 16;

let zoom    = 13;
let centerX;                       // fractional tile X of screen centre
let centerY;                       // fractional tile Y of screen centre
let tileCache  = {};
let isDragging = false;

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('map');

  // San Francisco
  centerX = lonToTileX(-122.4194, zoom);
  centerY = latToTileY(37.7749,   zoom);
}

function draw() {
  background(20);
  drawTiles();
  updateInfo();
}

// Screen position of the N vertex (= NW corner of tile) for tile (tx, ty)
function tileNVertex(tx, ty) {
  const dx = tx - centerX;
  const dy = ty - centerY;
  return {
    x: width  / 2 + (dx - dy) * CELL_W / 2,
    y: height / 2 + (dx + dy) * CELL_H / 2,
  };
}

function drawTiles() {
  const maxTile    = Math.pow(2, zoom);
  const viewRadius = ceil((width + height) / CELL_H) + 2;

  const cx0 = floor(centerX) - viewRadius;
  const cx1 = ceil(centerX)  + viewRadius;
  const cy0 = floor(centerY) - viewRadius;
  const cy1 = ceil(centerY)  + viewRadius;

  // Painter's algorithm: draw ascending (tx + ty) so back tiles render first
  for (let sum = cx0 + cy0; sum <= cx1 + cy1; sum++) {
    for (let tx = cx0; tx <= cx1; tx++) {
      const ty = sum - tx;
      if (ty < cy0 || ty > cy1) continue;
      if (ty < 0   || ty >= maxTile) continue;

      const { x: nx, y: ny } = tileNVertex(tx, ty);

      // Cull: rhombus spans [nx-CW/2 .. nx+CW/2] × [ny .. ny+CH]
      if (nx + CELL_W / 2 < 0 || nx - CELL_W / 2 > width)  continue;
      if (ny + CELL_H     < 0 || ny               > height) continue;

      const wrappedTx = ((tx % maxTile) + maxTile) % maxTile;
      const key       = `${zoom}/${wrappedTx}/${ty}`;

      if (!tileCache[key]) {
        tileCache[key] = { img: null, status: 'loading' };
        loadImage(
          `/tiles/${zoom}/${wrappedTx}/${ty}.png`,
          img => { tileCache[key] = { img, status: 'loaded' }; },
          ()  => { tileCache[key] = { img: null, status: 'error' };  }
        );
      }

      const entry = tileCache[key];
      if (entry.status !== 'loaded' || !entry.img) continue;

      // Affine transform mapping image space → isometric rhombus:
      //   image (0,0)          → screen N vertex  (nx, ny)
      //   image (TILE_SIZE, 0) → screen E vertex  (nx + CW/2, ny + CH/2)
      //   image (0, TILE_SIZE) → screen W vertex  (nx - CW/2, ny + CH/2)
      //   image (TILE_SIZE, TILE_SIZE) → screen S vertex (nx, ny + CH)
      //
      // Matrix: new_x = 0.5*x - 0.5*y + nx
      //         new_y = 0.25*x + 0.25*y + ny
      // applyMatrix(a, b, c, d, e, f) → new_x = a*x + c*y + e
      //                                  new_y = b*x + d*y + f
      push();
      applyMatrix(0.5, 0.25, -0.5, 0.25, nx, ny);
      image(entry.img, 0, 0, TILE_SIZE, TILE_SIZE);
      pop();
    }
  }
}

function updateInfo() {
  const lon = tileXToLon(centerX, zoom);
  const lat = tileYToLat(centerY, zoom);
  document.getElementById('coords').textContent =
    `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  document.getElementById('zoom-level').textContent = `zoom ${zoom}`;
}

// --- Interaction ---

function mousePressed()  { isDragging = true; }
function mouseReleased() { isDragging = false; }

function mouseDragged() {
  if (!isDragging) return;
  const dMX = mouseX - pmouseX;
  const dMY = mouseY - pmouseY;
  // Inverse of the isometric projection to get tile-space delta
  centerX -= (dMX + 2 * dMY) / CELL_W;
  centerY += (dMX - 2 * dMY) / CELL_W;
}

function mouseWheel(e) {
  const delta   = e.delta > 0 ? -1 : 1;
  const newZoom = constrain(zoom + delta, MIN_ZOOM, MAX_ZOOM);
  if (newZoom === zoom) return false;

  const scale = Math.pow(2, newZoom - zoom);
  centerX *= scale;
  centerY *= scale;
  zoom = newZoom;

  for (const key of Object.keys(tileCache)) {
    if (!key.startsWith(`${zoom}/`)) delete tileCache[key];
  }
  return false;
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
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
