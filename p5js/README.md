# p5js — Isometric Terrain Viewer

A browser-based isometric bar-chart viewer for the SRTM tile server. Served automatically at `http://localhost:3000` when the parent server is running.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page shell — mounts the p5.js canvas and a coordinate overlay |
| `style.css` | Full-screen canvas, grab cursor, fixed info overlay |
| `sketch.js` | All rendering logic |

## How it works

1. **`preload()`** fetches `/info` from the server to get the native SRTM sample spacing (`pixelDeg`), then computes `GRID_W × GRID_H` so each bar in the chart maps to exactly one SRTM data point.
2. **`ensureTilesLoaded()`** requests grayscale elevation tiles (`/tiles/z/x/y.png`) for all slippy-map tiles in the current view. Pixel data is extracted once on load via `img.loadPixels()` and cached as a `Uint8Array`.
3. **`draw()`** samples the cached tile pixels at each grid cell, decodes the grayscale value back to metres (`pixel/255 × 9000 − 500`), then renders every cell as an isometric bar using the painter's algorithm (back-to-front along ascending `gx+gy` diagonals).
4. Each bar has three visible faces (top, right, front) shaded at different brightnesses to give a 3-D appearance. Colour is determined by elevation: **blue at sea level, green above**.

## Configuration

All tunable values are constants at the top of `sketch.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `LON` | −122.4194 | Centre longitude |
| `LAT` | 37.7749 | Centre latitude |
| `RADIUS_KM` | 5 | Half-width of the view in kilometres |
| `DATA_ZOOM` | 14 | Slippy-map zoom level for tile requests |
| `ELEV_DISPLAY_MAX` | 300 | Elevation (metres) at which the colour scale tops out |

## Interaction

| Action | Effect |
|--------|--------|
| Drag | Pan the view |
| Window resize | Canvas and layout recalculate automatically |
