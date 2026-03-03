const TILE_SIZE = 256;
const TILE_SERVER = 'http://localhost:3000/tiles';
const MIN_ZOOM = 1;
const MAX_ZOOM = 14;

// Map state — centre in fractional tile coordinates at current zoom
let zoom = 8;
let centerX; // fractional tile x
let centerY; // fractional tile y

let tileCache = {};
let isDragging = false;
let dragStart = {};

function setup() {
  const canvas = createCanvas(windowWidth, windowHeight);
  canvas.parent('map');

  // Default to London
  const lon = -0.118;
  const lat = 51.509;
  centerX = lonToTileX(lon, zoom);
  centerY = latToTileY(lat, zoom);
}

function draw() {
  background(30);
  drawTiles();
  updateInfo();
}

function drawTiles() {
  const halfW = width  / 2;
  const halfH = height / 2;

  // Range of tiles visible on screen
  const x0 = Math.floor(centerX - halfW / TILE_SIZE) - 1;
  const x1 = Math.ceil (centerX + halfW / TILE_SIZE) + 1;
  const y0 = Math.floor(centerY - halfH / TILE_SIZE) - 1;
  const y1 = Math.ceil (centerY + halfH / TILE_SIZE) + 1;

  const maxTile = Math.pow(2, zoom);

  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      // Skip tiles outside valid range
      if (ty < 0 || ty >= maxTile) continue;

      // Wrap longitude
      const wrappedTx = ((tx % maxTile) + maxTile) % maxTile;
      const key = `${zoom}/${wrappedTx}/${ty}`;

      // Screen position of tile's top-left corner
      const screenX = (tx - centerX) * TILE_SIZE + halfW;
      const screenY = (ty - centerY) * TILE_SIZE + halfH;

      if (!tileCache[key]) {
        tileCache[key] = { img: null, status: 'loading' };
        loadImage(
          `${TILE_SERVER}/${zoom}/${wrappedTx}/${ty}.png`,
          img => { tileCache[key] = { img, status: 'loaded' }; },
          ()  => { tileCache[key] = { img: null, status: 'error' }; }
        );
      }

      const entry = tileCache[key];
      if (entry.status === 'loaded' && entry.img) {
        image(entry.img, screenX, screenY, TILE_SIZE, TILE_SIZE);
      } else if (entry.status === 'loading') {
        // Placeholder while loading
        noFill();
        stroke(60);
        strokeWeight(1);
        rect(screenX, screenY, TILE_SIZE, TILE_SIZE);
      }
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

function mousePressed() {
  isDragging = true;
  dragStart = { x: mouseX, y: mouseY, cx: centerX, cy: centerY };
}

function mouseDragged() {
  if (!isDragging) return;
  centerX = dragStart.cx - (mouseX - dragStart.x) / TILE_SIZE;
  centerY = dragStart.cy - (mouseY - dragStart.y) / TILE_SIZE;
}

function mouseReleased() {
  isDragging = false;
}

function mouseWheel(e) {
  const delta = e.delta > 0 ? -1 : 1;
  const newZoom = constrain(zoom + delta, MIN_ZOOM, MAX_ZOOM);
  if (newZoom === zoom) return;

  // Zoom towards the mouse pointer
  const mouseOffsetX = (mouseX - width  / 2) / TILE_SIZE;
  const mouseOffsetY = (mouseY - height / 2) / TILE_SIZE;

  const scale = Math.pow(2, newZoom - zoom);
  centerX = (centerX + mouseOffsetX) * scale - mouseOffsetX;
  centerY = (centerY + mouseOffsetY) * scale - mouseOffsetY;
  zoom = newZoom;

  // Evict tiles from old zoom level to keep cache lean
  for (const key of Object.keys(tileCache)) {
    if (!key.startsWith(`${zoom}/`)) delete tileCache[key];
  }

  return false; // prevent page scroll
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
