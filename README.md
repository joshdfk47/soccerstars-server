# Servidor de referencia — SoccerStars / juego casual

Servidor Express **server-authoritative** con reglas anti-trampas. Persistencia
simple en fichero JSON. Sin dependencias más allá de `express` (CORS hecho a
mano). Pensado como implementación de REFERENCIA del contrato de API.

## Contrato de API

Base: `/api/v1`. Auth por header `Authorization: Bearer <token>`.

| Método | Ruta | Auth | Body | Respuesta |
|--------|------|------|------|-----------|
| GET  | `/health` | no | — | `200 {ok:true}` |
| POST | `/auth/device` | no | `{deviceId,name}` | `200 {playerId, token}` |
| GET  | `/profile` | sí | — | `200 {version,data}` \| `404` |
| PUT  | `/profile` | sí | `{version,data}` | `200 {version}` \| `409 {version,data}` |
| POST | `/scores` | sí | `{level,billetes,wins,goals}` | `200 {ok:true}` |
| GET  | `/leaderboard?metric=level\|billetes\|wins&limit=50` | no | — | `200 {entries:[{rank,name,value}]}` |

Notas del contrato:

- `data` del perfil es un **string** (JSON del Profile del juego serializado).
- `409` en `PUT /profile` significa que el servidor tiene una versión más
  nueva; devuelve `{version,data}` actuales del servidor.
- `POST /scores`: el servidor **valida y clampa** (anti-trampas). Solo guarda lo
  que él recalcula; nunca el valor crudo.
- `/auth/device`: misma `deviceId` => misma cuenta (crea o recupera).

## Anti-trampas (resumen)

- Zero-trust: el cliente solo propone; el servidor decide, clampa y persiste.
- Token opaco aleatorio de 32 bytes (hex), comparación en tiempo constante,
  guardado solo en servidor, nunca devuelto salvo en `/auth/device`.
- `playerId` se deriva SIEMPRE del token; se ignora cualquier `playerId` del body.
- Validación estricta de tipos (enteros finitos `>= 0`), whitelist de campos.
- Clamps duros: `level 0..999`, `billetes 0..1e7`, `wins 0..1e6`, `goals 0..1e6`.
- Monotonía (las métricas solo suben) + control de tasa de incremento entre
  envíos usando el reloj del servidor.
- `Content-Type: application/json` obligatorio (`415` si no), límites de body
  (`64KB` perfil, `2KB` resto) a nivel de stream (`413`).
- Rate limiting por token/IP con `Retry-After` (`429`).
- Escritura atómica (tmp + rename), accesos serializados, carga fail-closed.
- CORS abierto, `X-Content-Type-Options: nosniff`, `405` en métodos no
  soportados, sin stack traces al cliente.

Detalle completo en `../ANTICHEAT.md`.

## Ejecutar en local

Requiere Node.js >= 18.

```bash
npm install
npm start
```

Por defecto escucha en el puerto `8080`. Para cambiarlo:

```bash
PORT=8090 npm start
```

Copia `.env.example` a `.env` si tu plataforma carga variables desde fichero
(este servidor lee `process.env.PORT` directamente; no necesita `dotenv`).

### Smoke test rápido

```bash
PORT=8090 node server.js &
sleep 1
curl -s localhost:8090/api/v1/health
TOKEN=$(curl -s -X POST localhost:8090/api/v1/auth/device \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"device-abc-123","name":"Josh"}' | sed 's/.*"token":"\([^"]*\)".*/\1/')
curl -s -X PUT localhost:8090/api/v1/profile -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"version":0,"data":"{\"coins\":10}"}'
curl -s localhost:8090/api/v1/profile -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:8090/api/v1/scores -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"level":5,"billetes":100,"wins":2,"goals":7}'
curl -s 'localhost:8090/api/v1/leaderboard?metric=level&limit=10'
```

## Persistencia

Estado en `data/db.json` (la carpeta se crea automáticamente). Escritura
atómica vía fichero temporal + `rename`. Al cargar se valida el esquema; si el
fichero está corrupto se arranca con estado vacío (fail-closed) sin sobrescribir
el fichero hasta el siguiente guardado válido.

> En despliegues con disco efímero (ver abajo) los datos se pierden al
> redeploy. Para producción real, monta un disco persistente o migra a una BD.

## Desplegar gratis

### Render

1. Sube este directorio `server/` a un repositorio Git (puede ser subcarpeta).
2. En [render.com](https://render.com) crea un **New > Web Service** apuntando
   al repo.
3. Configuración:
   - **Root Directory**: `server` (si está en subcarpeta).
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment**: Node.
4. Render inyecta `PORT` automáticamente; el servidor ya lo respeta.
5. (Opcional) Añade un **Disk** persistente montado en `server/data` para no
   perder `db.json` entre redeploys.

### Railway

1. `railway init` o conecta el repo en [railway.app](https://railway.app).
2. Railway detecta Node y ejecuta `npm install` + `npm start`.
3. Define el **Root Directory** = `server` si está en subcarpeta.
4. Railway expone `PORT` por variable de entorno (ya soportado).
5. (Opcional) Añade un **Volume** montado en `/app/server/data` para persistir.

### Fly.io

1. Instala `flyctl` y `fly auth login`.
2. Desde `server/` ejecuta `fly launch` (genera `fly.toml`; no despliegues aún).
3. Asegúrate de que el `internal_port` del `fly.toml` coincide con tu `PORT`
   (Fly usa `8080` por defecto, que también es el default de este servidor).
4. (Opcional) Crea un volumen y móntalo en `data`:
   ```bash
   fly volumes create data --size 1
   ```
   y en `fly.toml`:
   ```toml
   [mounts]
   source = "data"
   destination = "/app/data"
   ```
5. `fly deploy`.

## Estructura

```
server/
  package.json     # express como única dependencia; start: node server.js
  server.js        # app Express, rutas, anti-trampas, CORS manual
  store.js         # persistencia atómica en data/db.json + validación de esquema
  .env.example     # PORT=8080
  README.md        # este fichero
  data/db.json     # se crea en runtime
```
