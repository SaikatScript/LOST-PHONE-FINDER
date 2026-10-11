import { useState } from 'react';
import { View, Text, Image, StyleSheet, ActivityIndicator } from 'react-native';

// NOTE: react-native-webview is NOT imported at top level. The installed APK
// predates that native module, and merely importing it crashes old binaries
// (TurboModule registry enforces at import time). It is require()d lazily
// inside WebViewMap, which only mounts when the renderer flag says so.

// Renderer switch (dev builds load JS from Metro, so flipping this is instant):
//   tiles   = pure-JS OSM tile grid, zero native modules (works on any build)
//   webview = interactive Leaflet map (needs react-native-webview in the native binary)
const USE_WEBVIEW = (process.env.EXPO_PUBLIC_MAP_RENDERER ?? 'tiles') === 'webview';

const TILE = 256;
const MAP_HEIGHT = 320;

// Keyless tiles via Esri World Street Map (free, no API key).
// tile.openstreetmap.org 403s default mobile user-agents; CARTO basemaps now
// require an API key too. Esri order is z/y/x.
// https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer
const tileUrl = (z, x, y) =>
  `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;
const ATTR = 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics';
const n = (z) => Math.pow(2, z);
const lonToX = (lon, z) => ((lon + 180) / 360) * n(z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n(z);
};

function chooseView(markers) {
  if (markers.length === 0) return { lat: 20.5937, lng: 78.9629, zoom: 5 };
  if (markers.length === 1) return { lat: markers[0].lat, lng: markers[0].lng, zoom: 15 };
  const lats = markers.map((m) => m.lat);
  const lngs = markers.map((m) => m.lng);
  const spanLon = Math.max(...lngs) - Math.min(...lngs) || 0.01;
  const spanLat = Math.max(...lats) - Math.min(...lats) || 0.01;
  const zLon = Math.log2(360 / (spanLon * 1.5));
  const zLat = Math.log2(170 / (spanLat * 1.5));
  const zoom = Math.max(3, Math.min(16, Math.floor(Math.min(zLon, zLat))));
  return {
    lat: (Math.max(...lats) + Math.min(...lats)) / 2,
    lng: (Math.max(...lngs) + Math.min(...lngs)) / 2,
    zoom,
  };
}

function TileGrid({ markers }) {
  const [width, setWidth] = useState(0);
  const { lat, lng, zoom } = chooseView(markers);
  const total = n(zoom);

  if (!width) {
    return (
      <View
        style={[styles.map, styles.loading]}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        <ActivityIndicator />
      </View>
    );
  }

  const cx = lonToX(lng, zoom) * TILE;
  const cy = latToY(lat, zoom) * TILE;
  const left = cx - width / 2;
  const top = cy - MAP_HEIGHT / 2;
  const x0 = Math.floor(left / TILE);
  const x1 = Math.floor((left + width) / TILE);
  const y0 = Math.floor(top / TILE);
  const y1 = Math.floor((top + MAP_HEIGHT) / TILE);

  const tiles = [];
  for (let x = x0; x <= x1; x++) {
    const wrappedX = ((x % total) + total) % total;
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= total) continue;
      tiles.push(
        <Image
          key={`${x}/${y}`}
          source={{
            uri: tileUrl(zoom, wrappedX, y),
            headers: { 'User-Agent': 'LostPhoneFinder/1.0 (anti-theft device tracker)' },
          }}
          style={{ position: 'absolute', width: TILE, height: TILE, left: x * TILE - left, top: y * TILE - top }}
        />
      );
    }
  }

  return (
    <View style={styles.map} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {tiles}
      {markers.map((m, i) => {
        const mx = lonToX(m.lng, zoom) * TILE - left;
        const my = latToY(m.lat, zoom) * TILE - top;
        if (mx < -20 || my < -20 || mx > width + 20 || my > MAP_HEIGHT + 20) return null;
        return (
          <View
            key={m.id ?? i}
            style={[
              styles.dot,
              { left: mx - 9, top: my - 9, backgroundColor: m.color ?? (i === 0 ? 'red' : 'blue') },
            ]}
          />
        );
      })}
      <Text style={styles.attr}>{ATTR}</Text>
    </View>
  );
}

// --- Interactive Leaflet map (needs WebView native module in the build) ---
function buildHtml(markers) {
  const data = JSON.stringify(
    markers.map((m) => ({
      lat: m.lat,
      lng: m.lng,
      title: m.title ?? 'Device',
      description: m.description ?? '',
      color: m.color ?? 'blue',
    }))
  );
  return `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>html,body,#map{height:100%;margin:0;padding:0}</style></head><body><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var markers = ${data};
var map = L.map('map').setView([20.5937, 78.9629], 5);
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  maxZoom: 19,
  attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics'
}).addTo(map);
var bounds = [];
markers.forEach(function(m) {
  var icon = L.divIcon({
    className: 'pin',
    html: '<div style="background:' + m.color + ';width:14px;height:14px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 4px #000"></div>',
    iconSize: [18, 18], iconAnchor: [9, 9]
  });
  L.marker([m.lat, m.lng], { icon: icon }).addTo(map)
    .bindPopup('<b>' + m.title + '</b><br/>' + m.description);
  bounds.push([m.lat, m.lng]);
});
if (bounds.length === 1) map.setView(bounds[0], 15);
else if (bounds.length > 1) map.fitBounds(bounds, { padding: [30, 30] });
</script></body></html>`;
}

export default function DeviceMap({ markers }) {
  if (USE_WEBVIEW) {
    // Lazy require: evaluated only when this branch mounts, so old binaries
    // without RNCWebViewModule never touch the native module.
    const { WebView } = require('react-native-webview');
    return (
      <WebView style={styles.map} originWhitelist={['*']} source={{ html: buildHtml(markers) }} />
    );
  }
  return <TileGrid markers={markers} />;
}

const styles = StyleSheet.create({
  map: { width: '100%', height: MAP_HEIGHT, overflow: 'hidden', backgroundColor: '#e5e3df' },
  loading: { alignItems: 'center', justifyContent: 'center' },
  dot: {
    position: 'absolute',
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: '#fff',
  },
  attr: {
    position: 'absolute',
    right: 4,
    bottom: 2,
    fontSize: 10,
    color: '#333',
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
});
