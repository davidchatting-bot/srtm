# srtm

A minimal Node.js/Express service that serves terrain elevation data as PNG images from SRTM `.hgt` files.

## Setup

Place SRTM `.hgt` files in a `data/` directory at the project root, then:

```bash
npm install
node script.js
```

The server runs on port 3000.

## Usage

```
GET /terrain?lon=<longitude>&lat=<latitude>&radius=<km>
```

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `lon` | yes | — | Longitude in decimal degrees |
| `lat` | yes | — | Latitude in decimal degrees |
| `radius` | no | 5 | Radius in kilometres |

Returns a grayscale PNG where pixel brightness represents relative elevation within the requested area.

## Example

```
GET /terrain?lon=-0.118&lat=51.509&radius=10
```

## Data

SRTM `.hgt` files can be downloaded from [NASA Earthdata](https://earthdata.nasa.gov/). Files should follow the standard naming convention (e.g. `N51W001.hgt`).
