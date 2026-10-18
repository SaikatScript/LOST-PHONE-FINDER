import { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Image, StyleSheet, ActivityIndicator } from 'react-native';

// NOTE: react-native-webview is NOT imported at top level. The installed APK
// predates that native module, and merely importing it crashes old binaries
// (TurboModule registry enforces at import time). It is require()d lazily
// inside WebViewMap, which only mounts when the renderer flag says so.

// Renderer switch (dev builds load JS from Metro, so flipping this is instant):
//   tiles   = pure-JS tile grid, zero native modules (works on any build)
//   webview = interactive Leaflet map (needs react-native-webview in the binary)
const USE_WEBVIEW = (process.env.EXPO_PUBLIC_MAP_RENDERER ?? 'tiles') === 'webview';

const TILE = 256;
const MAP_HEIGHT = 340;

// --- Keyless tile sources (no API key, no billing) -------------------------
// Why satellite first: in rural India the street rasters (Esri World Street,
// Google) are blank at z15+ — a blank square is useless when you are trying to
// walk to your stolen phone. Imagery always shows buildings, fields, roads.
// Esri order is z/y/x; OSM order is z/x/y.
const ESRI_IMAGERY =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const ESRI_LABELS =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const ESRI_TOPO =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}';
const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

const ATTR = 'Imagery © Esri, Maxar • Labels © Esri • Streets © OpenStreetMap';
const n = (z) => Math.pow(2, z);
const lonToX = (lon, z) => ((lon + 180) / 360) * n(z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n(z);
};
const esri = (url, z, x, y) => url.replace('{z}', z).replace('{y}', y).replace('{x}', x);

function chooseView(markers) {
  if (markers.length === 0) return { lat: 20.5937, lng: 78.9629, zoom: 5 };
  if (markers.length === 1) return { lat: markers[0].lat, lng: markers[0].lng, zoom: 16 };
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

// --- Pure-JS fallback: satellite tiles + place-name overlay ---------------
function TileGrid({ markers }) {
  const [width, setWidth] = useState(0);
  const [labelsOn, setLabelsOn] = useState(true);
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
      const pos = { position: 'absolute', width: TILE, height: TILE, left: x * TILE - left, top: y * TILE - top };
      tiles.push(
        <Image key={`img/${x}/${y}`} source={{ uri: esri(ESRI_IMAGERY, zoom, wrappedX, y) }} style={pos} />
      );
      if (labelsOn) {
        tiles.push(
          <Image key={`lbl/${x}/${y}`} source={{ uri: esri(ESRI_LABELS, zoom, wrappedX, y) }} style={pos} />
        );
      }
    }
  }

  return (
    <View>
      <View style={styles.map} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {tiles}
        {markers.map((m, i) => {
          const mx = lonToX(m.lng, zoom) * TILE - left;
          const my = latToY(m.lat, zoom) * TILE - top;
          if (mx < -20 || my < -20 || mx > width + 20 || my > MAP_HEIGHT + 20) return null;
          const acc = m.acc ? (m.acc / (156543.03392 * Math.cos((m.lat * Math.PI) / 180) / total)) : 0;
          return (
            <View key={m.id ?? i}>
              {acc > 3 ? (
                <View
                  style={[
                    styles.accuracyRing,
                    { left: mx - acc, top: my - acc, width: acc * 2, height: acc * 2, borderRadius: acc },
                  ]}
                />
              ) : null}
              <View
                style={[
                  styles.dot,
                  { left: mx - 9, top: my - 9, backgroundColor: m.color ?? (i === 0 ? 'red' : 'blue') },
                ]}
              />
            </View>
          );
        })}
        <Text style={styles.attr}>{ATTR}</Text>
        <Text style={styles.layerToggle} onPress={() => setLabelsOn(!labelsOn)}>
          {labelsOn ? 'Place names: on' : 'Place names: off'}
        </Text>
      </View>
    </View>
  );
}

// --- Interactive Leaflet map (needs WebView native module in the build) ----
// Built once; marker updates are pushed with injectJavaScript so the map keeps
// its pan/zoom instead of reloading the whole WebView on every new fix.
function buildHtml() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"/>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<style>
html,body,#map{height:100%;margin:0;padding:0;background:#e5e3df}
.leaflet-control-attribution{font-size:9px}
#recenter{position:absolute;z-index:1000;right:12px;bottom:34px;width:42px;height:42px;
  border-radius:21px;border:none;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.35);
  font-size:21px;line-height:42px;padding:0;cursor:pointer}
</style></head><body><div id="map"></div>
<button id="recenter" title="Centre on the latest fix">◎</button>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
var imagery = L.tileLayer('${ESRI_IMAGERY}', { maxZoom: 19, attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' });
var labels = L.tileLayer('${ESRI_LABELS}', { maxZoom: 19, opacity: 0.9, attribution: 'Place names &copy; Esri' });
var streets = L.tileLayer('${OSM_TILES}', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' });
var topo = L.tileLayer('${ESRI_TOPO}', { maxZoom: 19, attribution: 'Terrain &copy; Esri' });

var map = L.map('map', { center: [20.5937, 78.9629], zoom: 5, zoomControl: true });
imagery.addTo(map);
labels.addTo(map);
L.control.layers(
  { 'Satellite': imagery, 'Streets': streets, 'Terrain': topo },
  { 'Place names': labels },
  { position: 'topright', collapsed: true }
).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

var layer = L.layerGroup().addTo(map);
var pts = [];
var firstLoad = true;

function ageText(at) {
  if (!at) return '';
  var s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 90) return s + ' s ago';
  var m = Math.round(s / 60);
  if (m < 90) return m + ' min ago';
  var h = Math.round(m / 60);
  if (h < 36) return h + ' h ago';
  return Math.round(h / 24) + ' days ago';
}

window.setMarkers = function (list) {
  layer.clearLayers();
  pts = [];
  (list || []).forEach(function (m) {
    var html = '<b>' + (m.title || 'Device') + '</b>';
    if (m.description) html += '<br/>' + m.description;
    if (m.acc) html += '<br/>Accurate to about ' + Math.round(m.acc) + ' m';
    if (m.at) html += '<br/>Fix: ' + new Date(m.at).toLocaleString() + '<br/>(' + ageText(m.at) + ')';
    if (m.acc && m.acc > 3 && m.acc < 5000) {
      L.circle([m.lat, m.lng], {
        radius: m.acc, color: m.color, weight: 1, opacity: 0.6,
        fillColor: m.color, fillOpacity: 0.12
      }).addTo(layer);
    }
    var icon = L.divIcon({
      className: 'pin',
      html: '<div style="background:' + m.color + ';width:16px;height:16px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 5px #000"></div>',
      iconSize: [20, 20], iconAnchor: [10, 10]
    });
    L.marker([m.lat, m.lng], { icon: icon }).addTo(layer).bindPopup(html);
    pts.push([m.lat, m.lng]);
  });
  if (firstLoad && pts.length) {
    if (pts.length === 1) map.setView(pts[0], 16);
    else map.fitBounds(pts, { padding: [30, 30] });
    firstLoad = false;
  }
};

document.getElementById('recenter').onclick = function () {
  if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 16));
  else if (pts.length > 1) map.fitBounds(pts, { padding: [30, 30] });
};

// Marker circles need their own renderer reset when the map is resized.
window.addEventListener('resize', function () { map.invalidateSize(); });
</script></body></html>`;
}

function WebViewMap({ markers, payload }) {
  const { WebView } = require('react-native-webview');
  const ref = useRef(null);
  const dataRef = useRef('[]');
  const html = useMemo(() => buildHtml(), []);

  const push = () => {
    try {
      ref.current?.injectJavaScript(`window.setMarkers && window.setMarkers(${dataRef.current}); true;`);
    } catch {
      // WebView not ready yet — onLoadEnd pushes again.
    }
  };

  useEffect(() => {
    dataRef.current = JSON.stringify(payload);
    push();
  }, [payload]);

  return (
    <WebView
      ref={ref}
      style={styles.map}
      originWhitelist={['*']}
      source={{ html }}
      javaScriptEnabled
      domStorageEnabled
      onLoadEnd={push}
      // Keep the first fix from being lost if it arrives before the page loads.
      onMessage={() => {}}
    />
  );
}

export default function DeviceMap({ markers }) {
  const payload = useMemo(
    () =>
      markers.map((m) => ({
        lat: m.lat,
        lng: m.lng,
        title: m.title ?? 'Device',
        description: m.description ?? '',
        color: m.color ?? 'blue',
        acc: m.acc ?? null,
        at: m.at ?? null,
      })),
    [markers]
  );

  if (USE_WEBVIEW) {
    // Lazy require: evaluated only when this branch mounts, so old binaries
    // without RNCWebViewModule never touch the native module.
    return <WebViewMap markers={markers} payload={payload} />;
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
  accuracyRing: {
    position: 'absolute',
    backgroundColor: 'rgba(0,120,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(0,120,255,0.5)',
  },
  attr: {
    position: 'absolute',
    right: 4,
    bottom: 2,
    fontSize: 10,
    color: '#333',
    backgroundColor: 'rgba(255,255,255,0.7)',
  },
  layerToggle: {
    position: 'absolute',
    left: 4,
    bottom: 2,
    fontSize: 10,
    color: '#0a4',
    backgroundColor: 'rgba(255,255,255,0.85)',
    paddingHorizontal: 4,
  },
});
