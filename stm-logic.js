/**
 * stm-logic.js
 * Lógica de cálculo de atraso STM — corre en el browser.
 * Portado desde server.js. No tiene dependencias externas.
 *
 * Uso:
 *   1. Incluir este archivo en el HTML: <script src="stm-logic.js"></script>
 *   2. Llamar STMLogic.init(stmData) con el contenido de stm_data.json
 *   3. Llamar STMLogic.fetchBuses() para obtener los datos de la API de STM
 *      ya enriquecidos con _cat, _atraso_min, _control, _hora_teorica, _dist_m
 */

const STMLogic = (function () {

  // stm_data.json cargado via STMLogic.init()
  let STM_DATA = null;

  /**
   * Carga los datos de controles y horarios.
   * @param {Object} data - Contenido de stm_data.json
   */
  function init(data) {
    STM_DATA = data;
    console.log('[STMLogic] Datos cargados OK —', Object.keys(data.controles || {}).length, 'líneas con controles');
  }

  /**
   * Distancia en metros entre dos coordenadas (Haversine).
   */
  function distM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dlat = (lat2 - lat1) * Math.PI / 180;
    const dlon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dlat / 2) ** 2
      + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dlon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * Calcula el atraso de un bus respecto a su horario teórico.
   * @returns {Object|null} { atraso_seg, atraso_min, control, dist_m, hora_teorica } o null
   */
  function calcDelay(linea, busLat, busLon) {
    if (!STM_DATA) return null;
    const ctrls = STM_DATA.controles[linea];
    if (!ctrls || !ctrls.length) return null;

    // Punto de control más cercano
    let nearest = null, minDist = Infinity;
    for (const c of ctrls) {
      const d = distM(busLat, busLon, c.la, c.lo);
      if (d < minDist) { minDist = d; nearest = c; }
    }
    if (minDist > 500) return null; // solo si está a menos de 500m

    // Hora actual en Uruguay (UTC-3)
    const now = new Date();
    const nowSeg = ((now.getUTCHours() - 3 + 24) % 24) * 3600
      + now.getUTCMinutes() * 60 + now.getUTCSeconds();
    const wd = new Date(now.getTime() - 3 * 3600 * 1000).getUTCDay(); // 0=dom, 6=sab
    const day = (wd === 0) ? '2' : (wd === 6) ? '1' : '0';

    const lineaHor = STM_DATA.horarios[linea];
    if (!lineaHor) return null;
    const dayHor = lineaHor[day];
    if (!dayHor) return null;
    const horas = dayHor[nearest.c];
    if (!horas || !horas.length) return null;

    // Solo horarios dentro de ±30 minutos de la hora actual
    const VENTANA = 30 * 60;
    const horasFiltradas = horas.filter(h => Math.abs(h - nowSeg) <= VENTANA);
    if (!horasFiltradas.length) return null;

    // Horario más cercano dentro de la ventana
    let closest = horasFiltradas[0], minDiff = Infinity;
    for (const h of horasFiltradas) {
      const diff = Math.abs(h - nowSeg);
      if (diff < minDiff) { minDiff = diff; closest = h; }
    }

    const atrasoSeg = nowSeg - closest;
    const hh = Math.floor(closest / 3600).toString().padStart(2, '0');
    const mm = Math.floor((closest % 3600) / 60).toString().padStart(2, '0');

    return {
      atraso_seg: atrasoSeg,
      atraso_min: Math.round(atrasoSeg / 60 * 10) / 10,
      control: nearest.d,
      dist_m: Math.round(minDist),
      hora_teorica: `${hh}:${mm}`
    };
  }

  /**
   * Clasifica un bus y le agrega la info de atraso.
   * @returns {Object} { cat, atraso_min, control, hora_teorica, dist_m }
   */
  function classifyBus(feature) {
    const p = feature.properties;
    const fr = p.frecuencia;
    const coords = feature.geometry ? feature.geometry.coordinates : null;

    // Sin GPS
    if (!fr || fr > 300000) {
      return { cat: 'ng', atraso_min: null, control: null, hora_teorica: null, dist_m: null };
    }

    // Intenta calcular atraso real si hay datos cargados
    if (coords && p.linea && STM_DATA) {
      const delay = calcDelay(String(p.linea), coords[1], coords[0]);
      if (delay !== null) {
        const a = delay.atraso_min;
        const cat = Math.abs(a) <= 2 ? 'ok' : a > 2 ? 'late' : 'early';
        return {
          cat,
          atraso_min: a,
          control: delay.control,
          hora_teorica: delay.hora_teorica,
          dist_m: delay.dist_m
        };
      }
    }

    // Fallback: clasificación por frecuencia
    if (fr > 2 * 60 * 1000) {
      return { cat: 'bad', atraso_min: null, control: null, hora_teorica: null, dist_m: null };
    }
    return { cat: 'ok', atraso_min: null, control: null, hora_teorica: null, dist_m: null };
  }

  /**
   * Enriquece un array de features GeoJSON con la info de atraso.
   * Modifica las features in-place y devuelve el array.
   */
  function enrichFeatures(features) {
    for (const f of features) {
      const info = classifyBus(f);
      f.properties._cat      = info.cat;
      f.properties._atraso_min = info.atraso_min;
      f.properties._control  = info.control;
      f.properties._hora_teorica = info.hora_teorica;
      f.properties._dist_m   = info.dist_m;
    }
    return features;
  }

  /**
   * Consulta la API de STM, enriquece los datos y los devuelve.
   * Reemplaza la llamada al proxy — llama directo a la API de la IMM.
   * @returns {Promise<Object>} GeoJSON con features enriquecidas
   */
  async function fetchBuses() {
    const res = await fetch('https://www.montevideo.gub.uy/buses/rest/stm-online', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data.features) enrichFeatures(data.features);
    return data;
  }

  return { init, fetchBuses, enrichFeatures, classifyBus };

})();
