const CENTER_LON = -122.4194;
const CENTER_LAT  = 37.7749;
const RADIUS_KM   = 1;
const SAMPLES     = 64;

let heightmap = null;
let hN = 0;
let elevMin = 0;
let elevMax = 1;

function setup() {
  createCanvas(windowWidth, windowHeight);
  noLoop();
  fetchHeightmap();
}

function fetchHeightmap() {
  fetch(`/heightmap?lon=${CENTER_LON}&lat=${CENTER_LAT}&radius=${RADIUS_KM}&samples=${SAMPLES}`)
    .then(r => r.json())
    .then(d => {
      hN = d.samples;
      heightmap = d.data;
      elevMin = Infinity;
      elevMax = -Infinity;
      for (const v of heightmap) {
        if (v < elevMin) elevMin = v;
        if (v > elevMax) elevMax = v;
      }
      redraw();
    });
}

function getElev(ix, iy) {
  if (!heightmap || ix < 0 || ix >= hN || iy < 0 || iy >= hN) return elevMin;
  return heightmap[iy * hN + ix];
}

function draw() {
  background(15);

  if (!heightmap) {
    fill(180);
    noStroke();
    textAlign(CENTER, CENTER);
    textSize(16);
    text('Loading...', width / 2, height / 2);
    return;
  }

  const range     = elevMax - elevMin || 1;
  const cellW     = min(width * 0.95, height * 1.9) / (hN - 1);
  const cellH     = cellW / 2;
  const elevScale = cellH * 6 / range; // total elev range = 6 cell heights
  const cx        = width  / 2;
  const cy        = height * 0.6;

  // Precompute iso X (doesn't depend on elevation)
  const isoX = (ix, iy) => cx + (ix - iy) * cellW / 2;
  const isoY = (ix, iy, z) => cy + (ix + iy - hN + 1) * cellH / 2 - (z - elevMin) * elevScale;

  noStroke();

  // Painter's algorithm: draw diagonal strips back to front
  for (let d = 0; d < 2 * (hN - 1); d++) {
    for (let ix = 0; ix < hN - 1; ix++) {
      const iy = d - ix;
      if (iy < 0 || iy >= hN - 1) continue;

      const z00 = getElev(ix,     iy);
      const z10 = getElev(ix + 1, iy);
      const z11 = getElev(ix + 1, iy + 1);
      const z01 = getElev(ix,     iy + 1);
      const zAvg = (z00 + z10 + z11 + z01) / 4;

      // Hillshading: finite difference slope, light from upper-left
      const dzdx = (z10 + z11 - z00 - z01) / 2;
      const dzdy = (z01 + z11 - z00 - z10) / 2;
      const shade = constrain(0.6 + (dzdx - dzdy) / range, 0.15, 1.0);

      const t = (zAvg - elevMin) / range;
      const brightness = lerp(50, 230, t) * shade;

      fill(brightness);
      beginShape();
      vertex(isoX(ix,     iy),     isoY(ix,     iy,     z00));
      vertex(isoX(ix + 1, iy),     isoY(ix + 1, iy,     z10));
      vertex(isoX(ix + 1, iy + 1), isoY(ix + 1, iy + 1, z11));
      vertex(isoX(ix,     iy + 1), isoY(ix,     iy + 1, z01));
      endShape(CLOSE);
    }
  }

  // Info overlay
  fill(255, 200);
  noStroke();
  textAlign(LEFT, BOTTOM);
  textSize(12);
  text(`${CENTER_LAT.toFixed(4)}°, ${CENTER_LON.toFixed(4)}° · ${RADIUS_KM}km radius · ${hN}×${hN} samples`, 12, height - 12);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  redraw();
}
