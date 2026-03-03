import express from "express";
import { PNG } from "pngjs";
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(process.cwd(), "data");
const TILE_SIZE = 256;
const ELEV_MIN = -500;
const ELEV_MAX = 8500;
const ELEV_RANGE = ELEV_MAX - ELEV_MIN;

app.use(express.static(path.join(process.cwd(), "p5js")));

// --- HGT file reading ---
// .hgt files are a flat row-major grid of big-endian signed Int16.
// Resolution is inferred from file size: 1201×1201 (SRTM3) or 3601×3601 (SRTM1).
// Origin is parsed from the filename (SW corner of the 1°×1° tile).

function openHGT(filePath) {
  const data = fs.readFileSync(filePath);
  const size = Math.round(Math.sqrt(data.length / 2)); // 1201 or 3601
  const pixelDeg = 1 / (size - 1);
  const name = path.basename(filePath, ".hgt");
  const swLat = (name[0] === "N" ? 1 : -1) * parseInt(name.slice(1, 3));
  const swLon = (name[3] === "E" ? 1 : -1) * parseInt(name.slice(4, 7));
  return {
    data,
    size,
    pixelDeg,
    minLon: swLon,
    maxLon: swLon + 1,
    minLat: swLat,
    maxLat: swLat + 1, // north edge
  };
}

function readHGTRegion(hgt, tx1, ty1, w, h) {
  const { data, size } = hgt;
  const out = new Float32Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const val = data.readInt16BE(((ty1 + row) * size + (tx1 + col)) * 2);
      out[row * w + col] = val <= -32768 ? NaN : val;
    }
  }
  return out;
}

// --- SRTM tile name helpers ---

function lonLatToTileName(lon, lat) {
  const latStr = (lat >= 0 ? "N" : "S") + String(Math.abs(Math.floor(lat))).padStart(2, "0");
  const lonStr = (lon >= 0 ? "E" : "W") + String(Math.abs(Math.floor(lon))).padStart(3, "0");
  return `${latStr}${lonStr}.hgt`;
}

function getTileNamesForBounds(minLon, minLat, maxLon, maxLat) {
  const tiles = [];
  for (let lat = Math.floor(minLat); lat <= Math.floor(maxLat); lat++) {
    for (let lon = Math.floor(minLon); lon <= Math.floor(maxLon); lon++) {
      tiles.push(lonLatToTileName(lon, lat));
    }
  }
  return tiles;
}

// Load each overlapping HGT tile's relevant region into a cache keyed by tile name
function loadSRTMCache(viewMinLon, viewMinLat, viewMaxLon, viewMaxLat) {
  const cache = new Map();
  for (const name of getTileNamesForBounds(viewMinLon, viewMinLat, viewMaxLon, viewMaxLat)) {
    const filePath = path.join(DATA_DIR, name);
    if (!fs.existsSync(filePath)) continue;

    const hgt = openHGT(filePath);
    const { minLon, maxLon, minLat, maxLat, pixelDeg, size } = hgt;

    const oMinLon = Math.max(viewMinLon, minLon);
    const oMaxLon = Math.min(viewMaxLon, maxLon);
    const oMinLat = Math.max(viewMinLat, minLat);
    const oMaxLat = Math.min(viewMaxLat, maxLat);
    if (oMinLon >= oMaxLon || oMinLat >= oMaxLat) continue;

    const tx1 = Math.max(0, Math.floor((oMinLon - minLon) / pixelDeg));
    const tx2 = Math.min(size, Math.ceil((oMaxLon - minLon) / pixelDeg));
    const ty1 = Math.max(0, Math.floor((maxLat - oMaxLat) / pixelDeg));
    const ty2 = Math.min(size, Math.ceil((maxLat - oMinLat) / pixelDeg));

    const readWidth  = tx2 - tx1;
    const readHeight = ty2 - ty1;
    if (readWidth <= 0 || readHeight <= 0) continue;

    cache.set(name, {
      data:       readHGTRegion(hgt, tx1, ty1, readWidth, readHeight),
      readWidth,
      readHeight,
      originLon:  minLon + tx1 * pixelDeg, // west edge of read region
      originLat:  maxLat - ty1 * pixelDeg, // north edge of read region
      pixelDeg,
    });
  }
  return cache;
}

function sampleCache(cache, lon, lat) {
  const c = cache.get(lonLatToTileName(lon, lat));
  if (!c) return NaN;
  const sx = Math.floor((lon - c.originLon) / c.pixelDeg);
  const sy = Math.floor((c.originLat - lat) / c.pixelDeg);
  if (sx < 0 || sx >= c.readWidth || sy < 0 || sy >= c.readHeight) return NaN;
  return c.data[sy * c.readWidth + sx];
}

// --- Slippy tile math (Web Mercator) ---

function tileToNWCorner(x, y, z) {
  const n = Math.pow(2, z);
  return {
    lon: (x / n) * 360 - 180,
    lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI),
  };
}

function tileBounds(x, y, z) {
  const nw = tileToNWCorner(x, y, z);
  const se = tileToNWCorner(x + 1, y + 1, z);
  return { minLon: nw.lon, maxLon: se.lon, minLat: se.lat, maxLat: nw.lat };
}

function pixelToLonLat(px, py, tileX, tileY, z) {
  const n = Math.pow(2, z);
  const lon = ((tileX + px / TILE_SIZE) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + py / TILE_SIZE)) / n))) * (180 / Math.PI);
  return { lon, lat };
}

// --- Convert km radius to degree offsets ---

function kmToDegreeOffsets(lat, radiusKm) {
  return {
    latOffset: radiusKm / 111.32,
    lonOffset: radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180)),
  };
}

// --- Routes ---

app.get("/info", (req, res) => {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".hgt"));
  if (files.length === 0) return res.status(404).json({ error: "No data" });
  const { pixelDeg } = openHGT(path.join(DATA_DIR, files[0]));
  res.json({ pixelDeg, files });
});

app.get("/heightmap", (req, res) => {
  const lon     = parseFloat(req.query.lon);
  const lat     = parseFloat(req.query.lat);
  const radiusKm = parseFloat(req.query.radius)  || 1;
  const samples  = Math.min(256, Math.max(2, parseInt(req.query.samples) || 64));

  if (isNaN(lon) || isNaN(lat)) return res.status(400).send("Invalid lon/lat");

  const { latOffset, lonOffset } = kmToDegreeOffsets(lat, radiusKm);
  const cache = loadSRTMCache(lon - lonOffset, lat - latOffset, lon + lonOffset, lat + latOffset);
  if (cache.size === 0) return res.status(404).send("No elevation data available");

  const data = new Array(samples * samples);
  for (let row = 0; row < samples; row++) {
    for (let col = 0; col < samples; col++) {
      const sLon = (lon - lonOffset) + (col / (samples - 1)) * lonOffset * 2;
      const sLat = (lat + latOffset) - (row / (samples - 1)) * latOffset * 2;
      const val  = sampleCache(cache, sLon, sLat);
      data[row * samples + col] = isNaN(val) ? 0 : val;
    }
  }

  res.json({ samples, data });
});

app.get("/tiles/:z/:x/:y.png", (req, res) => {
  try {
    const z = parseInt(req.params.z);
    const x = parseInt(req.params.x);
    const y = parseInt(req.params.y);
    if (isNaN(z) || isNaN(x) || isNaN(y)) return res.status(400).send("Invalid tile coordinates");

    const { minLon, maxLon, minLat, maxLat } = tileBounds(x, y, z);
    const cache = loadSRTMCache(minLon, minLat, maxLon, maxLat);
    const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });

    if (cache.size === 0) {
      png.data.fill(0); // fully transparent
      res.setHeader("Content-Type", "image/png");
      return png.pack().pipe(res);
    }

    for (let py = 0; py < TILE_SIZE; py++) {
      for (let px = 0; px < TILE_SIZE; px++) {
        const { lon, lat } = pixelToLonLat(px + 0.5, py + 0.5, x, y, z);
        const val = sampleCache(cache, lon, lat);
        const idx = (py * TILE_SIZE + px) * 4;
        if (isNaN(val)) {
          png.data[idx + 3] = 0;
        } else {
          const norm = Math.max(0, Math.min(255, Math.floor(((val - ELEV_MIN) / ELEV_RANGE) * 255)));
          png.data[idx]     = norm;
          png.data[idx + 1] = norm;
          png.data[idx + 2] = norm;
          png.data[idx + 3] = 255;
        }
      }
    }

    res.setHeader("Content-Type", "image/png");
    png.pack().pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.get("/terrain", (req, res) => {
  try {
    const lon = parseFloat(req.query.lon);
    const lat = parseFloat(req.query.lat);
    const radiusKm = parseFloat(req.query.radius) || 5;
    if (isNaN(lon) || isNaN(lat)) return res.status(400).send("Invalid lon/lat");

    const { latOffset, lonOffset } = kmToDegreeOffsets(lat, radiusKm);
    const minLon = lon - lonOffset;
    const maxLon = lon + lonOffset;
    const minLat = lat - latOffset;
    const maxLat = lat + latOffset;

    const tileNames = getTileNamesForBounds(minLon, minLat, maxLon, maxLat);
    console.log("Requested .hgt tile filenames:", tileNames);

    const available = tileNames
      .map(name => path.join(DATA_DIR, name))
      .filter(fp => fs.existsSync(fp));

    if (available.length === 0) {
      console.warn("No .hgt files found for tiles:", tileNames);
      return res.status(404).send("No local data available for this location");
    }

    const { pixelDeg } = openHGT(available[0]);
    const outWidth  = Math.ceil((maxLon - minLon) / pixelDeg);
    const outHeight = Math.ceil((maxLat - minLat) / pixelDeg);
    if (outWidth <= 0 || outHeight <= 0) return res.status(400).send("Requested area is out of bounds");

    const outputRaster = new Float32Array(outWidth * outHeight).fill(NaN);

    for (const filePath of available) {
      const hgt = openHGT(filePath);
      const { minLon: tMinLon, maxLon: tMaxLon, minLat: tMinLat, maxLat: tMaxLat, size } = hgt;

      const oMinLon = Math.max(minLon, tMinLon);
      const oMaxLon = Math.min(maxLon, tMaxLon);
      const oMinLat = Math.max(minLat, tMinLat);
      const oMaxLat = Math.min(maxLat, tMaxLat);
      if (oMinLon >= oMaxLon || oMinLat >= oMaxLat) continue;

      const tx1 = Math.max(0, Math.floor((oMinLon - tMinLon) / pixelDeg));
      const tx2 = Math.min(size, Math.ceil((oMaxLon - tMinLon) / pixelDeg));
      const ty1 = Math.max(0, Math.floor((tMaxLat - oMaxLat) / pixelDeg));
      const ty2 = Math.min(size, Math.ceil((tMaxLat - oMinLat) / pixelDeg));

      const rw = tx2 - tx1;
      const rh = ty2 - ty1;
      if (rw <= 0 || rh <= 0) continue;

      const region = readHGTRegion(hgt, tx1, ty1, rw, rh);
      const readOriginLon = tMinLon + tx1 * pixelDeg;
      const readOriginLat = tMaxLat - ty1 * pixelDeg;
      const outOffX = Math.round((readOriginLon - minLon) / pixelDeg);
      const outOffY = Math.round((maxLat - readOriginLat) / pixelDeg);

      for (let row = 0; row < rh; row++) {
        for (let col = 0; col < rw; col++) {
          const outX = outOffX + col;
          const outY = outOffY + row;
          if (outX >= 0 && outX < outWidth && outY >= 0 && outY < outHeight) {
            outputRaster[outY * outWidth + outX] = region[row * rw + col];
          }
        }
      }
    }

    let min = Infinity, max = -Infinity;
    for (const v of outputRaster) {
      if (!isNaN(v)) { if (v < min) min = v; if (v > max) max = v; }
    }
    if (min === Infinity) return res.status(404).send("No elevation data available for this area");

    const range = max - min || 1;
    const png = new PNG({ width: outWidth, height: outHeight });
    for (let i = 0; i < outputRaster.length; i++) {
      const val = outputRaster[i];
      const norm = isNaN(val) ? 0 : Math.floor(((val - min) / range) * 255);
      const idx = i * 4;
      png.data[idx] = norm; png.data[idx + 1] = norm; png.data[idx + 2] = norm;
      png.data[idx + 3] = isNaN(val) ? 0 : 255;
    }

    res.setHeader("Content-Type", "image/png");
    png.pack().pipe(res);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
