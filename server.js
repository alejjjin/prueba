const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const app = express();

app.use(cors());
app.use(express.json());

// Load STM data (controles + horarios)
let STM_DATA = null;
try {
  STM_DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'stm_data.json'), 'utf8'));
  console.log('STM data loaded OK');
} catch(e) {
  console.log('STM data not found:', e.message);
}

// Salidas teóricas correctas (origen real + horarios de salida por variante),
// generadas con generar_salidas.py desde el dato abierto oficial de la STM.
let SALIDAS = null;
try {
  SALIDAS = JSON.parse(fs.readFileSync(path.join(__dirname, 'stm_salidas.json'), 'utf8'));
  console.log('Salidas teóricas cargadas OK (' + Object.keys(SALIDAS).length + ' líneas)');
} catch(e) {
  console.log('stm_salidas.json no encontrado (uso fallback):', e.message);
}

// Registro en memoria de salidas reales detectadas.
// key: "linea|codigoBus" -> { realTs, realSeg, teoricaSeg }
const departures = {};

// Override opcional de cuál es el "primer punto de control" (cabecera) por línea.
// La lista controles[linea] viene ordenada por código, NO por orden de recorrido,
// así que si querés fijar la cabecera real de una línea, poné aquí su código de control.
// Ej: ORIGEN_CONTROL['G'] = '5854';
const ORIGEN_CONTROL = {
  // 'linea': 'codControl',
};

// Haversine distance in meters
function distM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dlat = (lat2-lat1)*Math.PI/180;
  const dlon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dlat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dlon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Calculate delay for a bus
function calcDelay(linea, busLat, busLon) {
  if (!STM_DATA) return null;
  const ctrls = STM_DATA.controles[linea];
  if (!ctrls || !ctrls.length) return null;

  // Find nearest control point
  let nearest = null, minDist = Infinity;
  for (const c of ctrls) {
    const d = distM(busLat, busLon, c.la, c.lo);
    if (d < minDist) { minDist = d; nearest = c; }
  }
  if (minDist > 500) return null; // solo si está a menos de 500m del punto de control

  // Get current time in Uruguay (UTC-3)
  const now = new Date();
  const nowSeg = ((now.getUTCHours() - 3 + 24) % 24) * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const wd = new Date(now.getTime() - 3*3600*1000).getUTCDay(); // 0=sun,6=sat
  const day = (wd === 0) ? '2' : (wd === 6) ? '1' : '0';

  const lineaHor = STM_DATA.horarios[linea];
  if (!lineaHor) return null;
  const dayHor = lineaHor[day];
  if (!dayHor) return null;
  const horas = dayHor[nearest.c];
  if (!horas || !horas.length) return null;

  // Solo considerar horarios dentro de ±30 minutos de la hora actual
  const VENTANA = 30 * 60; // 30 minutos en segundos
  const horasFiltradas = horas.filter(h => Math.abs(h - nowSeg) <= VENTANA);
  if (!horasFiltradas.length) return null; // ningún servicio en la ventana de tiempo

  // Find closest scheduled time within window
  let closest = horasFiltradas[0], minDiff = Infinity;
  for (const h of horasFiltradas) {
    const diff = Math.abs(h - nowSeg);
    if (diff < minDiff) { minDiff = diff; closest = h; }
  }

  const atrasoSeg = nowSeg - closest;
  const hh = Math.floor(closest/3600).toString().padStart(2,'0');
  const mm = Math.floor((closest%3600)/60).toString().padStart(2,'0');

  return {
    atraso_seg: atrasoSeg,
    atraso_min: Math.round(atrasoSeg/60*10)/10,
    control: nearest.d,
    dist_m: Math.round(minDist),
    hora_teorica: `${hh}:${mm}`
  };
}

// Classify bus
function classifyBus(feature) {
  const p = feature.properties;
  const fr = p.frecuencia;
  const coords = feature.geometry ? feature.geometry.coordinates : null;

  // No GPS
  if (!fr || fr > 300000) return { cat: 'ng', atraso_min: null, control: null, hora_teorica: null };

  // Try to calculate real delay
  if (coords && p.linea && STM_DATA) {
    const delay = calcDelay(String(p.linea), coords[1], coords[0]);
    if (delay !== null) {
      const a = delay.atraso_min;
      let cat;
      if (Math.abs(a) <= 2) cat = 'ok';
      else if (a > 2) cat = 'late';
      else cat = 'early';
      return { cat, atraso_min: a, control: delay.control, hora_teorica: delay.hora_teorica, dist_m: delay.dist_m };
    }
  }

  // Fallback to frecuencia
  if (fr > 2*60*1000) return { cat: 'bad', atraso_min: null, control: null, hora_teorica: null };
  return { cat: 'ok', atraso_min: null, control: null, hora_teorica: null };
}

// ---- Salida real / teórica (pasada por el primer punto de control) ----

const TERMINAL_RADIUS = 250;      // m: cuán cerca del primer control para contar "pasada"
const DEP_MATCH_WINDOW = 45 * 60; // s: ventana para emparejar con un horario teórico
const TRIP_GAP = 25 * 60;         // s: separación mínima para considerar un viaje nuevo
const DEP_TTL = 6 * 3600 * 1000;  // ms: limpiar salidas más viejas que esto

// Primer punto de control (cabecera) de la línea
function firstControl(linea) {
  const arr = STM_DATA && STM_DATA.controles[linea];
  if (!arr || !arr.length) return null;
  const cod = ORIGEN_CONTROL[linea];
  if (cod) {
    const found = arr.find(c => String(c.c) === String(cod));
    if (found) return found;
  }
  return arr[0];
}

// Horario teórico de pasada por ese control más cercano a la hora actual (dentro de la ventana)
function closestTheoreticalDeparture(linea, day, cod, nowSeg, windowSeg) {
  const lh = STM_DATA.horarios[linea];
  if (!lh) return null;
  const dh = lh[day];
  if (!dh) return null;
  const horas = dh[cod];
  if (!horas || !horas.length) return null;
  let best = null, bestDiff = Infinity;
  for (const h of horas) {
    let diff = Math.abs(h - nowSeg);
    if (diff > 12 * 3600) diff = 24 * 3600 - diff; // wrap de medianoche
    if (diff < bestDiff) { bestDiff = diff; best = h; }
  }
  if (windowSeg != null && bestDiff > windowSeg) return null;
  return best;
}

function fmtSegHM(seg) {
  const s = ((seg % 86400) + 86400) % 86400;
  const hh = Math.floor(s / 3600).toString().padStart(2, '0');
  const mm = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  return `${hh}:${mm}`;
}
function fmtSegHMS(seg) {
  const s = ((seg % 86400) + 86400) % 86400;
  const hh = Math.floor(s / 3600).toString().padStart(2, '0');
  const mm = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
  const ss = Math.floor(s % 60).toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// Origen de salida (de SALIDAS) más cercano al bus, dentro del radio.
// Devuelve { c, d, la, lo, horarios } o null.
function salidaOrigen(linea, lat, lon) {
  const arr = SALIDAS && SALIDAS[linea];
  if (!arr || !arr.length) return null;
  let best = null, bd = Infinity;
  for (const o of arr) {
    const dd = distM(lat, lon, o.la, o.lo);
    if (dd < bd) { bd = dd; best = o; }
  }
  if (best && bd <= TERMINAL_RADIUS) return best;
  return null;
}

// Horario de salida teórico más cercano a la hora actual, dentro de la ventana.
function closestFromList(horas, nowSeg, windowSeg) {
  if (!horas || !horas.length) return null;
  let best = null, bestDiff = Infinity;
  for (const h of horas) {
    let diff = Math.abs(h - nowSeg);
    if (diff > 12 * 3600) diff = 24 * 3600 - diff;
    if (diff < bestDiff) { bestDiff = diff; best = h; }
  }
  if (windowSeg != null && bestDiff > windowSeg) return null;
  return best;
}

// Detecta la pasada por el primer punto de control y guarda la salida real.
// Luego adjunta _salida_real / _salida_teorica / _salida_atraso_min al feature,
// que se mantienen durante todo el viaje (aunque el bus ya no esté en la cabecera).
function recordDeparture(feature) {
  const p = feature.properties;
  if (!STM_DATA || p.linea == null) return;
  const coords = feature.geometry ? feature.geometry.coordinates : null;
  if (!coords) return;

  const linea = String(p.linea);

  const now = new Date();
  const nowTs = now.getTime();
  const nowSeg = ((now.getUTCHours() - 3 + 24) % 24) * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds();
  const wd = new Date(nowTs - 3 * 3600 * 1000).getUTCDay();
  const day = (wd === 0) ? '2' : (wd === 6) ? '1' : '0';

  const key = linea + '|' + (p.codigoBus != null ? p.codigoBus : '?');
  let rec = departures[key];

  // Origen y distancia: primero con SALIDAS (correcto), si no con el fallback viejo.
  let origenLa = null, origenLo = null, horasSalida = null;
  const orig = salidaOrigen(linea, coords[1], coords[0]);
  if (orig) {
    origenLa = orig.la; origenLo = orig.lo;
    horasSalida = (orig.horarios && orig.horarios[day]) ? orig.horarios[day] : null;
  } else {
    const fc = firstControl(linea); // respaldo
    if (!fc) return;
    origenLa = fc.la; origenLo = fc.lo;
    const lh = STM_DATA.horarios[linea];
    horasSalida = (lh && lh[day]) ? lh[day][fc.c] : null;
  }

  const d = distM(coords[1], coords[0], origenLa, origenLo);
  if (d <= TERMINAL_RADIUS) {
    const teoricaSeg = closestFromList(horasSalida, nowSeg, DEP_MATCH_WINDOW);
    const isNewTrip = !rec
      || (teoricaSeg != null && rec.teoricaSeg != null && Math.abs(teoricaSeg - rec.teoricaSeg) > 10 * 60)
      || (nowTs - rec.realTs > TRIP_GAP * 1000);
    if (isNewTrip) {
      rec = departures[key] = {
        realTs: nowTs,
        realSeg: nowSeg,
        teoricaSeg: (teoricaSeg != null ? teoricaSeg : null)
      };
    }
  }

  if (rec) {
    p._salida_real = fmtSegHMS(rec.realSeg);
    p._salida_teorica = (rec.teoricaSeg != null) ? fmtSegHM(rec.teoricaSeg) : null;
    if (rec.teoricaSeg != null) {
      let diff = rec.realSeg - rec.teoricaSeg;
      if (diff > 12 * 3600) diff -= 24 * 3600;
      if (diff < -12 * 3600) diff += 24 * 3600;
      p._salida_atraso_min = Math.round(diff / 60 * 10) / 10;
    } else {
      p._salida_atraso_min = null;
    }
  } else {
    p._salida_real = null;
    p._salida_teorica = null;
    p._salida_atraso_min = null;
  }
}

function pruneDepartures() {
  const cutoff = Date.now() - DEP_TTL;
  for (const k in departures) {
    if (departures[k].realTs < cutoff) delete departures[k];
  }
}

// Consulta a la STM y enriquece los buses (atraso + salida real/teórica).
// Esto alimenta el registro 'departures', se llame desde un cliente o desde el poll interno.
async function fetchAndEnrich(body) {
  const r = await fetch('https://www.montevideo.gub.uy/buses/rest/stm-online', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  if (!r.ok) throw new Error(`STM API responded with HTTP ${r.status}`);
  const data = await r.json();

  if (data.features) {
    for (const f of data.features) {
      const info = classifyBus(f);
      f.properties._cat = info.cat;
      f.properties._atraso_min = info.atraso_min;
      f.properties._control = info.control;
      f.properties._hora_teorica = info.hora_teorica;
      f.properties._dist_m = info.dist_m;
      recordDeparture(f);
    }
    pruneDepartures();
  }
  return data;
}

// Main API endpoint
app.post('/api/buses', async (req, res) => {
  try {
    const data = await fetchAndEnrich(req.body);
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- Polling autónomo del servidor ----
// El servidor consulta solo la API cada POLL_MS y alimenta 'departures', sin depender
// de que un cliente tenga el auto-refresh activo. Así, cuando un usuario con el
// actualizar en OFF aprete actualizar, recibe todas las salidas ya acumuladas.
// Configurable por variable de entorno; POLL_MS=0 lo desactiva.
const POLL_MS = parseInt(process.env.POLL_MS || '10000', 10);
if (POLL_MS > 0) {
  let polling = false;
  setInterval(async () => {
    if (polling) return; // evita solapamiento si una consulta tarda
    polling = true;
    try {
      await fetchAndEnrich({});
    } catch(e) {
      console.log('poll error:', e.message);
    } finally {
      polling = false;
    }
  }, POLL_MS);
  console.log('Polling autónomo cada ' + POLL_MS + ' ms');
}

// Serve the same frontend used by GitHub Pages when opening the Render service directly
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'reporte-buses-stm.html')));
app.get('/reporte-buses-stm.html', (req, res) => res.sendFile(path.join(__dirname, 'reporte-buses-stm.html')));

// Health check endpoint to prevent sleeping
app.get('/health', (req, res) => res.json({status: 'ok', time: new Date().toISOString()}));

app.listen(process.env.PORT || 3001, () => console.log('STM server running'));
