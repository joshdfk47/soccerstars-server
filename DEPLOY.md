# Desplegar el servidor (y sacar la URL)

La **URL la genera el hosting** cuando subes este servidor. Pasos:

## Opción A — Render (recomendado, gratis, Node persistente)
1. Sube esta carpeta a un repo de GitHub (ver "Subir a GitHub" abajo).
2. Entra en https://render.com → **New** → **Blueprint** → conecta el repo.
   - Render lee `render.yaml` y lo configura solo (build `npm install`, start `node server.js`).
3. Cuando termine, Render te da una **URL pública**, por ejemplo:
   `https://soccerstars-server.onrender.com`
4. **Esa URL + `/api/v1`** es la que va en el cliente del juego (`Cloud.cs`).
   Compruébala abriendo en el navegador: `https://TU-URL/api/v1/health` → debe responder `{"ok":true}`.

> Alternativa igual de válida: **Railway** (https://railway.app → New Project → Deploy from GitHub → start `node server.js`).

## Opción B — Vercel (NO recomendado para este server)
Vercel es serverless con disco efímero: se perderían cuentas/presencia. Requeriría
reescribir el almacén a una base de datos (Vercel KV/Postgres). Pídemelo si lo quieres.

## Subir a GitHub (desde esta carpeta `server/`)
```bash
cd server
git init
git add .
git commit -m "Servidor SoccerStars (social + online)"
# crea un repo vacío en github.com (botón New) y copia su URL, luego:
git remote add origin https://github.com/TU_USUARIO/TU_REPO.git
git branch -M main
git push -u origin main
```
Después conecta ese repo en Render (Opción A).
