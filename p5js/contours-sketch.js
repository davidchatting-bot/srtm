// p5.js contour viewer: a 2D slippy map drawn on a canvas instead of via
// Leaflet. Tiles are fetched from /contour-tiles/:z/:x/:y.svg as p5.Image
// objects (the browser rasterises the SVG once on load, same as an <img>
// would) and drawn at native TILE_SIZE; panning/zooming changes which
// integer tile coordinates are requested, following the same tile-coordinate
// math already used by sketch.js's isometric viewer.

const TILE_SIZE = 256;
const MIN_ZOOM = 1;
const MAX_ZOOM = 18;

let zoomLevel = 13;
let centerX, centerY;       // fractional tile coords at the current zoomLevel
let tileCache = {};         // keyed "z/x/y" -> { img: p5.Image|null, status }
let isDragging = false;
let lastDragX, lastDragY;
let lastDrawnTiles = [];    // tiles actually placed on screen last frame, for export

let csvRows;                // loaded in preload(), parsed in setup()
let points = [];            // { lat, lon, rssi, hops }

function preload() {
  csvRows = loadStrings('/data/log.csv');
}

function setup() {
  createCanvas(windowWidth, windowHeight).parent('map');

  for (let i = 1; i < csvRows.length; i++) {
    const cols = csvRows[i].split(',');
    if (cols.length < 6) continue;
    points.push({
      result: cols[0],
      hops: parseInt(cols[1]),
      rssi: parseFloat(cols[2]),
      lat: parseFloat(cols[4]),
      lon: parseFloat(cols[5]),
    });
  }

  const params = new URLSearchParams(window.location.search);
  const lon = parseFloat(params.get('lon')) || parseFloat(document.getElementById('lon-input').value);
  const lat = parseFloat(params.get('lat')) || parseFloat(document.getElementById('lat-input').value);
  centerX = lonToTileX(lon, zoomLevel);
  centerY = latToTileY(lat, zoomLevel);

  requestMissingTiles();
  noLoop();
  redraw();
}

// Builds the tile URL query string from the control panel inputs — same
// parameters /contour-tiles accepts, so changing any of them (via Go/Apply)
// invalidates the old cache entries by simply changing the URL.
function buildTileQuery() {
  const params = new URLSearchParams();
  const interval = document.getElementById('interval-input').value;
  if (interval) params.set('interval', interval);
  params.set('resolution', document.getElementById('resolution-input').value);
  params.set('strokeWidth', document.getElementById('stroke-input').value);
  const greyMin = document.getElementById('grey-min-input').value;
  if (greyMin) params.set('greyMin', greyMin);
  const greyMax = document.getElementById('grey-max-input').value;
  if (greyMax) params.set('greyMax', greyMax);
  return params.toString();
}

// Screen position of a fractional tile coordinate at the current view.
function tileToScreen(tx, ty) {
  return {
    x: width / 2 + (tx - centerX) * TILE_SIZE,
    y: height / 2 + (ty - centerY) * TILE_SIZE,
  };
}

function requestMissingTiles() {
  const query = buildTileQuery();
  const tilesAcross = Math.ceil(width / TILE_SIZE) + 2;
  const tilesDown = Math.ceil(height / TILE_SIZE) + 2;
  const tx0 = Math.floor(centerX - tilesAcross / 2);
  const ty0 = Math.floor(centerY - tilesDown / 2);
  const maxTile = Math.pow(2, zoomLevel);

  for (let dx = 0; dx <= tilesAcross; dx++) {
    for (let dy = 0; dy <= tilesDown; dy++) {
      const tx = tx0 + dx;
      const ty = ty0 + dy;
      if (ty < 0 || ty >= maxTile) continue;
      const wtx = ((tx % maxTile) + maxTile) % maxTile;
      const key = `${zoomLevel}/${wtx}/${ty}/${query}`;
      if (tileCache[key]) continue; // already loading, loaded, or errored

      tileCache[key] = { img: null, svgText: null, status: 'loading' };
      fetchTile(`/contour-tiles/${zoomLevel}/${wtx}/${ty}.svg?${query}`, key);
    }
  }
}

// Fetches the tile's SVG ourselves (one request) and hands p5 a local blob
// URL to decode, rather than pointing loadImage straight at the server URL —
// browsers/p5 issue a second network fetch of the same SVG when loaded that
// way (confirmed: every tile was being requested twice). This also keeps the
// raw SVG text around for exportSVG(), instead of it re-fetching every tile.
function fetchTile(url, key) {
  fetch(url)
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    })
    .then(svgText => {
      const blobUrl = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
      loadImage(
        blobUrl,
        img => { URL.revokeObjectURL(blobUrl); tileCache[key] = { img, svgText, status: 'loaded' }; redraw(); },
        () => { URL.revokeObjectURL(blobUrl); tileCache[key] = { img: null, svgText: null, status: 'error' }; }
      );
    })
    .catch(() => { tileCache[key] = { img: null, svgText: null, status: 'error' }; });
}

function draw() {
  background(128);

  const query = buildTileQuery();
  const tilesAcross = Math.ceil(width / TILE_SIZE) + 2;
  const tilesDown = Math.ceil(height / TILE_SIZE) + 2;
  const tx0 = Math.floor(centerX - tilesAcross / 2);
  const ty0 = Math.floor(centerY - tilesDown / 2);
  const maxTile = Math.pow(2, zoomLevel);

  lastDrawnTiles = [];
  for (let dx = 0; dx <= tilesAcross; dx++) {
    for (let dy = 0; dy <= tilesDown; dy++) {
      const tx = tx0 + dx;
      const ty = ty0 + dy;
      if (ty < 0 || ty >= maxTile) continue;
      const wtx = ((tx % maxTile) + maxTile) % maxTile;
      const key = `${zoomLevel}/${wtx}/${ty}/${query}`;
      const entry = tileCache[key];
      if (!entry || entry.status !== 'loaded') continue;

      const { x, y } = tileToScreen(tx, ty);
      image(entry.img, x, y, TILE_SIZE, TILE_SIZE);
      lastDrawnTiles.push({ screenX: x, screenY: y, svgText: entry.svgText });
    }
  }

  drawPoints();
  updateInfo();
}

// LoRa traceroute points: green for a direct/successful hop, red for a
// failed one. Other columns (RSSI, SNR, hop count) aren't shown yet.
function pointColor(p) {
  return p.result === 'DIRECT' ? color(50, 220, 80) : color(220, 50, 50);
}

function drawPoints() {
  noStroke();
  for (const p of points) {
    if (isNaN(p.lat) || isNaN(p.lon)) continue;
    const tx = lonToTileX(p.lon, zoomLevel);
    const ty = latToTileY(p.lat, zoomLevel);
    const { x, y } = tileToScreen(tx, ty);
    if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue;

    fill(pointColor(p));
    circle(x, y, 6);
  }
}

// --- Interaction ---

function goToLocation(event) {
  if (event) event.preventDefault();
  const lat = parseFloat(document.getElementById('lat-input').value);
  const lon = parseFloat(document.getElementById('lon-input').value);
  if (!isNaN(lat) && !isNaN(lon)) {
    centerX = lonToTileX(lon, zoomLevel);
    centerY = latToTileY(lat, zoomLevel);
  }
  requestMissingTiles();
  redraw();
}

function mousePressed() {
  if (mouseY < 0 || mouseX < 0) return;
  isDragging = true;
  lastDragX = mouseX;
  lastDragY = mouseY;
}

function mouseReleased() {
  isDragging = false;
  requestMissingTiles();
  redraw();
}

function mouseDragged() {
  if (!isDragging) return;
  centerX -= (mouseX - lastDragX) / TILE_SIZE;
  centerY -= (mouseY - lastDragY) / TILE_SIZE;
  lastDragX = mouseX;
  lastDragY = mouseY;
  redraw();
}

// Zooms toward/away from the view centre (not cursor-anchored — kept simple).
function mouseWheel(event) {
  const lon = tileXToLon(centerX, zoomLevel);
  const lat = tileYToLat(centerY, zoomLevel);
  zoomLevel = constrain(zoomLevel + (event.deltaY > 0 ? -1 : 1), MIN_ZOOM, MAX_ZOOM);
  centerX = lonToTileX(lon, zoomLevel);
  centerY = latToTileY(lat, zoomLevel);
  requestMissingTiles();
  redraw();
  return false; // prevent page scroll
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  requestMissingTiles();
  redraw();
}

function updateInfo() {
  const info = document.getElementById('info');
  if (!info) return;
  info.textContent = `${tileYToLat(centerY, zoomLevel).toFixed(4)}°, ${tileXToLon(centerX, zoomLevel).toFixed(4)}° — z${zoomLevel}`;
}

// Merges every tile drawn last frame into a single flat SVG: takes each
// tile's raw markup (already fetched and cached by fetchTile(), no need to
// re-fetch), strips its outer <svg> wrapper, and re-places the contents in a
// <g transform="translate(...)"> at the screen position draw() used.
async function exportSVG() {
  const status = document.getElementById('export-status');
  const button = document.getElementById('export-button');
  button.disabled = true;
  status.textContent = 'Exporting...';

  try {
    if (lastDrawnTiles.length === 0) throw new Error('No tiles on screen to export');

    const parser = new DOMParser();
    const parts = lastDrawnTiles.map(tile => {
      const inner = parser.parseFromString(tile.svgText, 'image/svg+xml').documentElement.innerHTML;
      return `<g transform="translate(${tile.screenX.toFixed(2)},${tile.screenY.toFixed(2)})">${inner}</g>`;
    });

    let pointsMarkup = '';
    for (const p of points) {
      if (isNaN(p.lat) || isNaN(p.lon)) continue;
      const tx = lonToTileX(p.lon, zoomLevel);
      const ty = latToTileY(p.lat, zoomLevel);
      const { x, y } = tileToScreen(tx, ty);
      if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue;
      const c = pointColor(p);
      pointsMarkup += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="rgb(${red(c)},${green(c)},${blue(c)})"/>`;
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      `<rect width="100%" height="100%" fill="#808080"/>` +
      parts.join('') +
      pointsMarkup +
      `</svg>`;

    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const lat = tileYToLat(centerY, zoomLevel);
    const lon = tileXToLon(centerX, zoomLevel);
    const a = document.createElement('a');
    a.href = url;
    a.download = `contours-${lat.toFixed(4)}-${lon.toFixed(4)}-z${zoomLevel}.svg`;
    a.click();
    URL.revokeObjectURL(url);
    status.textContent = `Exported ${lastDrawnTiles.length} tiles`;
  } catch (err) {
    console.error(err);
    status.textContent = 'Export failed: ' + err.message;
  } finally {
    button.disabled = false;
  }
}

// --- Tile coordinate math (matches sketch.js) ---

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
