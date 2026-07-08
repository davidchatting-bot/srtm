# p5js — Isometric Terrain Viewer

A browser-based isometric bar-chart viewer for the SRTM tile server. Served automatically at `http://localhost:3000` when the parent server is running.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page shell — mounts the p5.js canvas and a coordinate overlay |
| `style.css` | Full-screen canvas, grab cursor, fixed info overlay |
| `sketch.js` | All rendering logic |

## How it works

1. **`preload()`** fetches `/info` from the server to get the native SRTM sample spacing (`pixelDeg`); **`setup()`** then uses it to compute `GRID_W × GRID_H` (so each bar in the chart maps to exactly one SRTM data point) and the `DATA_ZOOM` tile-request level.
2. **`ensureTilesLoaded()`** requests elevation tiles (`/tiles/z/x/y.png`) for all slippy-map tiles in the current view. Pixel data is extracted once on load via `img.loadPixels()` and cached as a `Uint8Array`.
3. **`draw()`** samples the cached tile pixels at each grid cell, decodes the 16-bit R/G-encoded value back to metres (`v16 = (R << 8) | G`, then `(v16 / 65535) × 9000 − 500`), then renders the scene in four layers (back to front):
   - **Soil layer** — opaque brown diamond, offset `maxBarH × 2.875` below ground.
   - **Sea layer** — opaque blue diamond at ground level (0 m). Cells at or below sea level are skipped in the bar loop; this layer covers them.
   - **Terrain bars** — green isometric bars for cells above sea level, rendered back-to-front (ascending `gx+gy` diagonals). Each bar has three faces (top, right, front) at different brightnesses for a 3-D appearance.
   - **Sky layer** — semi-transparent blue diamond, offset `maxBarH × 2.875` above ground.

## Configuration

Most tunable values are constants at the top of `sketch.js`:

| Constant | Default | Description |
|----------|---------|-------------|
| `LON_DEFAULT` | −1.6 | Centre longitude, overridable via `?lon=` in the URL |
| `LAT_DEFAULT` | 55.0 | Centre latitude, overridable via `?lat=` in the URL |
| `RADIUS_KM` | 2.5 | Half-width of the view in kilometres |
| `ELEV_MIN` / `ELEV_RANGE` | −500 / 9000 | Must match the server's elevation encoding range |
| `ELEV_DISPLAY_MAX` | 300 | Elevation (metres) at which the colour scale tops out |
| `MAX_BARS` | 120 | Cap on bars per axis, to bound draw cost for large views |

`DATA_ZOOM` isn't one of these — it's computed in `setup()` from the server's `pixelDeg` so tile requests match the loaded SRTM resolution, rather than being a value you'd tune directly.

## Interaction

| Action | Effect |
|--------|--------|
| Drag | Pan the view |
| Window resize | Canvas and layout recalculate automatically |
