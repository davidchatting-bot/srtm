import express from "express";
import gdal from "gdal-async";  // npm install gdal-async
import { PNG } from "pngjs";    // npm install pngjs
import fs from "fs";
import path from "path";

const app = express();
const PORT = 3000;
const DATA_DIR = path.join(process.cwd(), "data");

// Convert lon/lat to SRTM filename (.hgt format, unzipped)
function lonLatToTile(lon, lat) {
  const latPrefix = lat >= 0 ? "N" : "S";
  const lonPrefix = lon >= 0 ? "E" : "W";
  const latStr = String(Math.abs(Math.floor(lat))).padStart(2, "0");
  const lonStr = String(Math.abs(Math.floor(lon))).padStart(3, "0");
  return `${latPrefix}${latStr}${lonPrefix}${lonStr}.hgt`;
}

// Get tiles that overlap bounding box
function getTilesForBounds(minLon, minLat, maxLon, maxLat) {
  const tiles = [];
  for (let lat = Math.floor(minLat); lat <= Math.floor(maxLat); lat++) {
    for (let lon = Math.floor(minLon); lon <= Math.floor(maxLon); lon++) {
      tiles.push(lonLatToTile(lon, lat));
    }
  }
  return tiles;
}

// Convert radius in km to degree offsets
function kmToDegreeOffsets(lat, radiusKm) {
  const latOffset = radiusKm / 111.32; // degrees latitude
  const lonOffset = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
  return { latOffset, lonOffset };
}

// Slippy tile helpers (Web Mercator / EPSG:3857)
const TILE_SIZE = 256;
const ELEV_MIN = -500;
const ELEV_MAX = 8500;
const ELEV_RANGE = ELEV_MAX - ELEV_MIN;

function tileToNWCorner(x, y, z) {
  const n = Math.pow(2, z);
  const lon = (x / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
  return { lon, lat };
}

function tileBounds(x, y, z) {
  const nw = tileToNWCorner(x, y, z);
  const se = tileToNWCorner(x + 1, y + 1, z);
  return { minLon: nw.lon, maxLon: se.lon, minLat: se.lat, maxLat: nw.lat };
}

// Convert output pixel position to geographic lon/lat (accounts for Mercator distortion)
function pixelToLonLat(px, py, tileX, tileY, z) {
  const n = Math.pow(2, z);
  const lon = ((tileX + px / TILE_SIZE) / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (tileY + py / TILE_SIZE)) / n))) * (180 / Math.PI);
  return { lon, lat };
}

// Load the overlap region of each available SRTM tile into a cache keyed by tile name
function loadSRTMCache(minLon, minLat, maxLon, maxLat) {
  const tileNames = getTilesForBounds(minLon, minLat, maxLon, maxLat);
  const cache = new Map();

  for (const name of tileNames) {
    const filePath = path.join(DATA_DIR, name);
    if (!fs.existsSync(filePath)) continue;

    const ds = gdal.open(filePath);
    const band = ds.bands.get(1);
    const tgt = ds.geoTransform;
    const tileWidth = band.size.x;
    const tileHeight = band.size.y;

    const tileMinLon = tgt[0];
    const tileMaxLat = tgt[3];
    const tileMaxLon = tileMinLon + tileWidth * tgt[1];
    const tileMinLat = tileMaxLat + tileHeight * tgt[5];

    const overlapMinLon = Math.max(minLon, tileMinLon);
    const overlapMaxLon = Math.min(maxLon, tileMaxLon);
    const overlapMinLat = Math.max(minLat, tileMinLat);
    const overlapMaxLat = Math.min(maxLat, tileMaxLat);

    if (overlapMinLon >= overlapMaxLon || overlapMinLat >= overlapMaxLat) {
      ds.close();
      continue;
    }

    const tx1 = Math.max(0, Math.floor((overlapMinLon - tgt[0]) / tgt[1]));
    const ty1 = Math.max(0, Math.floor((overlapMaxLat - tgt[3]) / tgt[5]));
    const tx2 = Math.min(tileWidth, Math.ceil((overlapMaxLon - tgt[0]) / tgt[1]));
    const ty2 = Math.min(tileHeight, Math.ceil((overlapMinLat - tgt[3]) / tgt[5]));

    const readWidth = tx2 - tx1;
    const readHeight = ty2 - ty1;

    if (readWidth <= 0 || readHeight <= 0) {
      ds.close();
      continue;
    }

    cache.set(name, {
      data: band.pixels.read(tx1, ty1, readWidth, readHeight),
      readWidth,
      readHeight,
      originLon: tgt[0] + tx1 * tgt[1],
      originLat: tgt[3] + ty1 * tgt[5], // top-left lat (northern edge)
      pixelWidth: tgt[1],
      pixelHeight: Math.abs(tgt[5]),
    });

    ds.close();
  }

  return cache;
}

app.get("/tiles/:z/:x/:y.png", async (req, res) => {
  try {
    const z = parseInt(req.params.z);
    const x = parseInt(req.params.x);
    const y = parseInt(req.params.y);

    if (isNaN(z) || isNaN(x) || isNaN(y)) {
      return res.status(400).send("Invalid tile coordinates");
    }

    const { minLon, maxLon, minLat, maxLat } = tileBounds(x, y, z);
    const cache = loadSRTMCache(minLon, minLat, maxLon, maxLat);

    const png = new PNG({ width: TILE_SIZE, height: TILE_SIZE });

    if (cache.size === 0) {
      // No data — return fully transparent tile so slippy map clients handle it gracefully
      png.data.fill(0);
      res.setHeader("Content-Type", "image/png");
      return png.pack().pipe(res);
    }

    // For each output pixel, inverse-project from Mercator to lon/lat and sample SRTM
    for (let py = 0; py < TILE_SIZE; py++) {
      for (let px = 0; px < TILE_SIZE; px++) {
        const { lon, lat } = pixelToLonLat(px + 0.5, py + 0.5, x, y, z);
        const cached = cache.get(lonLatToTile(lon, lat));

        const idx = (py * TILE_SIZE + px) * 4;

        if (!cached) {
          png.data[idx + 3] = 0; // transparent
          continue;
        }

        const { data, readWidth, readHeight, originLon, originLat, pixelWidth, pixelHeight } = cached;
        const sx = Math.floor((lon - originLon) / pixelWidth);
        const sy = Math.floor((originLat - lat) / pixelHeight);

        if (sx < 0 || sx >= readWidth || sy < 0 || sy >= readHeight) {
          png.data[idx + 3] = 0;
          continue;
        }

        const val = data[sy * readWidth + sx];

        if (val <= -32000) {
          // SRTM nodata value
          png.data[idx + 3] = 0;
          continue;
        }

        const norm = Math.max(0, Math.min(255, Math.floor(((val - ELEV_MIN) / ELEV_RANGE) * 255)));
        png.data[idx]     = norm;
        png.data[idx + 1] = norm;
        png.data[idx + 2] = norm;
        png.data[idx + 3] = 255;
      }
    }

    res.setHeader("Content-Type", "image/png");
    png.pack().pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

app.get("/terrain", async (req, res) => {
  try {
    const lon = parseFloat(req.query.lon);
    const lat = parseFloat(req.query.lat);
    const radiusKm = parseFloat(req.query.radius) || 5; // km

    if (isNaN(lon) || isNaN(lat)) {
      return res.status(400).send("Invalid lon/lat");
    }

    // Convert km radius to degree offsets
    const { latOffset, lonOffset } = kmToDegreeOffsets(lat, radiusKm);

    // Geographic bounding box
    const minLon = lon - lonOffset;
    const maxLon = lon + lonOffset;
    const minLat = lat - latOffset;
    const maxLat = lat + latOffset;

    // Find intersecting tiles, filter to those present on disk
    const tileNames = getTilesForBounds(minLon, minLat, maxLon, maxLat);
    console.log("Requested .hgt tile filenames:", tileNames);

    const availableTiles = tileNames
      .map(name => ({ name, filePath: path.join(DATA_DIR, name) }))
      .filter(({ filePath }) => fs.existsSync(filePath));

    if (availableTiles.length === 0) {
      console.warn("No .hgt files found for tiles:", tileNames);
      return res.status(404).send("No local data available for this location");
    }

    // Determine output resolution from first available tile
    const refDs = gdal.open(availableTiles[0].filePath);
    const geoTransform = refDs.geoTransform;
    refDs.close();

    const pixelWidth = geoTransform[1];            // degrees per pixel (lon)
    const pixelHeight = Math.abs(geoTransform[5]); // degrees per pixel (lat, always positive)

    const outWidth = Math.ceil((maxLon - minLon) / pixelWidth);
    const outHeight = Math.ceil((maxLat - minLat) / pixelHeight);

    if (outWidth <= 0 || outHeight <= 0) {
      return res.status(400).send("Requested area is out of bounds");
    }

    // Output buffer — NaN marks pixels with no data
    const outputRaster = new Float32Array(outWidth * outHeight).fill(NaN);

    // Read each tile and composite into output buffer
    for (const { filePath } of availableTiles) {
      const ds = gdal.open(filePath);
      const band = ds.bands.get(1);
      const tgt = ds.geoTransform;
      const tileWidth = band.size.x;
      const tileHeight = band.size.y;

      // Tile geographic extent
      const tileMinLon = tgt[0];
      const tileMaxLat = tgt[3];
      const tileMaxLon = tileMinLon + tileWidth * tgt[1];
      const tileMinLat = tileMaxLat + tileHeight * tgt[5]; // tgt[5] is negative

      // Clipped overlap in geographic coordinates
      const overlapMinLon = Math.max(minLon, tileMinLon);
      const overlapMaxLon = Math.min(maxLon, tileMaxLon);
      const overlapMinLat = Math.max(minLat, tileMinLat);
      const overlapMaxLat = Math.min(maxLat, tileMaxLat);

      if (overlapMinLon >= overlapMaxLon || overlapMinLat >= overlapMaxLat) {
        ds.close();
        continue;
      }

      // Pixel window within this tile
      let tx1 = Math.floor((overlapMinLon - tgt[0]) / tgt[1]);
      let ty1 = Math.floor((overlapMaxLat - tgt[3]) / tgt[5]);
      let tx2 = Math.ceil((overlapMaxLon - tgt[0]) / tgt[1]);
      let ty2 = Math.ceil((overlapMinLat - tgt[3]) / tgt[5]);

      tx1 = Math.max(0, Math.min(tileWidth - 1, tx1));
      tx2 = Math.max(0, Math.min(tileWidth, tx2));
      ty1 = Math.max(0, Math.min(tileHeight - 1, ty1));
      ty2 = Math.max(0, Math.min(tileHeight, ty2));

      const readWidth = tx2 - tx1;
      const readHeight = ty2 - ty1;

      if (readWidth <= 0 || readHeight <= 0) {
        ds.close();
        continue;
      }

      const tileData = band.pixels.read(tx1, ty1, readWidth, readHeight);

      // Geographic origin of the pixels we read
      const readOriginLon = tgt[0] + tx1 * tgt[1];
      const readOriginLat = tgt[3] + ty1 * tgt[5];

      // Offset in the output buffer
      const outOffX = Math.round((readOriginLon - minLon) / pixelWidth);
      const outOffY = Math.round((maxLat - readOriginLat) / pixelHeight);

      for (let row = 0; row < readHeight; row++) {
        for (let col = 0; col < readWidth; col++) {
          const outX = outOffX + col;
          const outY = outOffY + row;
          if (outX >= 0 && outX < outWidth && outY >= 0 && outY < outHeight) {
            outputRaster[outY * outWidth + outX] = tileData[row * readWidth + col];
          }
        }
      }

      ds.close();
    }

    // Find min/max across valid pixels
    let min = Infinity;
    let max = -Infinity;
    for (const v of outputRaster) {
      if (!isNaN(v)) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    if (min === Infinity) {
      return res.status(404).send("No elevation data available for this area");
    }

    const range = max - min || 1; // avoid division by zero for flat areas
    const png = new PNG({ width: outWidth, height: outHeight });

    for (let i = 0; i < outputRaster.length; i++) {
      const val = outputRaster[i];
      const norm = isNaN(val) ? 0 : Math.floor(((val - min) / range) * 255);
      const idx = i * 4;
      png.data[idx] = norm;
      png.data[idx + 1] = norm;
      png.data[idx + 2] = norm;
      png.data[idx + 3] = isNaN(val) ? 0 : 255; // transparent for missing tiles
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
