# srtm

A Node.js/Express service that serves SRTM terrain elevation data as slippy map tiles, plus a p5.js isometric viewer that renders the terrain as a 3-D bar chart.

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/davidchatting/srtm.git
cd srtm
```

### 2. Install dependencies

```bash
npm install
```

### 3. Add SRTM elevation data

This repo does not include or distribute any SRTM data — you need to supply your own `.hgt` tiles.

This service uses **NASA Shuttle Radar Topography Mission Global 1 arc second V003** data. A free NASA Earthdata account is required to download files.

- Dataset: https://doi.org/10.5067/MEASURES/SRTM/SRTMGL1.003

Files should follow the standard naming convention (e.g. `N51W001.hgt`) and be placed in a `data/` directory at the project root. Only tiles covering the area(s) you want to view/query are needed — the server just skips locations it has no matching tile for (see `/info` below to check what's currently loaded).

#### Data license

The SRTM dataset is freely available under the [EOSDIS Data Use Policy](https://www.earthdata.nasa.gov/engage/open-data-services-and-software/data-use-policy). Use requires the following citation:

> NASA JPL (2013). *NASA Shuttle Radar Topography Mission Global 1 arc second* [Data set]. NASA Land Processes Distributed Active Archive Center. https://doi.org/10.5067/MEASURES/SRTM/SRTMGL1.003

### 4. Run

```bash
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

## Viewer

Open `http://localhost:3000` in a browser to see an isometric bar-chart of the terrain. It defaults to `LON_DEFAULT`/`LAT_DEFAULT` in `p5js/sketch.js` — currently 55°N, 1.6°W — but shows nothing until you've placed the matching `.hgt` tile(s) for that location (or your chosen one) in `data/`. Each bar represents one SRTM sample (~90 m for SRTM3, ~30 m for SRTM1). Bar height is proportional to elevation above sea level; colour is fixed: blue at sea level, green above. Drag to pan.

To change location or view radius edit `LON_DEFAULT`/`LAT_DEFAULT`/`RADIUS_KM` at the top of `p5js/sketch.js`, or pass `?lat=<lat>&lon=<lon>` in the URL.

## Endpoints

### Data info

```
GET /info
```

Returns JSON describing the loaded SRTM data:

```json
{ "pixelDeg": 0.000833, "files": ["N37W123.hgt"] }
```

`pixelDeg` is the native sample spacing in degrees (1/1200 for SRTM3, 1/3600 for SRTM1). The viewer uses this to set the bar-chart resolution.

### Slippy map tiles

```
GET /tiles/:z/:x/:y.png
```

Standard XYZ tiles compatible with Leaflet, OpenLayers, Mapbox GL, etc.:

```js
L.tileLayer('http://localhost:3000/tiles/{z}/{x}/{y}.png').addTo(map);
```

Elevation is encoded at 16-bit precision across the R and G channels (`R << 8 | G`) over a fixed range of −500 m to 8500 m, so neighbouring tiles are visually consistent — this is not a grayscale image, R and G individually look like arbitrary noise. The viewer decodes this as `(v16 / 65535) * 9000 − 500`. Areas with no data are transparent.

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

A pannable/zoomable demo page using these tiles is available at `/contours.html` (`p5js/contours-sketch.js`) — a p5.js sketch, not Leaflet: it fetches each tile's SVG itself, decodes it into a `p5.Image` via a local blob URL (drawing straight from the server URL makes the browser fetch the same SVG twice), and draws tiles directly to the canvas with its own pan (drag) handling, following the same tile-coordinate math as the isometric viewer's `sketch.js`.

Zooming is via the +/- buttons (bottom-right, `zoomIn()`/`zoomOut()`) only — scroll-wheel and trackpad pinch are deliberately disabled. A fast pinch gesture fires many wheel events in one frame, which both (a) is how a zoom-jump crash was triggered (see below) and (b) is exactly the kind of multi-step-at-once interaction the buttons rule out by construction — each click is its own single zoom step. `mouseWheel` still returns `false` so the gesture doesn't fall through to the browser's own page-scroll or native pinch-zoom. Button zooms centre on the view middle (there's no cursor position to anchor to from a click); a `zoomBy()`/`zoomIn()`/`zoomOut()` API is exposed globally if cursor-anchored wheel zoom is ever wanted back.

It also exercises `/visibility`: on load (and on every "Go / Apply") it scatters the number of points given by "Test points" (default 500) randomly within "Test radius (km)" (default 10) of a fixed origin — marked with a yellow cross — asks `/visibility` whether each is visible from that origin, and plots them green (visible) or red (not). Both fields can also be set via URL params (`?points=20&testRadius=2`).

Press **D** to flip between that random visibility cloud and the LoRa traceroute log at `p5js/data/log.csv` (gitignored — green for a `DIRECT` result, red otherwise, normalised into the same `visible` field so the colouring/export code doesn't need to know which dataset is active). Both datasets stay loaded at all times; `D` just changes which one `points` mirrors. The bottom-left info readout shows which is active and how many points it has.

Deeper zooms need more tiles to cover the same screen area (e.g. 224 vs 56), so there's a brief window after zooming where the new zoom's tiles are still fetching. Rather than leaving that blank, `draw()` first draws the last zoom that *fully* loaded, scaled to fit the current view, underneath the current zoom's tiles — so zooming shows a blurry-but-present placeholder instead of a flash of grey.

The actual tile *request* on each zoom step is debounced (150ms): rapidly clicking +/- repeatedly changes `zoomLevel` once per click, and requesting tiles on every single click would queue a full fetch+render batch per level passed through — leaving the zoom you actually land on stuck behind several already-irrelevant batches for several seconds. `zoomLevel`/`centerX`/`centerY` still update and redraw immediately on every click (so the placeholder below keeps the view responsive); only the network request waits for clicking to pause.

Originally zoom was scroll-wheel/pinch driven, and a fast trackpad pinch gesture firing many wheel events in one frame (e.g. swinging `zoomLevel` 18 → 1 before `previousZoom` caught up) crashed the tab: the placeholder draw's scale factor is `2^(zoomLevel - previousZoom)`, and when that gap is large the implied tile size collapses toward zero, so `tilesAcross`/`tilesDown` (`ceil(viewportSize / tileSize)`) explodes into the hundreds of thousands — turning a nested loop that's normally a few dozen iterations into billions. Scroll/pinch are now disabled specifically so a gesture can't drive `zoomLevel` across many steps in a single frame, but the same jump is still reachable by rapidly clicking a zoom button many times before a redraw catches up, so the fix stayed in place rather than being removed: `tileRangeForZoom` caps the tile count at `MAX_PLACEHOLDER_TILES` (64) as a hard backstop, and `draw()` skips the placeholder pass entirely once the gap exceeds 6 levels.

Its "Export SVG" button merges every tile currently on screen into a single flat SVG — reusing each tile's already-fetched markup, stripped of its outer `<svg>` wrapper and re-placed in a `<g transform="translate(...)">` at the screen position it was drawn at — plus the visible points, and downloads it as one seamless vector file (not a screenshot).

### Contour cache

`/contours.svg` and `/contour-tiles/:z/:x/:y.svg` are backed by a disk cache at `cache/` (gitignored, created on first use). Each request's parameters are hashed into a cache key; a hit is served straight off disk, a miss is computed as normal and then written to the cache before responding. Node still needs to be running to serve requests (cache misses fall through to the normal compute path, and there's no separate static-serving tier), but once an area has been requested it's cheap to re-serve, and you can pre-warm the cache for a demo area by just requesting it ahead of time (e.g. with `curl`, or by panning the slippy map yourself) so sharing the demo doesn't trigger a slow first render for the next viewer.

The cache key includes every parameter that affects the output (location/tile coordinates, resolution, interval, stroke width, size), so different query strings never collide.

#### Pre-warming the cache

`warm-cache.js` requests the same tile URLs `contours.html`'s slippy map would, for a range of zooms around a point, so they're already cached before you share the demo:

```bash
node warm-cache.js                                              # defaults to Anstruther, zooms 12-17, radius 2 tiles
node warm-cache.js --lat 56.2208 --lon -2.7036 --zooms 12-17 --radius 2
node warm-cache.js --base-url http://localhost:3000 --concurrency 6
```

It hits the running server over HTTP, so the server still needs to be up while warming. Once warmed, requests for that area come straight off disk regardless of who's asking.

### How line-of-sight is calculated

`/viewshed` and `/visibility` are two views onto the same underlying test, implemented once in `lineOfSightAngle`/`lineOfSightAngleAtElevation` and reused by both routes. The core idea: walk outward from the observer along a bearing, and at each point compute the *elevation angle* from the observer to that point — the angle above (or below) the horizontal that you'd have to look. A point is visible only if nothing closer along that same line has a steeper (larger) angle, because anything steeper sticks up further into your view and blocks whatever's behind it.

```
elevation
   ^
   |                                            *  T2 — visible: its angle is
   |                                       *        *steeper* than the hill's,
   |                                  *            so the line to T2 clears it
   |                             *  <- line of sight, observer to T2
   |                        *
   |                   *
   |              *
   |         *  <- line of sight, observer to the hilltop
   |    .--^--.
   |   /  hill \                                  x  T1 — NOT visible: its
   |  /         \                            - - -    angle is *shallower*
   | o  observer  \                     - - -          than the hill's, so
   | (ground + eye  \               - -                the hill blocks it
   |  height)         \         - -
   +--------------------+---------+----------------------------------> distance
                       hill        T1                  T2
```

Each point's apparent height isn't just its raw elevation, though — Earth curves away beneath a straight line of sight, so a point far enough away is effectively lower than its elevation alone would suggest. `curvatureDropM` subtracts that drop (scaled up by 7/6 by default, the standard approximation for atmospheric refraction bending the ray slightly back toward the surface) before the angle is computed:

```
   o ─────────────────────────────────────────────  •   straight chord — what
    \                                            ,·'      the distance/height
     \                                       ,·'           numbers alone imply
      \                                  ,·'
       \                             ,·'    ╲  actual line of sight: bends
        \                        ,·'          ╲ down to follow the curve, so
         \___________________,·'                a point right at the chord's
              observer                            height reads as *lower* —
                                                    drop = d² / (2 · R_eff)
```

`/viewshed` (scan outward, find the boundary) and `/visibility` (check specific points) both run this same sweep — they just ask a different question of it:

```
/viewshed: for one bearing, keep marching out to `radius`, remembering          /visibility: for one target, march the points strictly between
the *furthest* point whose angle ever became the new running maximum.          observer and target (same running-max sweep), then check whether
                                                                                 the target's own angle clears that maximum.

        *                                                                              x  target (checked once, at its exact distance)
       /  <- furthest point that set a new max angle becomes a ring vertex             ↑
      *                                                                                | line of sight from observer
  .--^--.        ↑ scanning outward, bearing fixed, distance increasing            .--^--.    ↑ same sweep, but only out to the target's
 /       \       o observer                                                       /       \   o observer    own distance, then one angle check
```

Because both are discretized (a finite number of bearings/steps, a finite sampling density along each path), they can disagree right at a visibility boundary — see the note at the end of the `/visibility` section below for why, and how to tighten it up.

### Viewshed (line-of-sight horizon)

```
GET /viewshed?lon=<longitude>&lat=<latitude>&radius=<km>&directions=<n>&steps=<n>&observerHeight=<m>&targetHeight=<m>&refraction=<bool>
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `lon` | yes | — | Observer longitude in decimal degrees |
| `lat` | yes | — | Observer latitude in decimal degrees |
| `radius` | no | 30 | Maximum search radius in kilometres, 0.5–200 |
| `directions` | no | 360 | Number of bearings sampled around the observer, 8–720 |
| `steps` | no | 256 | Samples taken along each bearing out to `radius`, 8–2000 |
| `observerHeight` | no | 1.7 | Height (metres) added to the observer's ground elevation, e.g. eye height |
| `targetHeight` | no | 0 | Height (metres) added to every sampled target point, e.g. to ask "can I see the top of a 10m mast" |
| `refraction` | no | true | Whether to apply the standard 7/6-Earth-radius correction for atmospheric refraction (pass `false` for pure geometric line of sight) |

For each bearing, marches outward sampling elevation (bilinearly interpolated, same as the other endpoints) and tracks the point with the steepest line-of-sight angle seen so far — a point further out is only "visible" if its angle clears every closer point along that bearing, accounting for Earth's curvature. The single furthest visible point per bearing becomes one vertex of the returned shape. No-data samples (e.g. open sea beyond the loaded tiles) are treated as sea level rather than a gap, so looking out to sea still gives a sensible curvature-limited range.

Returns a GeoJSON `Feature` with a `Polygon` geometry — the boundary of furthest visibility in every direction:

```json
{ "type": "Feature", "properties": { "lon": -2.7036, "lat": 56.2208, "radiusKm": 30, ... },
  "geometry": { "type": "Polygon", "coordinates": [[[lon, lat], ...]] } }
```

Note the shape can be sharply non-convex — a hillside 200m away can legitimately be the furthest visible point in one direction while an adjacent bearing looking down an open valley or coastline sees 20+ km, with no smooth transition between them.

### Visibility (specific points)

```
GET /visibility?lon=<longitude>&lat=<latitude>&targets=<lon,lat[,altitude]|...>&observerHeight=<m>&targetHeight=<m>&refraction=<bool>&stepsPerKm=<n>
POST /visibility   { "lon", "lat", "targets": [[lon, lat], [lon, lat, altitude], ...], "observerHeight", "targetHeight", "refraction", "stepsPerKm" }
```

The other side of the same line-of-sight test as `/viewshed` (both share the same `lineOfSightAngle`/`lineOfSightAngleAtElevation` code): instead of scanning outward to find the visibility boundary, checks specific target points against the observer.

GET packs `targets` into the query string, which is fine for a handful of points but overflows the server's request-header limit (HTTP 431) somewhere in the low hundreds. POST takes the same data as a JSON body instead, with no such limit — use it for any non-trivial target list (the demo page's 500-point test uses POST).

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `lon` / `lat` | yes | — | Observer position |
| `targets` | yes | — | `\|`-separated list of targets, each `lon,lat` or `lon,lat,altitude` |
| `observerHeight` | no | 1.7 | Height (metres) added to the observer's ground elevation |
| `targetHeight` | no | 0 | Height (metres) added to a target's ground elevation — only used for targets *without* an explicit altitude |
| `refraction` | no | true | Same 7/6-Earth-radius correction as `/viewshed` |
| `stepsPerKm` | no | 10 | Samples per kilometre along each observer→target path, 1–50 |

A target given as `lon,lat` is assumed to sit at ground level — whatever that happens to be at that point — plus `targetHeight`. A target given as `lon,lat,altitude` is pinned to that absolute altitude instead (e.g. a drone at a known height), ignoring both the sampled terrain and `targetHeight` for that point.

```json
{ "lon": -2.7036, "lat": 56.2208, "observerHeight": 1.7, "targetHeight": 0, "refraction": true,
  "results": [
    { "lon": -2.9, "lat": 56.05, "distanceKm": 22.556, "visible": true, "groundElevation": 0, "altitude": 500 }
  ] }
```

Because `/viewshed` and `/visibility` sample at different resolutions (a fixed step count over a fixed radius vs. a fixed density per path, since every target is a different distance away), they can disagree right at a visibility boundary — a point `/viewshed` reports as its furthest-visible in some direction might come back `visible: false` here at the default `stepsPerKm`, because the finer sampling along that specific path catches an intermediate obstruction the coarser radial scan stepped over. Raising `stepsPerKm` (or lowering `/viewshed`'s `steps`) narrows that gap; neither endpoint is "wrong", they're both discretized approximations of a continuous problem.

## License

This software is released under the [MIT License](LICENSE).
