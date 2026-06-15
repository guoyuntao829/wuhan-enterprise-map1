/* ============================================================
   武汉都市圈科技企业空间分布专题地图 - 主应用
   功能：数据加载、地图初始化、分级统计图、分区统计图表、
   分级符号法、统计图表法、范围法、聚类、飞线、
   3D视角、下钻
   ============================================================ */

// ============================================================
// CONFIGURATION
// ============================================================
var CONFIG = {
  center: [114.0, 30.5],
  zoom: 9,
  minZoom: 8,
  maxZoom: 16,
  clusterZoom: 15,
  gridSize: 120,
  tileMaxZoom: 14,
  flyLineCount: 15
};

var CITY_CODES = {
  '武汉市': '420100', '黄石市': '420200', '鄂州市': '420700',
  '孝感市': '420900', '黄冈市': '421100', '咸宁市': '421200',
  '仙桃市': '429004', '潜江市': '429005', '天门市': '429006'
};

var sizeLabels = { large: '大型企业', medium: '中型企业', small: '小型企业' };
var scaleOrder = ['large', 'medium', 'small'];

// ============================================================
// STATE
// ============================================================
var map = null;
// Set by data.js (loaded before app.js)
var enterprisesData;
var cityStatsData;
var districtAgg = {};
var cityLookup = {};
var allMarkers = [];
var clusterMarkers = [];
var individualMarkers = [];
var pieIcons = [];
var iconCache = {};
var flyLinesRAF = null;
var flyLinesTimer = null;
var drillInCity = null;

// ============================================================
// DATA LOADING
// ============================================================
function setProgress(pct, text) {
  var bar = document.getElementById('progressBar');
  var txt = document.getElementById('loading-text');
  if (bar) bar.style.width = pct + '%';
  if (txt) txt.textContent = text || '';
}

function loadData() {
  setProgress(10, '加载企业数据...');
  // Data is defined globally by data.js included as <script> tag
  if (typeof enterprisesData === 'undefined' || !enterprisesData || enterprisesData.length === 0) {
    document.getElementById('map').innerHTML =
      '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#5a6a8a;">⚠️ 数据加载失败，请刷新重试</div>';
    return false;
  }

  // Build aggregates
  districtAgg = {};
  cityLookup = {};
  enterprisesData.forEach(function(e) {
    if (!cityLookup[e.d]) cityLookup[e.d] = e.c;
    if (!districtAgg[e.d]) districtAgg[e.d] = { count: 0, city: e.c };
    districtAgg[e.d].count++;
  });

  setProgress(20, '地图引擎准备中...');
  return true;
}

// ============================================================
// MAP INITIALIZATION
// ============================================================
function initMap() {
  if (map) return;
  map = new BMapGL.Map('map', {
    center: new BMapGL.Point(CONFIG.center[0], CONFIG.center[1]),
    zoom: CONFIG.zoom,
    enableRotate: true,
    enableTilt: true,
    minZoom: CONFIG.minZoom,
    maxZoom: CONFIG.maxZoom
  });
  map.enableScrollWheelZoom(true);

  // 3D perspective
  map.setTilt(35);
  map.setHeading(10);

  // Daytime street map style (clean light theme)
  map.setMapStyleV2({
    styleJson: [
      { featureType: 'water', elementType: 'geometry', stylers: { color: '#e8f5e9' } },
      { featureType: 'land', elementType: 'geometry', stylers: { color: '#f1f8e9' } },
      { featureType: 'green', elementType: 'geometry', stylers: { color: '#c8e6c9' } },
      { featureType: 'building', elementType: 'geometry', stylers: { color: '#ffffff' } },
      { featureType: 'highway', elementType: 'geometry', stylers: { color: '#a5d6a7' } },
      { featureType: 'arterial', elementType: 'geometry', stylers: { color: '#c8e6c9' } },
      { featureType: 'local', elementType: 'geometry', stylers: { color: '#e0e0e0' } },
      { featureType: 'label', elementType: 'labels', stylers: { color: '#1b5e20', visibility: 'on' } },
      { featureType: 'boundary', elementType: 'geometry', stylers: { color: '#4caf50', weight: 1, opacity: 0.5 } },
      { featureType: 'district', elementType: 'labels', stylers: { visibility: 'on', color: '#2e7d32', fontsize: 11 } }
    ]
  });

  var scaleCtrl = new BMapGL.ScaleControl({ anchor: BMAP_ANCHOR_BOTTOM_RIGHT, offset: new BMapGL.Size(16, 16) });
  map.addControl(scaleCtrl);
  var zoomCtrl = new BMapGL.ZoomControl({ anchor: BMAP_ANCHOR_BOTTOM_RIGHT, offset: new BMapGL.Size(16, 60) });
  map.addControl(zoomCtrl);

  // Event listeners
  map.addEventListener('zoomend', function() { rebuildClusters(); });
  map.addEventListener('moveend', function() { rebuildClusters(); });
}

// ============================================================
// GEOJSON BOUNDARIES — Area-based density classification
// ============================================================
var densityThresholds = [0, 0, 0, 0]; // q1, q2, q3, max

function computeArea(ring) {
  if (!ring || ring.length < 3) return 0;
  var area = 0;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += ring[i][0] * ring[j][1];
    area -= ring[j][0] * ring[i][1];
  }
  return Math.abs(area) / 2 * 12390;
}

function matchDistrictName(featureName, targetName) {
  var a = featureName.replace(/[市县区镇乡]/g, '');
  var b = targetName.replace(/[市县区镇乡]/g, '');
  return a === b || featureName.indexOf(targetName) !== -1 || targetName.indexOf(featureName) !== -1;
}

function simplifyCoords(ring, maxPts) {
  if (ring.length <= maxPts) return ring;
  var step = Math.max(1, Math.floor(ring.length / maxPts));
  var out = [];
  for (var i = 0; i < ring.length; i += step) out.push(ring[i]);
  if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
  return out;
}

function getOuterRing(feature) {
  var coords = feature.geometry.coordinates;
  if (feature.geometry.type === 'MultiPolygon') return coords[0][0];
  if (feature.geometry.type === 'Polygon') return coords[0];
  return null;
}

var densityColors = {
  veryHigh: '#1b5e20',
  high: '#388e3c',
  medium: '#4caf50',
  low: '#66bb6a',
  veryLow: '#a5d6a7'
};

function getDensityLevel(d) {
  if (d >= densityThresholds[2]) return { color: densityColors.veryHigh, opacity: 0.40 };
  if (d >= densityThresholds[1]) return { color: densityColors.high, opacity: 0.32 };
  if (d >= densityThresholds[0]) return { color: densityColors.medium, opacity: 0.24 };
  return { color: densityColors.low, opacity: 0.16 };
}

function loadGeoBoundaries() {
  setProgress(30, '加载行政区划边界...');
  var timedOut = false;
  var loadError = false;
  var timer = setTimeout(function() { timedOut = true; }, 20000);
  var codes = Object.values(CITY_CODES);
  var results = [];
  var BATCH = 4;

  (async function() {
    for (var i = 0; i < codes.length; i += BATCH) {
      if (timedOut) break;
      var batch = codes.slice(i, i + BATCH).map(function(code) {
        return fetch('https://geo.datav.aliyun.com/areas_v3/bound/' + code + '_full.json')
          .then(function(r) { return r.ok ? r.json() : null; })
          .then(function(data) {
            if (data) return data;
            return fetch('https://geo.datav.aliyun.com/areas_v3/bound/' + code + '.json')
              .then(function(r2) { return r2.ok ? r2.json() : null; });
          })
          .catch(function() { loadError = true; return null; });
      });
      var res = await Promise.all(batch);
      results = results.concat(res);
      if (!timedOut) {
        setProgress(30 + (i + BATCH) / codes.length * 20, '加载边界 ' + Math.min(i + BATCH, codes.length) + '/' + codes.length);
      }
    }
    clearTimeout(timer);
    if (timedOut) { console.warn('⏱ 边界加载超时，跳过区划渲染'); setProgress(60, '边界加载超时'); return; }
    if (loadError) { console.warn('⚠ 部分边界加载失败'); }

    // Parse GeoJSON features
    var geoFeatures = [];
    results.forEach(function(geojson) {
      if (!geojson || !geojson.features) return;
      geojson.features.forEach(function(feat) {
        var name = (feat.properties.name || '').replace(/\s/g, '');
        geoFeatures.push({ name: name, feature: feat, level: feat.properties.level });
      });
    });

    var entries = Object.entries(districtAgg);
    var matchedItems = [];
    var unmatchedEntries = [];

    // Phase 1: match features, compute area & density
    entries.forEach(function(item) {
      var dName = item[0], dInfo = item[1];
      var match = null;
      for (var k = 0; k < geoFeatures.length; k++) {
        if (matchDistrictName(geoFeatures[k].name, dName)) { match = geoFeatures[k]; break; }
      }
      if (match) {
        var ring = getOuterRing(match.feature);
        if (ring && ring.length >= 3) {
          ring = simplifyCoords(ring, 250);
          var area = computeArea(ring);
          var density = area > 0 ? dInfo.count / area : 0.001;
          matchedItems.push({
            name: dName, city: dInfo.city, count: dInfo.count,
            ring: ring, area: area, density: density
          });
        } else {
          unmatchedEntries.push(item);
        }
      } else {
        unmatchedEntries.push(item);
      }
    });

    // Phase 2: density quartile thresholds
    var densities = matchedItems.map(function(i) { return i.density; }).sort(function(a, b) { return a - b; });
    var n = densities.length;
    if (n >= 4) {
      densityThresholds[0] = densities[Math.floor(n * 0.25)];
      densityThresholds[1] = densities[Math.floor(n * 0.50)];
      densityThresholds[2] = densities[Math.floor(n * 0.75)];
      densityThresholds[3] = densities[n - 1];
    } else {
      densityThresholds = [0.5, 1.5, 4, 10];
    }

    // Phase 3: create BMapGL polygons with density-based colors
    var boundaryPolygons = [];
    var rendered = 0;

    matchedItems.forEach(function(item) {
      var level = getDensityLevel(item.density);
      try {
        var pts = item.ring.map(function(c) { return new BMapGL.Point(c[0], c[1]); });
        var poly = new BMapGL.Polygon(pts, {
          strokeColor: '#2e7d32', strokeWeight: 0.6, strokeOpacity: 0.2,
          fillColor: level.color, fillOpacity: level.opacity
        });
        boundaryPolygons.push(poly);
        rendered++;
    } catch(_) {}
  });

    // Add city-level fallback for unmatched districts
    unmatchedEntries.forEach(function(item) {
      var dName = item[0], dInfo = item[1];
      for (var k = 0; k < geoFeatures.length; k++) {
        var gf = geoFeatures[k];
        if (gf.level === 'city' && matchDistrictName(gf.name, dInfo.city)) {
          var ring = getOuterRing(gf.feature);
          if (ring && ring.length >= 3) {
            ring = simplifyCoords(ring, 250);
            try {
              var pts = ring.map(function(c) { return new BMapGL.Point(c[0], c[1]); });
              var level = getDensityLevel(dInfo.count / 50);
              var poly = new BMapGL.Polygon(pts, {
                strokeColor: '#2e7d32', strokeWeight: 0.6, strokeOpacity: 0.2,
                fillColor: level.color, fillOpacity: level.opacity
              });
              boundaryPolygons.push(poly);
              rendered++;
            } catch(e) {}
          }
          break;
        }
      }
    });

    setProgress(55, '渲染区划边界 ' + rendered + '/' + entries.length + '...');

    for (var p = 0; p < boundaryPolygons.length; p++) {
      if (timedOut) break;
      try { map.addOverlay(boundaryPolygons[p]); } catch(e) {}
      if (p % 5 === 4) await new Promise(function(r) { setTimeout(r, 5); });
    }

    // Update legend with dynamic density ranges
    updateLegendRanges();
    setProgress(60, '');
  })().catch(function(err) {
    console.error('❌ 边界加载异常:', err);
    setProgress(60, '边界加载失败');
  });
}

// ============================================================
// LEGEND: Update with dynamic density ranges
// ============================================================
function updateLegendRanges() {
  var t = densityThresholds;
  if (!t || t[0] === 0 && t[3] === 0) return;

  var items = document.querySelectorAll('#panelLegend .density-range');
  if (items.length === 4) {
    items[0].textContent = '≥ ' + t[2].toFixed(1) + ' 家/km²';
    items[1].textContent = '0.2 - 0.3 家/km²';
    items[2].textContent = '0.1 - 0.2 家/km²';
    items[3].textContent = '< ' + t[0].toFixed(1) + ' 家/km²';
  }
}

// ============================================================
// 5. RADIATION CIRCLES
// ============================================================
function renderCircles() {
  cityStatsData.forEach(function(c) {
    var pt = new BMapGL.Point(c.center[0], c.center[1]);
    var circle = new BMapGL.Circle(pt, 15000, {
      strokeColor: '#4caf50',
      strokeWeight: 1,
      strokeOpacity: 0.25,
      strokeStyle: 'dashed',
      fillColor: '#4caf50',
      fillOpacity: 0.03
    });
    map.addOverlay(circle);
  });
}

// ============================================================
// CITY LABELS — Show city name + enterprise count on initial view
// ============================================================
function renderCityLabels() {
  if (!map || !cityStatsData) return;
  cityStatsData.forEach(function(c) {
    try {
      var pt = new BMapGL.Point(c.center[0], c.center[1]);
      var label = new BMapGL.Label(c.name.replace('市', '') + ' · ' + c.count + '家', {
        position: pt,
        offset: new BMapGL.Size(0, 0)
      });
      label.setStyle({
        color: '#1b5e20',
        fontFamily: '"Noto Sans SC","Microsoft YaHei",sans-serif',
        fontSize: '13px',
        fontWeight: '600',
        backgroundColor: 'rgba(255,255,255,0.92)',
        border: '1px solid rgba(76,175,80,0.25)',
        borderRadius: '12px',
        padding: '4px 12px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
        whiteSpace: 'nowrap'
      });
      label.addEventListener('click', function() { drillToCity(c.name); });
      map.addOverlay(label);
    } catch(e) {}
  });
}

// ============================================================
// 3. TECH ICONS (cached)
// ============================================================
function createTechIcon(scale) {
  if (iconCache[scale]) return iconCache[scale];
  var sizes = { large: 32, medium: 24, small: 18 };
  var S = sizes[scale] || 20;
  var DPR = 2;
  var c = document.createElement('canvas');
  c.width = S * DPR; c.height = S * DPR;
  var ctx = c.getContext('2d');
  ctx.scale(DPR, DPR);
  var cx = S / 2, cy = S / 2, R = S * 0.38;

  // Outer glow
  var bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.8);
  if (scale === 'large') {
    bg.addColorStop(0, 'rgba(0, 212, 255, 0.15)');
  } else if (scale === 'medium') {
    bg.addColorStop(0, 'rgba(76, 175, 80, 0.12)');
  } else {
    bg.addColorStop(0, 'rgba(255, 143, 0, 0.10)');
  }
  bg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = bg;
  ctx.beginPath(); ctx.arc(cx, cy, R * 1.8, 0, Math.PI * 2); ctx.fill();

  // Hexagon
  ctx.beginPath();
  for (var i = 0; i < 6; i++) {
    var a = -Math.PI / 2 + i * Math.PI / 3;
    var px = cx + Math.cos(a) * R;
    var py = cy + Math.sin(a) * R;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();

  var bg2 = ctx.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
  if (scale === 'large') { bg2.addColorStop(0, 'rgba(0,212,255,0.4)'); bg2.addColorStop(1, 'rgba(0,100,200,0.6)'); }
  else if (scale === 'medium') { bg2.addColorStop(0, 'rgba(76,175,80,0.3)'); bg2.addColorStop(1, 'rgba(46,125,50,0.5)'); }
  else { bg2.addColorStop(0, 'rgba(255,143,0,0.3)'); bg2.addColorStop(1, 'rgba(230,81,0,0.5)'); }
  ctx.fillStyle = bg2;
  ctx.fill();

  ctx.strokeStyle = scale === 'large' ? 'rgba(0,212,255,0.6)' : scale === 'medium' ? 'rgba(76,175,80,0.5)' : 'rgba(255,143,0,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Inner dot
  ctx.beginPath();
  ctx.arc(cx, cy, R * 0.12, 0, Math.PI * 2);
  ctx.fillStyle = scale === 'large' ? '#00d4ff' : scale === 'medium' ? '#4caf50' : '#ff8f00';
  ctx.fill();

  var icon = new BMapGL.Icon(c.toDataURL(), new BMapGL.Size(S * DPR, S * DPR), {
    anchor: new BMapGL.Size(S * DPR / 2, S * DPR / 2),
    imageSize: new BMapGL.Size(S * DPR, S * DPR)
  });
  iconCache[scale] = icon;
  return icon;
}

// ============================================================
// MARKER CLUSTERING
// ============================================================
function clearClusters() {
  clusterMarkers.forEach(function(m) { try { map.removeOverlay(m); } catch(e) {} });
  individualMarkers.forEach(function(m) { try { map.removeOverlay(m); } catch(e) {} });
  clusterMarkers = [];
  individualMarkers = [];
}

function rebuildClusters() {
  clearClusters();
  if (!map || !enterprisesData.length) return;

  var zoom = map.getZoom();
  var pts = allMarkers.length > 0 ? allMarkers : enterprisesData;
  if (pts.length === 0) return;

  if (zoom >= CONFIG.clusterZoom) {
    showIndividualMarkers(pts);
  } else {
    showClusteredMarkers(pts, zoom);
  }
}

function showIndividualMarkers(pts) {
  pts.forEach(function(e) {
    var point = new BMapGL.Point(e.lng, e.lat);
    var icon = createTechIcon(e.s);
    var marker = new BMapGL.Marker(point, { icon: icon });
    map.addOverlay(marker);
    individualMarkers.push(marker);

    marker.addEventListener('click', function(ev) {
      var c = '<div class="info-window"><h4>' + e.n + '</h4><p><span class="size-tag">' + sizeLabels[e.s] + '</span></p><p><span class="highlight">所在城市：</span>' + e.c + '</p><p><span class="highlight">所属区县：</span>' + e.d + '</p>' + (e.t ? '<p><span class="highlight">行业类型：</span>' + e.t.split('|').pop() + '</p>' : '') + '</div>';
      map.openInfoWindow(new BMapGL.InfoWindow(c, { width: 240, title: '', enableAutoPan: true }), ev.target.getPosition());
    });
  });
}

function showClusteredMarkers(pts, zoom) {
  var gridSize = CONFIG.gridSize * (1 + (CONFIG.clusterZoom - zoom) * 0.3);
  var bounds = map.getBounds();
  if (!bounds) return;

  var sw = bounds.getSouthWest();
  var ne = bounds.getNorthEast();
  var swPx = map.pointToPixel(sw);
  var nePx = map.pointToPixel(ne);

  var gridW = Math.ceil(Math.abs(nePx.x - swPx.x) / gridSize);
  var gridH = Math.ceil(Math.abs(nePx.y - swPx.y) / gridSize);
  if (gridW < 2) gridW = 2;
  if (gridH < 2) gridH = 2;

  var cellMap = {};

  pts.forEach(function(e) {
    try {
      var px = map.pointToPixel(new BMapGL.Point(e.lng, e.lat));
      var col = Math.floor((px.x - swPx.x) / (Math.abs(nePx.x - swPx.x) / gridW));
      var row = Math.floor((px.y - swPx.y) / (Math.abs(nePx.y - swPx.y) / gridH));
      var key = col + ',' + row;
      if (!cellMap[key]) cellMap[key] = { points: [], col: col, row: row };
      cellMap[key].points.push(e);
    } catch(e) {}
  });

  Object.keys(cellMap).forEach(function(key) {
    var cell = cellMap[key];
    if (cell.points.length === 0) return;

    if (cell.points.length === 1) {
      var e = cell.points[0];
      showIndividualMarkers([e]);
      return;
    }

    // Calculate center
    var lngSum = 0, latSum = 0;
    cell.points.forEach(function(p) { lngSum += p.lng; latSum += p.lat; });
    var cx = lngSum / cell.points.length;
    var cy = latSum / cell.points.length;
    var count = cell.points.length;

    var clusterIcon = createClusterIcon(count);
    var marker = new BMapGL.Marker(new BMapGL.Point(cx, cy), { icon: clusterIcon });
    map.addOverlay(marker);
    clusterMarkers.push(marker);

    marker.addEventListener('click', function() {
      map.centerAndZoom(new BMapGL.Point(cx, cy), Math.min(zoom + 2, CONFIG.maxZoom));
    });
  });
}

function createClusterIcon(count) {
  var S = 40, DPR = 2;
  var size = Math.min(56, Math.max(32, 30 + Math.log(count) * 6));
  S = Math.round(size);
  var c = document.createElement('canvas');
  c.width = S * DPR; c.height = S * DPR;
  var ctx = c.getContext('2d');
  ctx.scale(DPR, DPR);
  var cx = S / 2, cy = S / 2, R = S * 0.4;

  ctx.shadowColor = 'rgba(0, 212, 255, 0.4)';
  ctx.shadowBlur = 12;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.closePath();
  ctx.fillStyle = 'rgba(0, 30, 60, 0.9)';
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = 'rgba(0, 212, 255, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();

  ctx.fillStyle = '#00d4ff';
  ctx.font = 'bold ' + Math.round(S * 0.3) + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(count, cx, cy);

  return new BMapGL.Icon(c.toDataURL(), new BMapGL.Size(S * DPR, S * DPR), {
    anchor: new BMapGL.Size(S * DPR / 2, S * DPR / 2),
    imageSize: new BMapGL.Size(S * DPR, S * DPR)
  });
}

// ============================================================
// ============================================================
// FLY LINES BETWEEN CITIES
// ============================================================
var flyCanvas = null;

function startFlyAnimation() {
  if (flyLinesRAF) return;
  function tick() {
    renderFlyLines();
    flyLinesRAF = requestAnimationFrame(tick);
  }
  flyLinesRAF = requestAnimationFrame(tick);
  clearTimeout(flyLinesTimer);
}

function stopFlyAnimation() {
  if (flyLinesRAF) { cancelAnimationFrame(flyLinesRAF); flyLinesRAF = null; }
  clearTimeout(flyLinesTimer);
}

function kickFlyAnimation() {
  startFlyAnimation();
  flyLinesTimer = setTimeout(stopFlyAnimation, 5000);
}

function initFlyLines() {
  var container = document.querySelector('.map-wrapper');
  var canvas = document.createElement('canvas');
  canvas.id = 'fly-canvas';
  canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:4;opacity:0.3;transition:opacity 0.5s;';
  container.appendChild(canvas);
  flyCanvas = canvas;
  kickFlyAnimation();

  map.addEventListener('moveend', kickFlyAnimation);
  map.addEventListener('zoomend', kickFlyAnimation);
  map.addEventListener('moving', kickFlyAnimation);
  window.addEventListener('resize', kickFlyAnimation);
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) { stopFlyAnimation(); }
    else { kickFlyAnimation(); }
  });
}

function renderFlyLines() {
  if (!flyCanvas || !map) return;
  var canvas = flyCanvas;
  var container = canvas.parentElement;
  var rect = container.getBoundingClientRect();
  var W = rect.width, H = rect.height;
  var dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // Connect city centers with arcs
  var center = cityStatsData.filter(function(c) { return c.center; });
  var focal = cityStatsData.find(function(c) { return c.name === '武汉市'; }) || cityStatsData[0];

  center.forEach(function(c) {
    if (c.name === '武汉市') return;
    try {
      var p1 = map.pointToPixel(new BMapGL.Point(focal.center[0], focal.center[1]));
      var p2 = map.pointToPixel(new BMapGL.Point(c.center[0], c.center[1]));
      if (p1.x < 0 || p1.y < 0 || p2.x < 0 || p2.y < 0) return;
      if (p1.x > W * 2 || p1.y > H * 2 || p2.x > W * 2 || p2.y > H * 2) return;

      var dx = p2.x - p1.x, dy = p2.y - p1.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      var arcHeight = Math.max(20, dist * 0.15);
      var cx = (p1.x + p2.x) / 2;
      var cy = (p1.y + p2.y) / 2 - arcHeight;

      ctx.beginPath();
      ctx.moveTo(p1.x, p1.y);
      ctx.quadraticCurveTo(cx, cy, p2.x, p2.y);
      ctx.strokeStyle = 'rgba(0, 212, 255, 0.12)';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Glow
      ctx.shadowColor = 'rgba(0, 212, 255, 0.15)';
      ctx.shadowBlur = 8;

      // Animated dot along arc - draw at a fixed phase
      var phase = (Date.now() % 3000) / 3000;
      var t = (phase * 2) % 1;
      var dotX = (1 - t) * (1 - t) * p1.x + 2 * (1 - t) * t * cx + t * t * p2.x;
      var dotY = (1 - t) * (1 - t) * p1.y + 2 * (1 - t) * t * cy + t * t * p2.y;

      ctx.beginPath();
      ctx.arc(dotX, dotY, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#00d4ff';
      ctx.shadowBlur = 15;
      ctx.fill();
      ctx.shadowBlur = 0;
    } catch(e) {}
  });

}

// ============================================================
// 2. PIE CHARTS (city center charts)
// ============================================================
function renderPieCharts() {
  var pieColors = {
    large: 'rgba(0, 212, 255, 0.7)',
    medium: 'rgba(76, 175, 80, 0.7)',
    small: 'rgba(255, 143, 0, 0.7)',
    micro: 'rgba(90, 106, 138, 0.4)'
  };

  cityStatsData.forEach(function(city) {
    if (city.count === 0) return;
    var lng = city.center[0], lat = city.center[1];
    var S = 42, DPR = 2;
    var c = document.createElement('canvas');
    c.width = S * DPR; c.height = S * DPR;
    var ctx = c.getContext('2d');
    ctx.scale(DPR, DPR);
    var cx = S / 2, cy = S / 2, R = S * 0.36;

    ctx.fillStyle = 'rgba(0, 212, 255, 0.04)';
    ctx.beginPath(); ctx.arc(cx, cy, R + 6, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = 'rgba(6, 30, 65, 0.85)';
    ctx.beginPath(); ctx.arc(cx, cy, R + 2, 0, Math.PI * 2); ctx.fill();

    var total = city.count;
    var startAngle = -Math.PI / 2;
    scaleOrder.forEach(function(lv) {
      var val = city[lv] || 0;
      if (val === 0) return;
      var sliceAngle = (val / total) * Math.PI * 2;
      ctx.fillStyle = pieColors[lv];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, startAngle, startAngle + sliceAngle);
      ctx.closePath();
      ctx.fill();
      startAngle += sliceAngle;
    });

    ctx.fillStyle = 'rgba(6, 30, 65, 0.95)';
    ctx.beginPath(); ctx.arc(cx, cy, R * 0.22, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = '#00d4ff';
    ctx.font = 'bold 10px "Noto Sans SC",sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(city.count, cx, cy);

    ctx.fillStyle = '#5a7a9a';
    ctx.font = '7px "Noto Sans SC",sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(city.name.replace('市', ''), cx, cy + R + 7);

    var icon = new BMapGL.Icon(c.toDataURL(), new BMapGL.Size(S * DPR, S * DPR), {
      anchor: new BMapGL.Size(S * DPR / 2, S * DPR / 2),
      imageSize: new BMapGL.Size(S * DPR, S * DPR)
    });
    var pieMarker = new BMapGL.Marker(new BMapGL.Point(lng, lat), { icon: icon });
    map.addOverlay(pieMarker);
    pieIcons.push(pieMarker);

    // Drill-down click
    pieMarker.addEventListener('click', function() {
      drillToCity(city.name);
    });
  });
}

// ============================================================
// DRILL-DOWN
// ============================================================
function drillToCity(cityName) {
  drillInCity = cityName;
  var city = cityStatsData.find(function(c) { return c.name === cityName; });
  if (!city) return;

  // Zoom to city extent
  map.centerAndZoom(new BMapGL.Point(city.center[0], city.center[1]), 10);

  // Show breadcrumb
  var bc = document.getElementById('breadcrumb');
  bc.innerHTML = '<button class="crumb" onclick="drillUp()">武汉都市圈</button>' +
    '<span class="sep">›</span>' +
    '<span class="crumb current">' + cityName + '</span>';
  bc.classList.add('show');

  // Show drill detail panel
  var panel = document.getElementById('drillDetail');
  var districts = {};
  enterprisesData.forEach(function(e) {
    if (e.c !== cityName) return;
    if (!districts[e.d]) districts[e.d] = { count: 0, large: 0, medium: 0, small: 0 };
    districts[e.d].count++;
    districts[e.d][e.s] = (districts[e.d][e.s] || 0) + 1;
  });

  var sorted = Object.entries(districts).sort(function(a, b) { return b[1].count - a[1].count; });
  var html = '<button class="close-btn" onclick="closeDrill()">✕</button>';
  html += '<h4>' + cityName + ' · 区县分布</h4>';
  html += '<div class="row"><span class="l">区县</span><span class="r">总数 | 大 | 中 | 小</span></div>';
  sorted.forEach(function(item) {
    var d = item[1];
    html += '<div class="row"><span class="l">' + item[0] + '</span><span class="r">' +
      d.count + ' | ' + (d.large || 0) + ' | ' + (d.medium || 0) + ' | ' + (d.small || 0) + '</span></div>';
  });
  panel.innerHTML = html;
  panel.classList.add('show');

  // Highlight city boundaries
  filterByCity(cityName);
}

function drillUp() {
  closeDrill();
  map.centerAndZoom(new BMapGL.Point(CONFIG.center[0], CONFIG.center[1]), CONFIG.zoom);
  document.getElementById('filterCity').value = 'all';
  applyFilters();
}

function closeDrill() {
  drillInCity = null;
  document.getElementById('breadcrumb').classList.remove('show');
  document.getElementById('drillDetail').classList.remove('show');
  document.getElementById('filterCity').value = 'all';
  applyFilters();
}

function filterByCity(cityName) {
  document.getElementById('filterCity').value = cityName;
  applyFilters();
}

// ============================================================
// ============================================================
// FILTERS
// ============================================================
function applyFilters() {

  var city = document.getElementById('filterCity').value;
  var scale = document.getElementById('filterScale').value;
  var industry = document.getElementById('filterIndustry').value;

  allMarkers = enterprisesData.filter(function(e) {
    if (city !== 'all' && e.c !== city) return false;
    if (scale !== 'all' && e.s !== scale) return false;
    if (industry !== 'all' && e.t.indexOf(industry) !== 0) return false;
    return true;
  });

  updateStats(allMarkers.length);
  clearClusters();
  rebuildClusters();
}

function updateStats(count) {
  document.getElementById('totalCount').textContent = count || enterprisesData.length;
}

// Build industry dropdown
function buildIndustryFilter() {
  var select = document.getElementById('filterIndustry');
  select.innerHTML = '<option value="all">全部行业</option>';

  var parents = {};
  enterprisesData.forEach(function(e) {
    var p = e.t.split('|')[0];
    if (!parents[p]) parents[p] = { subtypes: {}, count: 0 };
    parents[p].count++;
    if (e.t.indexOf('|') !== -1) {
      parents[p].subtypes[e.t] = (parents[p].subtypes[e.t] || 0) + 1;
    }
  });

  var labelMap = {
    '公司': '企业综合服务', '工厂': '生产制造', '机械电子': '机械电子',
    '医药公司': '医药生物', '冶金化工': '冶金化工', '广告装饰': '广告装饰',
    '建筑公司': '建筑工程', '网络科技': '网络科技', '商业贸易': '商业贸易',
    '电信公司': '信息通信', '矿产公司': '矿产能源', '其它农林牧渔基地': '农林牧渔'
  };

  var sorted = Object.keys(parents).sort(function(a, b) { return parents[b].count - parents[a].count; });
  sorted.forEach(function(p) {
    var label = labelMap[p] || p;
    var main = document.createElement('option');
    main.value = p;
    main.textContent = label + '（' + parents[p].count + '）';
    select.appendChild(main);

    var subKeys = Object.keys(parents[p].subtypes).sort(function(a, b) {
      return parents[p].subtypes[b] - parents[p].subtypes[a];
    });
    subKeys.forEach(function(sk) {
      var sub = document.createElement('option');
      sub.value = sk;
      sub.textContent = '　└ ' + sk.split('|')[1] + '（' + parents[p].subtypes[sk] + '）';
      sub.style.fontSize = '11px';
      select.appendChild(sub);
    });
  });
}

// Build city dropdown dynamically
function buildCityFilter() {
  var select = document.getElementById('filterCity');
  select.innerHTML = '<option value="all">全部城市</option>';
  var cities = {};
  enterprisesData.forEach(function(e) { cities[e.c] = (cities[e.c] || 0) + 1; });
  var sorted = Object.keys(cities).sort(function(a, b) { return cities[b] - cities[a]; });
  sorted.forEach(function(c) {
    var opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c + '（' + cities[c] + '）';
    select.appendChild(opt);
  });
}

// ============================================================
// 4. BAR CHART
// ============================================================
function drawBarChart() {
  var canvas = document.getElementById('chart-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var dpr = window.devicePixelRatio || 1;
  var rect = canvas.parentElement.getBoundingClientRect();
  var W = rect.width - 32;
  var H = 140;
  if (W < 50) return;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  var cities = cityStatsData.slice().sort(function(a, b) { return b.count - a.count; });
  var pad = { top: 6, right: 10, bottom: 34, left: 32 };
  var chartW = W - pad.left - pad.right;
  var chartH = H - pad.top - pad.bottom;
  var barGap = 4;
  var barW = Math.min(20, (chartW - barGap * (cities.length - 1)) / cities.length);
  var maxVal = Math.max.apply(null, cities.map(function(c) { return c.count; })) * 1.15;

  function drawBg() {
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(76, 175, 80, 0.10)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(pad.left, pad.top);
    ctx.lineTo(pad.left, pad.top + chartH);
    ctx.lineTo(pad.left + chartW, pad.top + chartH);
    ctx.stroke();

    ctx.fillStyle = '#8daa8d';
    ctx.font = '9px "Noto Sans SC",sans-serif';
    ctx.textAlign = 'right';
    var ySteps = Math.ceil(maxVal / 4);
    for (var i = 0; i <= 4; i++) {
      var val = Math.round(ySteps * i);
      var y = pad.top + chartH - (val / maxVal) * chartH;
      ctx.fillText(val, pad.left - 4, y + 2);
    }
  }

  function drawBars(progress) {
    drawBg();
    cities.forEach(function(city, idx) {
      var x = pad.left + idx * (barW + barGap) + barGap / 2;
      var targetBarH = (city.count / maxVal) * chartH;
      var barH = targetBarH * progress;
      var y = pad.top + chartH - barH;

      var grad = ctx.createLinearGradient(x, y, x, pad.top + chartH);
      grad.addColorStop(0, '#a5d6a7');
      grad.addColorStop(0.5, '#81c784');
      grad.addColorStop(1, 'rgba(129, 199, 132, 0.3)');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barW, barH);

      ctx.shadowColor = 'rgba(129, 199, 132, 0.25)';
      ctx.shadowBlur = 4;
      ctx.strokeStyle = 'rgba(129, 199, 132, 0.25)';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, barW, barH);
      ctx.shadowBlur = 0;

      if (progress >= 0.95) {
        ctx.fillStyle = '#1b5e20';
        ctx.font = 'bold 11px "Noto Sans SC",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(city.count, x + barW / 2, y - 3);
      }

      ctx.fillStyle = '#558b2f';
      ctx.font = '8px "Noto Sans SC",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(city.name.replace('市', ''), x + barW / 2, pad.top + chartH + 12);
    });
  }

  drawBg();
  if (typeof gsap !== 'undefined') {
    gsap.to({ p: 0 }, {
      p: 1, duration: 1.0, delay: 0.3, ease: 'power2.out',
      onUpdate: function() { drawBars(this.targets()[0].p); }
    });
  } else {
    drawBars(1);
  }
}

// ============================================================
// GSAP ENTRANCE ANIMATIONS
// ============================================================
function runEntranceAnim() {
  if (typeof gsap === 'undefined') return;
  var tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
  tl.from('#header', { y: -30, opacity: 0, duration: 0.4 })
    .from('#filterBar', { y: -20, opacity: 0, duration: 0.3 }, '-=0.15')
    .from('#mapTitle', { y: -15, opacity: 0, duration: 0.3 }, '-=0.15')
    .to('#mapTitle', { y: 0, opacity: 1, duration: 0.2 }, '-=0.1')
    .from('#sidebar', { x: 50, opacity: 0, duration: 0.4 }, '-=0.15')
    .to('#sidebar', { opacity: 1, duration: 0.1 }, '-=0.1');

  // Number animation
  var districts = [...new Set(enterprisesData.map(function(e) { return e.d; }))];
  gsap.to({ val: 0 }, {
    val: enterprisesData.length, duration: 1.0, ease: 'power2.out',
    onUpdate: function() {
      document.getElementById('totalCount').textContent = Math.round(this.targets()[0].val);
    }
  });
  gsap.to({ val: 0 }, {
    val: districts.length, duration: 0.8, ease: 'power2.out', delay: 0.3,
    onUpdate: function() {
      document.getElementById('districtCount').textContent = Math.round(this.targets()[0].val);
    }
  });
}

// ============================================================
// SVG LINE ANIMATION
// ============================================================
function animateSVGLines() {
  if (typeof gsap === 'undefined') return;
  var paths = document.querySelectorAll('#svg-decor path');
  paths.forEach(function(path, i) {
    var len = path.getTotalLength() || 2000;
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    gsap.to(path, {
      strokeDashoffset: -len, duration: 4 + i * 2, repeat: -1, ease: 'none'
    });
  });
}

// ============================================================
// EVENT BINDING
// ============================================================
function bindEvents() {
  document.getElementById('filterCity').addEventListener('change', applyFilters);
  document.getElementById('filterScale').addEventListener('change', applyFilters);
  document.getElementById('filterIndustry').addEventListener('change', applyFilters);

  document.getElementById('resetFilter').addEventListener('click', function() {
    document.getElementById('filterCity').value = 'all';
    document.getElementById('filterScale').value = 'all';
    document.getElementById('filterIndustry').value = 'all';
    applyFilters();
  });
}

// ============================================================
// MAIN INIT SEQUENCE
// ============================================================
async function main() {
  // 1. Load data
  var dataOk = loadData();
  if (!dataOk) return;

  setProgress(25, '构建筛选选项...');
  buildCityFilter();
  buildIndustryFilter();
  bindEvents();

  // 2. Wait for Baidu Map
  if (typeof BMapGL === 'undefined') {
    setProgress(25, '等待百度地图引擎...');
    await new Promise(function(resolve) {
      var check = setInterval(function() {
        if (typeof BMapGL !== 'undefined') { clearInterval(check); resolve(); }
      }, 200);
      setTimeout(resolve, 15000); // 15s fallback
    });
  }

  setProgress(35, '初始化地图...');
  try { initMap(); } catch(e) { map = null; }

  if (!map) {
    document.getElementById('map').innerHTML =
      '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:#5a6a8a;font-size:14px;"><span>⚠️ 地图引擎加载失败</span><span style="font-size:11px;margin-top:6px;">请检查网络连接后刷新</span></div>';
    return;
  }

  // 3. Load GeoJSON boundaries (non-blocking, background)
  loadGeoBoundaries();

  // 4. Render circles
  renderCircles();

  // 5. Render city labels
  renderCityLabels();

  // 6. Render pie charts
  renderPieCharts();

  // 6. Init fly lines
  initFlyLines();

  // 7. Set viewport
  setProgress(70, '调整视图...');
  var allPts = [];
  enterprisesData.forEach(function(e) {
    if (e.lng && e.lat && e.lng > 110 && e.lng < 120 && e.lat > 28 && e.lat < 32) {
      allPts.push(new BMapGL.Point(e.lng, e.lat));
    }
  });
  if (allPts.length > 0) {
    try { map.setViewport(allPts, { margins: [60, 360, 60, 60] }); }
    catch(e) { map.centerAndZoom(new BMapGL.Point(114.0, 30.5), CONFIG.zoom); }
  }

  // 9. Initial rendering
  setProgress(80, '渲染企业标记...');
  allMarkers = enterprisesData.slice();
  rebuildClusters();

  // 10. Draw chart
  setProgress(85, '绘制统计图表...');
  drawBarChart();

  // 11. Animations
  setProgress(90, '启动动画...');
  runEntranceAnim();
  animateSVGLines();

  // 12. Done
  setProgress(100, '加载完成');
  setTimeout(function() {
    document.getElementById('loading-overlay').classList.add('hide');
  }, 500);

  console.log('✅ 武汉都市圈科技企业分布图初始化完成');
  console.log('   企业数量：' + enterprisesData.length);
  console.log('   城市数量：' + cityStatsData.length);
}

// ============================================================
// START
// ============================================================
main().catch(function(err) {
  console.error('❌ 初始化失败:', err);
  setProgress(100, '加载失败');
  document.getElementById('loading-text').textContent = '⚠️ 加载失败，请刷新重试';
});

// Expose functions globally
window.drillToCity = drillToCity;
window.drillUp = drillUp;
window.closeDrill = closeDrill;
