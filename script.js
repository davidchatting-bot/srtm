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

    // Find intersecting tiles
    const tileNames = getTilesForBounds(minLon, minLat, maxLon, maxLat);
    console.log("Requested .hgt tile filenames:", tileNames);

    // Only use the first tile (assume always one)
    const hgtName = tileNames[0];
    const hgtPath = path.join(DATA_DIR, hgtName);

    if (!fs.existsSync(hgtPath)) {
      console.warn("Missing .hgt file:", hgtPath);
      return res.status(404).send("No local data available for this location");
    }

    // Open the single .hgt file directly
    const ds = gdal.open(hgtPath);
    const band = ds.bands.get(1);
    const geoTransform = ds.geoTransform;

    // Get raster size dynamically
    const rasterWidth = band.size.x;
    const rasterHeight = band.size.y;

    // Compute pixel window
    let x1 = Math.floor((minLon - geoTransform[0]) / geoTransform[1]);
    let y1 = Math.floor((maxLat - geoTransform[3]) / geoTransform[5]);
    let x2 = Math.ceil((maxLon - geoTransform[0]) / geoTransform[1]);
    let y2 = Math.ceil((minLat - geoTransform[3]) / geoTransform[5]);

    // Clamp to raster bounds
    x1 = Math.max(0, Math.min(rasterWidth - 1, x1));
    x2 = Math.max(0, Math.min(rasterWidth, x2));
    y1 = Math.max(0, Math.min(rasterHeight - 1, y1));
    y2 = Math.max(0, Math.min(rasterHeight, y2));

    const width = x2 - x1;
    const height = y2 - y1;

    if (width <= 0 || height <= 0) {
      return res.status(400).send("Requested area is out of bounds");
    }

    // Read raster subset
    const raster = band.pixels.read(x1, y1, width, height);

    // Normalize to grayscale 0–255
    const min = Math.min(...raster);
    const max = Math.max(...raster);
    const png = new PNG({ width, height });

    for (let i = 0; i < raster.length; i++) {
      const val = raster[i];
      const norm = Math.floor(((val - min) / (max - min)) * 255);
      const idx = i * 4;
      png.data[idx] = norm;
      png.data[idx + 1] = norm;
      png.data[idx + 2] = norm;
      png.data[idx + 3] = 255;
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
