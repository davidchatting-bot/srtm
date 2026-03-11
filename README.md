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

## Data

This service uses **NASA Shuttle Radar Topography Mission Global 1 arc second V003** data. A free NASA Earthdata account is required to download files.

- Dataset: https://doi.org/10.5067/MEASURES/SRTM/SRTMGL1.003

Files should follow the standard naming convention (e.g. `N51W001.hgt`).

### Data license

The SRTM dataset is freely available under the [EOSDIS Data Use Policy](https://www.earthdata.nasa.gov/engage/open-data-services-and-software/data-use-policy). Use requires the following citation:

> NASA JPL (2013). *NASA Shuttle Radar Topography Mission Global 1 arc second* [Data set]. NASA Land Processes Distributed Active Archive Center. https://doi.org/10.5067/MEASURES/SRTM/SRTMGL1.003

## License

This software is released under the [MIT License](LICENSE).
