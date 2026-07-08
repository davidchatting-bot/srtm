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
let previousZoom = null;    // last zoom whose tiles were *fully* loaded — drawn
                             // scaled as a placeholder under the current zoom so
                             // a zoom change doesn't flash to blank grey while
                             // the new zoom's (more numerous) tiles fetch
let centerX, centerY;       // fractional tile coords at the current zoomLevel
let tileCache = {};         // keyed "z/x/y" -> { img: p5.Image|null, status }
let isDragging = false;
let lastDragX, lastDragY;
let lastDrawnTiles = [];    // tiles actually placed on screen last frame, for export

let csvRows;                // loaded in preload(), parsed in setup()
let csvPoints = [];         // from p5js/data/log.csv — { lat, lon, visible }
let cloudPoints = [];       // from testVisibilityAroundOrigin() — { lat, lon, visible }
let activeDataset = 'cloud'; // 'cloud' or 'csv' — which of the above `points` mirrors
let points = [];            // whichever dataset is active; draw()/exportSVG() just read this

const VISIBILITY_ORIGIN = { lat: 56.2483517, lon: -2.7796033 };

function preload() {
  csvRows = loadStrings('/data/log.csv');
}

function setup() {
  createCanvas(windowWidth, windowHeight).parent('map');

  for (let i = 1; i < csvRows.length; i++) {
    const cols = csvRows[i].split(',');
    if (cols.length < 6) continue;
    csvPoints.push({
      // Normalised to the same { lat, lon, visible } shape as the visibility
      // cloud below, so pointColor()/drawPoints()/exportSVG() don't need to
      // know which dataset is active — DIRECT reuses the same green/red
      // visible/not-visible colouring as a "visible" reading.
      visible: cols[0] === 'DIRECT',
      lat: parseFloat(cols[4]),
      lon: parseFloat(cols[5]),
    });
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get('points')) document.getElementById('test-points-input').value = params.get('points');
  if (params.get('testRadius')) document.getElementById('test-radius-input').value = params.get('testRadius');
  testVisibilityAroundOrigin();

  const lon = parseFloat(params.get('lon')) || parseFloat(document.getElementById('lon-input').value);
  const lat = parseFloat(params.get('lat')) || parseFloat(document.getElementById('lat-input').value);
  centerX = lonToTileX(lon, zoomLevel);
  centerY = latToTileY(lat, zoomLevel);

  requestMissingTiles();
  noLoop();
  redraw();
}

// Pressing D flips between the LoRa traceroute log (p5js/data/log.csv) and
// the random /visibility test cloud. Both datasets stay loaded at all times
// (testVisibilityAroundOrigin() keeps cloudPoints fresh in the background);
// this just changes which one `points` mirrors.
function keyPressed() {
  if (key === 'd' || key === 'D') {
    activeDataset = activeDataset === 'cloud' ? 'csv' : 'cloud';
    points = activeDataset === 'cloud' ? cloudPoints : csvPoints;
    redraw();
  }
}

// Scatters a random number of points (the "Test points" field) within
// "Test radius (km)" of VISIBILITY_ORIGIN (uniform over the disk's area, not
// just the radius), then asks /visibility whether each is visible from that
// origin — exercising the same line-of-sight code as /viewshed, just
// point-by-point instead of scanning for the boundary.
function testVisibilityAroundOrigin() {
  const numPoints = Math.max(1, parseInt(document.getElementById('test-points-input').value) || 500);
  const radiusKm = Math.max(0.1, parseFloat(document.getElementById('test-radius-input').value) || 5);

  const targets = [];
  for (let i = 0; i < numPoints; i++) {
    const distKm = Math.sqrt(Math.random()) * radiusKm;
    const bearing = Math.random() * 2 * Math.PI;
    const kmPerDegLat = 111.32;
    const kmPerDegLon = 111.32 * Math.cos((VISIBILITY_ORIGIN.lat * Math.PI) / 180);
    targets.push({
      lat: VISIBILITY_ORIGIN.lat + (distKm * Math.cos(bearing)) / kmPerDegLat,
      lon: VISIBILITY_ORIGIN.lon + (distKm * Math.sin(bearing)) / kmPerDegLon,
    });
  }

  // POST with a JSON body, not GET with a query string — a few hundred
  // targets packed into a URL overflows the server's request-header limit
  // (HTTP 431); POST has no such limit.
  fetch('/visibility', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      lon: VISIBILITY_ORIGIN.lon,
      lat: VISIBILITY_ORIGIN.lat,
      targets: targets.map(t => [t.lon, t.lat]),
    }),
  })
    .then(res => res.json())
    .then(data => {
      cloudPoints = data.results.map(r => ({ lat: r.lat, lon: r.lon, visible: r.visible }));
      if (activeDataset === 'cloud') points = cloudPoints;
      redraw();
    })
    .catch(err => console.error('visibility test failed', err));
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

// The tile range (in zoom-z tile coordinates) needed to cover the current
// view, given the view's centre is expressed in zoomLevel's units. scale
// converts a zoom-z tile coordinate into zoomLevel's fractional units —
// >1 when z is a shallower (more zoomed out) level being scaled up to fill
// the same screen area, <1 when scaling a deeper level down.
//
// Safety cap: if z is many levels away from zoomLevel (e.g. a fast pinch
// gesture firing dozens of wheel events drove zoomLevel from 18 to 1 in one
// frame, while a placeholder pass still references previousZoom=18), scale
// collapses toward 0 and tilesAcross/tilesDown — ceil(width/drawSize) —
// explodes into the hundreds of thousands. That's a nested loop with
// billions of iterations, which hangs/crashes the tab. MAX_PLACEHOLDER_TILES
// keeps the tile count bounded no matter how extreme the zoom gap gets.
const MAX_PLACEHOLDER_TILES = 64;
function tileRangeForZoom(z) {
  const scale = Math.pow(2, zoomLevel - z);
  const drawSize = TILE_SIZE * scale;
  const cx = centerX / scale;
  const cy = centerY / scale;
  const tilesAcross = Math.min(MAX_PLACEHOLDER_TILES, Math.ceil(width / drawSize) + 2);
  const tilesDown = Math.min(MAX_PLACEHOLDER_TILES, Math.ceil(height / drawSize) + 2);
  return {
    scale, drawSize,
    tx0: Math.floor(cx - tilesAcross / 2),
    ty0: Math.floor(cy - tilesDown / 2),
    tilesAcross, tilesDown,
    maxTile: Math.pow(2, z),
  };
}

function requestMissingTiles() {
  const query = buildTileQuery();
  const { tx0, ty0, tilesAcross, tilesDown, maxTile } = tileRangeForZoom(zoomLevel);

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

// Draws every loaded tile at zoom z that falls within the current view.
// Returns how many of the needed tiles were actually loaded, so draw() can
// tell whether this zoom is fully ready yet. Only records lastDrawnTiles
// (used by exportSVG) when drawing the real current zoom, not a placeholder.
function drawTilesAtZoom(z, query, isCurrent) {
  const { scale, drawSize, tx0, ty0, tilesAcross, tilesDown, maxTile } = tileRangeForZoom(z);
  let loadedCount = 0, neededCount = 0;

  for (let dx = 0; dx <= tilesAcross; dx++) {
    for (let dy = 0; dy <= tilesDown; dy++) {
      const tx = tx0 + dx;
      const ty = ty0 + dy;
      if (ty < 0 || ty >= maxTile) continue;
      neededCount++;
      const wtx = ((tx % maxTile) + maxTile) % maxTile;
      const key = `${z}/${wtx}/${ty}/${query}`;
      const entry = tileCache[key];
      if (!entry || entry.status !== 'loaded') continue;
      loadedCount++;

      const { x, y } = tileToScreen(tx * scale, ty * scale);
      image(entry.img, x, y, drawSize, drawSize);
      if (isCurrent) lastDrawnTiles.push({ screenX: x, screenY: y, svgText: entry.svgText });
    }
  }
  return { loadedCount, neededCount };
}

function draw() {
  background(128);
  lastDrawnTiles = [];
  const query = buildTileQuery();

  // Show the last fully-loaded zoom (scaled) underneath while the current
  // zoom's tiles are still arriving, instead of flashing to blank grey. Skip
  // it if the gap is too large to be a useful approximation anyway (e.g. a
  // fast pinch gesture jumping many levels at once) — at that point one old
  // tile would cover a huge area at essentially no visual detail, and we'd
  // rather not even approach the MAX_PLACEHOLDER_TILES cap.
  if (previousZoom !== null && previousZoom !== zoomLevel && Math.abs(previousZoom - zoomLevel) <= 6) {
    drawTilesAtZoom(previousZoom, query, false);
  }

  const { loadedCount, neededCount } = drawTilesAtZoom(zoomLevel, query, true);
  if (neededCount > 0 && loadedCount === neededCount) previousZoom = zoomLevel;

  drawPoints();
  updateInfo();
}

// Visibility test points: green if visible from VISIBILITY_ORIGIN, red if not.
function pointColor(p) {
  return p.visible ? color(50, 220, 80) : color(220, 50, 50);
}

// Screen position of VISIBILITY_ORIGIN at the current view, or null if off-screen.
function originScreenPos() {
  const tx = lonToTileX(VISIBILITY_ORIGIN.lon, zoomLevel);
  const ty = latToTileY(VISIBILITY_ORIGIN.lat, zoomLevel);
  const { x, y } = tileToScreen(tx, ty);
  if (x < -10 || x > width + 10 || y < -10 || y > height + 10) return null;
  return { x, y };
}

function drawOriginCross(x, y) {
  stroke(255, 220, 0);
  strokeWeight(2);
  line(x - 8, y, x + 8, y);
  line(x, y - 8, x, y + 8);
  noStroke();
}

function drawPoints() {
  noStroke();
  for (const p of points) {
    const tx = lonToTileX(p.lon, zoomLevel);
    const ty = latToTileY(p.lat, zoomLevel);
    const { x, y } = tileToScreen(tx, ty);
    if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue;

    fill(pointColor(p));
    circle(x, y, 6);
  }

  const origin = originScreenPos();
  if (origin) drawOriginCross(origin.x, origin.y);
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
  testVisibilityAroundOrigin();
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

let zoomRequestTimer = null;

// Zooming is via the +/- buttons (zoomIn()/zoomOut()) only — scroll-wheel and
// trackpad pinch are intentionally disabled (a fast pinch gesture firing many
// wheel events was the source of the zoom-jump browser crash; buttons mean
// zoomLevel only ever changes one step at a time, deliberately). Still
// returning false here, so the browser doesn't fall back to scrolling the
// page or its own native pinch-to-zoom on the now-unhandled gesture.
function mouseWheel(event) {
  return false;
}

// Zooms on the view centre — there's no cursor position to anchor to when
// the zoom came from a button click rather than a pointer gesture. Same
// debounced-request pattern as the old wheel handler: redraw immediately for
// responsiveness, but delay the actual tile fetch slightly in case of rapid
// repeated clicks.
function zoomBy(delta) {
  const lon = tileXToLon(centerX, zoomLevel);
  const lat = tileYToLat(centerY, zoomLevel);
  zoomLevel = constrain(zoomLevel + delta, MIN_ZOOM, MAX_ZOOM);
  centerX = lonToTileX(lon, zoomLevel);
  centerY = latToTileY(lat, zoomLevel);
  redraw();

  clearTimeout(zoomRequestTimer);
  zoomRequestTimer = setTimeout(requestMissingTiles, 150);
}

function zoomIn() {
  zoomBy(1);
}

function zoomOut() {
  zoomBy(-1);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  requestMissingTiles();
  redraw();
}

function updateInfo() {
  const info = document.getElementById('info');
  if (!info) return;
  const datasetLabel = activeDataset === 'cloud' ? 'random visibility cloud' : 'log.csv';
  info.textContent = `${tileYToLat(centerY, zoomLevel).toFixed(4)}°, ${tileXToLon(centerX, zoomLevel).toFixed(4)}° — z${zoomLevel} — [D] ${datasetLabel} (${points.length} pts)`;
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
      const tx = lonToTileX(p.lon, zoomLevel);
      const ty = latToTileY(p.lat, zoomLevel);
      const { x, y } = tileToScreen(tx, ty);
      if (x < -10 || x > width + 10 || y < -10 || y > height + 10) continue;
      const c = pointColor(p);
      pointsMarkup += `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3" fill="rgb(${red(c)},${green(c)},${blue(c)})"/>`;
    }

    const origin = originScreenPos();
    if (origin) {
      pointsMarkup += `<g stroke="rgb(255,220,0)" stroke-width="2">` +
        `<line x1="${(origin.x - 8).toFixed(2)}" y1="${origin.y.toFixed(2)}" x2="${(origin.x + 8).toFixed(2)}" y2="${origin.y.toFixed(2)}"/>` +
        `<line x1="${origin.x.toFixed(2)}" y1="${(origin.y - 8).toFixed(2)}" x2="${origin.x.toFixed(2)}" y2="${(origin.y + 8).toFixed(2)}"/>` +
        `</g>`;
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
