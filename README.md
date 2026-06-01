# Monitor STM — GitHub Pages + Render

La aplicación usa dos despliegues complementarios:

- **GitHub Pages** publica el frontend estático desde `index.html`.
- **Render** ejecuta el backend Node.js de `server.js`, consulta la API de STM y expone `POST /api/buses`.

GitHub Pages no puede ejecutar un backend Node.js. Por eso el navegador cargado desde `github.io` debe conectarse a la URL pública del servicio de Render.

## Desplegar el backend en Render

1. Creá un **Blueprint** en Render conectado a este repositorio. Render detectará `render.yaml`.
2. Esperá a que el servicio quede disponible, por ejemplo en `https://stm-monitor.onrender.com`.
3. Verificá el health check abriendo `https://stm-monitor.onrender.com/health`.

El frontend también queda disponible desde Render en la raíz del servicio.

## Publicar el frontend en GitHub Pages

1. En GitHub, abrí **Settings → Pages**.
2. Elegí **Deploy from a branch** y publicá la rama deseada desde la carpeta raíz (`/`).
3. Abrí la URL `https://<usuario>.github.io/<repositorio>/`.
4. En la pantalla inicial ingresá la URL completa del endpoint de Render, por ejemplo:

   ```text
   https://stm-monitor.onrender.com/api/buses
   ```

5. Presioná **Conectar**. La URL queda guardada en `localStorage` para las próximas visitas.

## Ejecutar localmente

```bash
npm install
npm start
```

Luego abrí `http://localhost:3001`. Cuando el frontend se sirve desde el propio backend utiliza `/api/buses` automáticamente.
