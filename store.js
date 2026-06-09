'use strict';

/**
 * Persistencia simple en fichero JSON con:
 *  - Escritura atómica (tmp + rename).
 *  - Accesos serializados (lock por cola de promesas) anti-carrera.
 *  - Validación de esquema al cargar (fail-closed: si el fichero está corrupto,
 *    se arranca con estado vacío en memoria y NO se machaca el fichero hasta
 *    el siguiente save válido).
 *
 * Estructura del estado:
 * {
 *   players: {
 *     [playerId]: {
 *       playerId, deviceId, name, createdAt,
 *       profile: { version:int, data:string } | null,
 *       scores: {                      // mejores valores validados/clampados
 *         level, billetes, wins, goals
 *       },
 *       rate: {                        // estado anti-incrementos para POST /scores
 *         [metric]: { lastValue:int, lastTimestamp:int }
 *       }
 *     }
 *   },
 *   tokens:  { [token]: playerId },
 *   devices: { [deviceId]: playerId }
 * }
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const TMP_FILE = path.join(DATA_DIR, 'db.json.tmp');

// ---- Persistencia REMOTA en un archivo JSON (JSONBin.io) para que NO se borre al reiniciar Render free ----
// Configúralo en Render con env vars: JSONBIN_ID (id del bin) y JSONBIN_KEY (X-Master-Key). Si faltan, solo archivo local.
const JSONBIN_ID = process.env.JSONBIN_ID || '';
const JSONBIN_KEY = process.env.JSONBIN_KEY || '';
const REMOTE_ON = !!(JSONBIN_ID && JSONBIN_KEY);
// Startup warning: if ID is set but KEY is missing, remote persistence is silently disabled.
if (JSONBIN_ID && !JSONBIN_KEY) {
  // eslint-disable-next-line no-console
  console.error('[store] JSONBIN_ID is set but JSONBIN_KEY is missing — remote persistence DISABLED, data will be lost on redeploy');
}

function emptyState() {
  // matches: relay de partidas online por turnos.  seq: contador global de ids.
  // accounts: índice usuario(minúsculas) -> playerId (CUENTAS con contraseña, para entrar desde cualquier dispositivo).
  // clubs: clanes (clubId -> {id,name,tag,ownerId,members[],createdAt}).
  return { players: {}, tokens: {}, devices: {}, accounts: {}, matches: {}, queue: {}, clubs: {}, event: null, seq: 0, playerTokens: {}, clubNames: {}, clubTags: {} };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Valida (fail-closed) el esquema cargado del disco. Devuelve un estado
 * saneado o el estado vacío si algo no cuadra.
 */
function sanitizeState(raw) {
  if (!isPlainObject(raw)) return emptyState();
  if (!isPlainObject(raw.players) || !isPlainObject(raw.tokens) || !isPlainObject(raw.devices)) {
    return emptyState();
  }
  // Confiamos en lo que validamos al escribir; aquí hacemos chequeos básicos.
  const state = emptyState();
  for (const [pid, p] of Object.entries(raw.players)) {
    if (!isPlainObject(p)) continue;
    if (typeof p.playerId !== 'string') continue;
    const scores = isPlainObject(p.scores) ? p.scores : {};
    const rate = isPlainObject(p.rate) ? p.rate : {};
    state.players[pid] = {
      playerId: p.playerId,
      deviceId: typeof p.deviceId === 'string' ? p.deviceId : '',
      name: typeof p.name === 'string' ? p.name : '',
      username: typeof p.username === 'string' ? p.username : '',   // CUENTA: usuario (minúsculas) para login con contraseña
      passHash: typeof p.passHash === 'string' ? p.passHash : '',   // CUENTA: hash SHA-256 de la contraseña
      clubId: typeof p.clubId === 'string' ? p.clubId : '',         // CLAN al que pertenece ('' = ninguno)
      createdAt: Number.isInteger(p.createdAt) ? p.createdAt : 0,
      profile: isPlainObject(p.profile) &&
        Number.isInteger(p.profile.version) &&
        typeof p.profile.data === 'string'
        ? { version: p.profile.version, data: p.profile.data }
        : null,
      scores: {
        level: Number.isInteger(scores.level) ? scores.level : 0,
        billetes: Number.isInteger(scores.billetes) ? scores.billetes : 0,
        wins: Number.isInteger(scores.wins) ? scores.wins : 0,
        goals: Number.isInteger(scores.goals) ? scores.goals : 0
      },
      rate: isPlainObject(rate) ? rate : {},
      // ---- Social/online ----
      lastSeen: Number.isInteger(p.lastSeen) ? p.lastSeen : 0,
      friends: Array.isArray(p.friends) ? p.friends.filter((x) => typeof x === 'string') : [],
      challenges: Array.isArray(p.challenges) ? p.challenges.filter(isPlainObject).slice(-40) : [],
      chats: Array.isArray(p.chats) ? p.chats.filter(isPlainObject).slice(-60) : [],
      matchId: typeof p.matchId === 'string' ? p.matchId : null
    };
  }
  state.seq = Number.isInteger(raw.seq) ? raw.seq : 0;
  if (isPlainObject(raw.matches)) {
    for (const [mid, m] of Object.entries(raw.matches)) {
      if (isPlainObject(m) && typeof m.a === 'string' && typeof m.b === 'string') {
        if (typeof m.state !== 'string') m.state = null;        // estado-último (no persistido, default seguro)
        if (typeof m.stateBy !== 'string') m.stateBy = null;
        if (!Number.isInteger(m.stateTs)) m.stateTs = 0;
        state.matches[mid] = m;
      }
    }
  }
  for (const [token, pid] of Object.entries(raw.tokens)) {
    if (typeof token === 'string' && typeof pid === 'string' && state.players[pid]) {
      state.tokens[token] = pid;
      // Rebuild reverse index (last token for a player wins, consistent with ensureTokenFor).
      state.playerTokens[pid] = token;
    }
  }
  for (const [deviceId, pid] of Object.entries(raw.devices)) {
    if (typeof deviceId === 'string' && typeof pid === 'string' && state.players[pid]) {
      state.devices[deviceId] = pid;
    }
  }
  if (isPlainObject(raw.accounts)) {
    for (const [uname, pid] of Object.entries(raw.accounts)) {
      if (typeof uname === 'string' && typeof pid === 'string' && state.players[pid]) {
        state.accounts[uname] = pid;
      }
    }
  }
  if (isPlainObject(raw.clubs)) {
    for (const [cid, c] of Object.entries(raw.clubs)) {
      if (isPlainObject(c) && typeof c.id === 'string' && typeof c.name === 'string' && Array.isArray(c.members)) {
        const tag = typeof c.tag === 'string' ? c.tag : '';
        state.clubs[cid] = {
          id: c.id, name: c.name,
          tag,
          logoId: typeof c.logoId === 'string' ? c.logoId : '',
          ownerId: typeof c.ownerId === 'string' ? c.ownerId : '',
          members: c.members.filter((x) => typeof x === 'string'),
          createdAt: Number.isInteger(c.createdAt) ? c.createdAt : 0,
          chat: Array.isArray(c.chat) ? c.chat.filter(isPlainObject).slice(-200) : []
        };
        // Rebuild O(1) lookup indexes.
        state.clubNames[c.name.toLowerCase()] = cid;
        if (tag) state.clubTags[tag.toUpperCase()] = cid;
      }
    }
  }
  return state;
}

class Store {
  constructor() {
    this.state = emptyState();
    this._chain = Promise.resolve(); // cola de serialización para escrituras
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.state = sanitizeState(parsed);
      } else {
        this.state = emptyState();
      }
    } catch (err) {
      // Fail-closed: estado vacío en memoria, no tocamos el fichero corrupto.
      // (Logging mínimo, sin filtrar detalles a clientes.)
      // eslint-disable-next-line no-console
      console.error('[store] No se pudo cargar db.json, arranco con estado vacío:', err.message);
      this.state = emptyState();
    }
  }

  /**
   * Persiste el estado actual de forma atómica. Las llamadas se serializan
   * mediante una cola de promesas para evitar escrituras concurrentes.
   */
  save() {
    // Debounce local writes by 200ms to coalesce rapid consecutive saves and
    // defer JSON.stringify off the hot request path (avoids synchronous event-loop blocking).
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      const snapshot = JSON.stringify(this.state, null, 2);
      this._chain = this._chain.then(() => this._atomicWrite(snapshot)).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('[store] Error al persistir:', err.message);
      });
    }, 200);
    this._remoteSave();   // backup al JSON remoto (debounced)
    return this._chain;
  }

  // Carga el estado del JSON remoto (JSONBin) al arrancar -> sobrevive a reinicios de Render free.
  async loadRemote() {
    if (!REMOTE_ON) return;
    try {
      const r = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_ID}/latest`, { headers: { 'X-Master-Key': JSONBIN_KEY }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) { console.error('[store] carga remota HTTP', r.status); return; }
      const j = await r.json();
      if (j && j.record && j.record.players) { this.state = sanitizeState(j.record); console.log('[store] estado cargado del JSON remoto'); }
    } catch (e) { console.error('[store] error carga remota:', e.message); }
  }

  // Guarda el estado en el JSON remoto, con debounce de 6s (no machacar la API).
  // The state snapshot is captured at call time so mutations during the debounce
  // window do not race with a subsequent PUT, and a process crash does not silently
  // lose the data that triggered this save.
  _remoteSave() {
    if (!REMOTE_ON) return;
    // Capture snapshot now so the debounced PUT sends the state as of this call,
    // not whatever state happens to be in memory 6 seconds later.
    const snapshot = JSON.stringify(this.state);
    clearTimeout(this._remoteT);
    this._remoteT = setTimeout(() => {
      fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_ID}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
        body: snapshot,
        signal: AbortSignal.timeout(10000)
      }).catch((e) => console.error('[store] error guardado remoto:', e.message));
    }, 6000);
  }

  _atomicWrite(contents) {
    return new Promise((resolve, reject) => {
      fs.mkdir(DATA_DIR, { recursive: true }, (mkErr) => {
        if (mkErr) return reject(mkErr);
        fs.writeFile(TMP_FILE, contents, 'utf8', (wErr) => {
          if (wErr) return reject(wErr);
          fs.rename(TMP_FILE, DB_FILE, (rErr) => {
            if (rErr) return reject(rErr);
            resolve();
          });
        });
      });
    });
  }

  // ---- Helpers de dominio -------------------------------------------------

  getPlayerByToken(token) {
    if (typeof token !== 'string') return null;
    const pid = this.state.tokens[token];
    if (!pid) return null;
    return this.state.players[pid] || null;
  }

  getPlayerByDevice(deviceId) {
    const pid = this.state.devices[deviceId];
    if (!pid) return null;
    return this.state.players[pid] || null;
  }

  createPlayer(playerId, deviceId, name, token, now) {
    const player = {
      playerId,
      deviceId,
      name,
      username: '',   // CUENTA con contraseña (se rellena en /auth/account); '' = solo dispositivo
      passHash: '',
      clubId: '',     // CLAN al que pertenece
      createdAt: now,
      profile: null,
      scores: { level: 0, billetes: 0, wins: 0, goals: 0 },
      rankstats: { pj: 0, pg: 0, pe: 0, pp: 0, gf: 0, gc: 0, div: 0, ts: 0 }, // snapshot de stats para el RANKING completo
      // Línea base de tasa sembrada en la creación de la cuenta: lastValue=0 y
      // lastTimestamp=createdAt para CADA métrica. Así el PRIMER POST /scores
      // ya queda sujeto al control de tasa (RATE_LIMITS) y a la ventana mínima
      // (MIN_WINDOW_MS), cerrando el bypass de "primera observación = sin clamp"
      // y el reset de línea base creando cuentas nuevas por deviceId.
      rate: {
        level: { lastValue: 0, lastTimestamp: now },
        billetes: { lastValue: 0, lastTimestamp: now },
        wins: { lastValue: 0, lastTimestamp: now },
        goals: { lastValue: 0, lastTimestamp: now }
      },
      // ---- Social/online ----
      lastSeen: now,
      friends: [],
      challenges: [],   // retos entrantes pendientes
      chats: [],        // mensajes privados entrantes (capados)
      matchId: null     // partida online en curso
    };
    this.state.players[playerId] = player;
    if (deviceId) this.state.devices[deviceId] = playerId;   // las CUENTAS no tienen deviceId
    this.state.tokens[token] = playerId;
    this.state.playerTokens[playerId] = token;   // reverse index for O(1) ensureTokenFor()
    return player;
  }

  // ---- CUENTAS (usuario + contraseña, para entrar desde cualquier dispositivo) ----
  getPlayerByAccount(uname) {
    if (typeof uname !== 'string') return null;
    const pid = this.state.accounts[uname];
    return pid ? this.state.players[pid] || null : null;
  }
  registerAccount(uname, playerId) {
    this.state.accounts[uname] = playerId;
  }

  // ---- CLANES ----
  getClub(id) {
    if (typeof id !== 'string') return null;
    return this.state.clubs[id] || null;
  }
  clubNameTaken(name) {
    return Object.prototype.hasOwnProperty.call(this.state.clubNames, name.toLowerCase());
  }
  clubTagTaken(tag) {
    return Object.prototype.hasOwnProperty.call(this.state.clubTags, tag.toUpperCase());
  }

  /** Devuelve el token existente de un jugador, o crea uno nuevo. O(1) via reverse index. */
  ensureTokenFor(playerId, newTokenFactory) {
    const existing = this.state.playerTokens[playerId];
    if (existing && this.state.tokens[existing] === playerId) return existing;
    // No valid reverse-index entry — create a new token and maintain both maps.
    const tok = newTokenFactory();
    this.state.tokens[tok] = playerId;
    this.state.playerTokens[playerId] = tok;
    return tok;
  }

  allPlayers() {
    return Object.values(this.state.players);
  }

  getPlayerById(id) {
    if (typeof id !== 'string') return null;
    return this.state.players[id] || null;
  }

  /** Id único incremental (para retos, chats y partidas). */
  nextSeq() {
    this.state.seq = (this.state.seq || 0) + 1;
    return this.state.seq;
  }

  matches() {
    return this.state.matches;
  }
}

module.exports = { Store, DATA_DIR, DB_FILE };
