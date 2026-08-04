# Traffic Forecast

A static React/Radix UI app for visualizing Google Routes API travel-time forecasts in both directions.

The app runs entirely in the browser. Enter your own Google Maps API key, origin, destination, departure window, and interval. The chart shows optimistic-to-pessimistic ranges as translucent bands with best-guess lines through the middle.

## Local Development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

The production build is written to `dist/`.

## GitHub Pages

This repo is configured for GitHub Pages at:

```text
https://ryanfeeley.github.io/traffic-forecast/
```

The app does not include an API key. Configure your Google Maps API key in Google Cloud and enter it in the app.
