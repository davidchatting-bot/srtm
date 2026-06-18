# srtm

A Node.js/Express service that serves SRTM terrain elevation data as slippy map tiles, plus a p5.js isometric viewer that renders the terrain as a 3-D bar chart.

## Setup

Place SRTM `.hgt` files in a `data/` directory at the project root, then:

```bash
npm install
node script.js
```

The server runs on port 3000.

## Running as a service

A systemd unit file is included. Install it with:

```bash
sudo cp srtm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now srtm
```

## Contour SVG cache

`/contours.svg` and `/contour-tiles/:z/:x/:y.svg` are backed by a disk cache at `cache/` (gitignored, created on first use). Each request's parameters are hashed into a cache key; a hit is served straight off disk, a miss is computed as normal and then written to the cache before responding. Node still needs to be running to serve requests (cache misses fall through to the normal compute path, and there's no separate static-serving tier), but once an area has been requested it's cheap to re-serve, and you can pre-warm the cache for a demo area by just requesting it ahead of time (e.g. with `curl`, or by panning the slippy map yourself) so sharing the demo doesn't trigger a slow first render for the next viewer.

The cache key includes every parameter that affects the output (location/tile coordinates, resolution, interval, stroke width, size), so different query strings never collide.

### Pre-warming the cache

`warm-cache.js` requests the same tile URLs `contours.html`'s slippy map would, for a range of zooms around a point, so they're already cached before you share the demo:

```bash
node warm-cache.js                                              # defaults to Anstruther, zooms 12-17, radius 2 tiles
node warm-cache.js --lat 56.2208 --lon -2.7036 --zooms 12-17 --radius 2
node warm-cache.js --base-url http://localhost:3000 --concurrency 6
```

It hits the running server over HTTP, so the server still needs to be up while warming. Once warmed, requests for that area come straight off disk regardless of who's asking.

## Elevation encoding

Tiles use 16-bit precision encoded across the R and G channels (`R << 8 | G`) over a fixed range of −500 m to 8500 m. The viewer decodes this as `(v16 / 65535) * 9000 − 500`.

## Viewer

Open `http://localhost:3000` in a browser to see an isometric bar-chart of the terrain centred on San Francisco. Each bar represents one SRTM sample (~90 m for SRTM3, ~30 m for SRTM1). Bar height is proportional to elevation above sea level; colour is fixed: blue at sea level, green above. Drag to pan.

To change location or view radius edit the constants at the top of `p5js/sketch.js`.

## Endpoints

### Slippy map tiles

```
GET /tiles/:z/:x/:y.png
```

Standard XYZ tiles compatible with Leaflet, OpenLayers, Mapbox GL, etc.:

```js
L.tileLayer('http://localhost:3000/tiles/{z}/{x}/{y}.png').addTo(map);
```

Elevation is encoded as grayscale over a fixed range (−500 m to 8500 m) so neighbouring tiles are visually consistent. Areas with no data are transparent.

### Data info

```
GET /info
```

Returns JSON describing the loaded SRTM data:

```json
{ "pixelDeg": 0.000833, "files": ["N37W123.hgt"] }
```

`pixelDeg` is the native sample spacing in degrees (1/1200 for SRTM3, 1/3600 for SRTM1). The viewer uses this to set the bar-chart resolution.

### Bounding-box terrain image

```
GET /terrain?lon=<longitude>&lat=<latitude>&radius=<km>
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `lon` | yes | — | Longitude in decimal degrees |
| `lat` | yes | — | Latitude in decimal degrees |
| `radius` | no | 5 | Radius in kilometres |

Returns a grayscale PNG at full SRTM resolution centred on the given point. Brightness is normalised to the local min/max elevation.

### Contour map (SVG)

```
GET /contours.svg?lon=<longitude>&lat=<latitude>&radius=<km>&resolution=<n>&interval=<m>&size=<px>&strokeWidth=<px>&greyMin=<m>&greyMax=<m>
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `lon` | yes | — | Longitude in decimal degrees |
| `lat` | yes | — | Latitude in decimal degrees |
| `radius` | no | 5 | Radius in kilometres |
| `resolution` | no | 100 | Sampling grid size (NxN), 8–400 |
| `interval` | no | auto | Contour interval in metres; auto picks a "nice" interval for ~12 levels across the local elevation range |
| `size` | no | 800 | Output SVG width/height in pixels |
| `strokeWidth` | no | 1 | Contour line stroke width in pixels |
| `greyMin` / `greyMax` | no | -500 / 8500 | Elevation range (metres) mapped to grey 0–255. The default spans sea-level to Everest so a given elevation is the same grey everywhere, but that means modest local relief (most of the UK, ~0–200m) only occupies a sliver of it and every line looks almost the same near-black grey. Narrow this to the area's actual elevation range (e.g. `greyMin=0&greyMax=150`) for visible contrast |

Returns an SVG image with one contour line per elevation level, computed via marching squares over a resampled elevation grid. Each contour line is shaded a level of grey proportional to its elevation. Elevation samples are bilinearly interpolated, and each contour is chained into a single path and rendered as a quadratic-Bezier smoothed curve rather than raw straight segments, to avoid a blocky/faceted look.

### Contour slippy tiles (SVG)

```
GET /contour-tiles/:z/:x/:y.svg?resolution=<n>&interval=<m>&strokeWidth=<px>&greyMin=<m>&greyMax=<m>
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `resolution` | no | 128 | Sampling grid size per tile (NxN), 8–256 |
| `interval` | no | by zoom | Contour interval in metres. Default is keyed by zoom level only, so every tile at a given zoom uses the same levels and lines connect across tile edges — a per-tile auto interval based on local relief would pick different levels per tile and the lines wouldn't line up |
| `strokeWidth` | no | 1 | Contour line stroke width in pixels |
| `greyMin` / `greyMax` | no | -500 / 8500 | Same elevation→grey range as `/contours.svg` above. Narrowing it to the area's relief is what makes contour lines visually distinguishable instead of all rendering as nearly the same dark grey — as long as the same range is requested for every tile in a session (the demo page does this), neighbouring tiles still agree on which grey a given elevation gets |

The zoom-keyed interval default mirrors real OS leisure-map intervals, anchored at the zoom level the equivalent published scale converts to (`metresPerPixel = 156543 * cos(lat) / 2^z`, equator-approximate):

| Zoom | Interval | Equivalent scale |
|------|----------|-------------------|
| ≤9 | 100m | wider than 1:1,000,000 |
| ≤11 | 50m | ~1:250,000 |
| ≤12 | 20m | ~1:100,000 |
| ≤14 | 10m | ~1:50,000 — OS Landranger interval |
| ≤16 | 5m | ~1:25,000 — OS Explorer interval (lowland) |
| ≤18 | 2m | ~1:10,000 — finer than any OS leisure map |
| >18 | 1m | survey/LIDAR-grade resolution |

OS Explorer doubles its interval to 10m in mountainous regions, but that's decided per published map sheet (a fixed boundary), not computed live — doing it per-tile from local relief would make neighbouring tiles disagree right where one straddles the steep/flat line, breaking the cross-tile stitching above. Pass `?interval=10` explicitly for mountainous areas instead of relying on auto-detection.

Standard XYZ contour tiles, greyscale-encoded the same way as `/contours.svg`, with a transparent background — usable as a slippy-map overlay:

```js
L.tileLayer('http://localhost:3000/contour-tiles/{z}/{x}/{y}.svg').addTo(map);
```

A pannable/zoomable demo page using these tiles is available at `/contours.html` (`p5js/contours-sketch.js`) — a p5.js sketch, not Leaflet: it fetches each tile's SVG itself, decodes it into a `p5.Image` via a local blob URL (drawing straight from the server URL makes the browser fetch the same SVG twice), and draws tiles directly to the canvas with its own pan (drag) and zoom (scroll) handling, following the same tile-coordinate math as the isometric viewer's `sketch.js`. It also plots `p5js/data/log.csv` (a LoRa traceroute log — gitignored, not checked in) as coloured points: green for a `DIRECT` result, red otherwise.

Its "Export SVG" button merges every tile currently on screen into a single flat SVG — reusing each tile's already-fetched markup, stripped of its outer `<svg>` wrapper and re-placed in a `<g transform="translate(...)">` at the screen position it was drawn at — plus the visible points, and downloads it as one seamless vector file (not a screenshot).

## Data

This service uses **NASA Shuttle Radar Topography Mission Global 1 arc second V003** data. A free NASA Earthdata account is required to download files.

- Dataset: https://doi.org/10.5067/MEASURES/SRTM/SRTMGL1.003

Files should follow the standard naming convention (e.g. `N51W001.hgt`).

### Data license

The SRTM dataset is freely available under the [EOSDIS Data Use Policy](https://www.earthdata.nasa.gov/engage/open-data-services-and-software/data-use-policy). Use requires the following citation:

> NASA JPL (2013). *NASA Shuttle Radar Topography Mission Global 1 arc second* [Data set]. NASA Land Processes Distributed Active Archive Center. https://doi.org/10.5067/MEASURES/SRTM/SRTMGL1.003

## License

This software is released under the [MIT License](LICENSE).
