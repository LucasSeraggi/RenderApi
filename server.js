/**
 * Steam Trophy Tracker — Backend Express
 *
 * Endpoints:
 *   GET  /auth/steam                              → redireciona para login Steam
 *   GET  /auth/steam/return                       → callback do OpenID
 *   POST /auth/logout                             → encerra sessão
 *   GET  /api/me                                  → dados do usuário logado
 *   GET  /api/games                               → jogos do usuário logado
 *   GET  /api/games/:appId/achievements           → conquistas do usuário logado
 *   GET  /api/player/:steamId/games              → jogos de outro jogador
 *   GET  /api/player/:steamId/library            → biblioteca completa de outro jogador
 *   GET  /api/player/:steamId/games/:appId/achievements → conquistas de outro jogador
 *   GET  /api/search?q=...                        → busca jogador por SteamID / URL
 */

'use strict';

require('dotenv').config();

const express   = require('express');
const session   = require('express-session');
const passport  = require('passport');
const Steam     = require('passport-steam').Strategy;
const path      = require('path');
const compression = require('compression');
const db        = require('./db');

// ─── Config ──────────────────────────────────────────────────────────────────
const API_KEY     = process.env.STEAM_API_KEY;
const SECRET      = process.env.SESSION_SECRET || 'change-me-in-production';
const PORT        = parseInt(process.env.PORT || '3000', 10);
const BASE_URL    = process.env.BASE_URL || `http://localhost:${PORT}`;
const NODE_ENV    = process.env.NODE_ENV || 'development';
const isDev       = NODE_ENV === 'development';

if (!API_KEY) {
  console.error('❌  STEAM_API_KEY não encontrada no .env');
  process.exit(1);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const STEAM_API = 'https://api.steampowered.com';
const STORE_API = 'https://store.steampowered.com';

async function steamGet(path, params = {}) {
  const url = new URL(`${STEAM_API}${path}`);
  url.searchParams.set('key', API_KEY);
  url.searchParams.set('format', 'json');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Steam API ${res.status}: ${path}`);
  return res.json();
}

// Converte SteamID64 ou vanity URL para SteamID64
async function resolveSteamId(query) {
  query = query.trim();

  // Já é SteamID64 (17 dígitos numéricos)
  if (/^\d{17}$/.test(query)) return query;

  // Extrai /id/NOME ou /profiles/STEAMID de URLs
  const urlMatch = query.match(/\/(?:id|profiles)\/([^/]+)\/?$/);
  if (urlMatch) {
    const part = urlMatch[1];
    if (/^\d{17}$/.test(part)) return part;
    query = part;
  }

  // Tenta resolver como vanity URL
  const data = await steamGet('/ISteamUser/ResolveVanityURL/v1/', { vanityurl: query });
  if (data?.response?.success === 1) return data.response.steamid;

  throw new Error('Jogador não encontrado');
}

async function getPlayerSummary(steamId) {
  const data = await steamGet('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId });
  const p    = data?.response?.players?.[0];
  if (!p) throw new Error('Jogador não encontrado');
  return {
    steamId:                   p.steamid,
    personaName:               p.personaname,
    realName:                  p.realname || null,
    avatarUrl:                 p.avatarfull,
    profileUrl:                p.profileurl,
    communityVisibilityState:  p.communityvisibilitystate,
  };
}

async function getOwnedGames(steamId) {
  const data = await steamGet('/IPlayerService/GetOwnedGames/v1/', {
    steamid:                    steamId,
    include_appinfo:            1,
    include_played_free_games:  1,
  });
  return (data?.response?.games || []).map(g => ({
    appid:                        g.appid,
    name:                         g.name || `App ${g.appid}`,
    playtime_forever:             g.playtime_forever || 0,
    has_community_visible_stats:  true, // filter later on fetch failure
  }));
}

async function getAchievements(appId, steamId) {
  // Fire all 3 Steam API calls in parallel
  const [schemaData, statsData, pctData] = await Promise.all([
    steamGet('/ISteamUserStats/GetSchemaForGame/v2/', { appid: appId }).catch(() => null),
    steamGet('/ISteamUserStats/GetPlayerAchievements/v1/', {
      steamid: steamId,
      appid:   appId,
      l:       'portuguese',
    }).catch(() => null),
    steamGet('/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/', {
      gameid: appId,
    }).catch(() => null),
  ]);

  const schema     = schemaData?.game?.availableGameStats?.achievements || [];
  const playerAchs = statsData?.playerstats?.achievements || [];

  const pctMap = {};
  for (const p of pctData?.achievementpercentages?.achievements || []) {
    pctMap[p.name] = p.percent;
  }

  const playerMap = {};
  for (const a of playerAchs) playerMap[a.apiname] = a;

  return schema.map(s => {
    const p = playerMap[s.name] || {};
    return {
      apiname:     s.name,
      name:        p.name || s.displayName || s.name,
      description: p.description || s.description || '',
      icon:        s.icon        || '',
      icongray:    s.icongray    || '',
      achieved:    p.achieved    || 0,
      unlocktime:  p.unlocktime  || 0,
      percent:     pctMap[s.name] != null ? Number(pctMap[s.name]) : null,
    };
  });
}

// ─── Passport / Steam OpenID ──────────────────────────────────────────────────
passport.serializeUser((user, done)   => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

passport.use(new Steam(
  {
    returnURL: `${BASE_URL}/auth/steam/return`,
    realm:     BASE_URL,
    apiKey:    API_KEY,
  },
  async (_identifier, profile, done) => {
    try {
      const user = await getPlayerSummary(profile.id);
      // ── Mantém perfil fresco no SQLite ──
      db.updateProfile({
        steamId    : user.steamId,
        personaName: user.personaName,
        avatarUrl  : user.avatarUrl,
        profileUrl : user.profileUrl,
        isPrivate  : user.communityVisibilityState < 3,
      });
      done(null, user);
    } catch (err) {
      done(err);
    }
  }
));

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();

// ─── Middlewares ─────────────────────────────────────────────────────────────
// Compressão gzip para reduzir tamanho das respostas
app.use(compression({
  level: 6,
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret:            SECRET,
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   BASE_URL.startsWith('https'),
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// Cache headers middleware
function cacheControl(maxAgeSeconds) {
  return (req, res, next) => {
    if (!isDev) {
      res.set('Cache-Control', `public, max-age=${maxAgeSeconds}`);
    }
    next();
  };
}

// Request deduplication middleware
const pendingRequests = new Map();
function dedupeRequests(keyGenerator) {
  return (req, res, next) => {
    const key = keyGenerator(req);
    if (pendingRequests.has(key)) {
      pendingRequests.get(key).push(res);
      return;
    }
    pendingRequests.set(key, [res]);
    
    const originalJson = res.json.bind(res);
    res.json = (data) => {
      const responses = pendingRequests.get(key) || [];
      pendingRequests.delete(key);
      responses.forEach(r => originalJson.call(r, data));
    };
    
    next();
  };
}

// ─── Auth routes ──────────────────────────────────────────────────────────────
app.get('/auth/steam',
  passport.authenticate('steam', { failureRedirect: '/' })
);

app.get('/auth/steam/return',
  passport.authenticate('steam', { failureRedirect: '/?error=auth' }),
  (req, res) => {
    // Em dev, o frontend está em :5173; em prod, servimos o build do React
    const frontendUrl = process.env.NODE_ENV === 'production'
      ? `${BASE_URL}/?loggedIn=1`
      : `http://localhost:5173/?loggedIn=1`;
    res.redirect(frontendUrl);
  }
);

app.post('/auth/logout', (req, res) => {
  req.logout(() => {
    req.session.destroy(() => res.json({ ok: true }));
  });
});


const _profileCache = new Map();

function _getCached(key) {
  const entry = _profileCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _profileCache.delete(key); return null; }
  return entry.data;
}
function _setCached(key, data, ttlMs) {
  _profileCache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/profile/background
//  Retorna o background de perfil ativo do usuário logado.
//
//  Response shape (passado direto do Steam):
//  {
//    profile_background: {
//      communityitemid, image_large, name, item_title,
//      movie_webm?, movie_mp4?, movie_webm_small?, movie_mp4_small?,
//      appid, ...
//    }
//  }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/profile/background', requireAuth, async (req, res) => {
  const steamId = req.user?.steamId || req.session?.passport?.user?.steamId;
  if (!steamId) return res.status(401).json({ error: 'Not authenticated' });

  const cacheKey = `bg:${steamId}`;
  const cached = _getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = new URL('https://api.steampowered.com/IPlayerService/GetProfileBackground/v1/');
    url.searchParams.set('key', process.env.STEAM_API_KEY);
    url.searchParams.set('steamid', steamId);

    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`Steam returned ${r.status}`);

    const data = await r.json();
    const result = data?.response ?? {};
    _setCached(cacheKey, result, 5 * 60 * 1000); // 5 min
    return res.json(result);
  } catch (err) {
    console.error('[Profile] background error:', err.message);
    return res.json({});   // degradação graciosa — sem background
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/player/:steamId/background
//  Retorna o background de perfil de qualquer jogador.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/player/:steamId/background', async (req, res) => {
  const { steamId } = req.params;
  if (!steamId || !/^\d+$/.test(steamId)) {
    return res.status(400).json({ error: 'Invalid steamId' });
  }

  const cacheKey = `bg:${steamId}`;
  const cached = _getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = new URL('https://api.steampowered.com/IPlayerService/GetProfileBackground/v1/');
    url.searchParams.set('key', process.env.STEAM_API_KEY);
    url.searchParams.set('steamid', steamId);

    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`Steam returned ${r.status}`);

    const data = await r.json();
    const result = data?.response ?? {};
    _setCached(cacheKey, result, 5 * 60 * 1000); // 5 min
    return res.json(result);
  } catch (err) {
    console.error('[Player Background] error:', err.message);
    return res.json({});   // degradação graciosa
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/profile/recent-games
//  Retorna os jogos jogados recentemente pelo usuário logado.
//
//  Response shape:
//  {
//    total_count: N,
//    games: [{ appid, name, playtime_2weeks, playtime_forever, img_icon_url, ... }]
//  }
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/profile/recent-games', requireAuth, async (req, res) => {
  const steamId = req.user?.steamId || req.session?.passport?.user?.steamId;
  if (!steamId) return res.status(401).json({ error: 'Not authenticated' });

  const cacheKey = `recent:${steamId}`;
  const cached = _getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const url = new URL('https://api.steampowered.com/IPlayerService/GetRecentlyPlayedGames/v1/');
    url.searchParams.set('key', process.env.STEAM_API_KEY);
    url.searchParams.set('steamid', steamId);
    url.searchParams.set('count', '10');

    const r = await fetch(url.toString());
    if (!r.ok) throw new Error(`Steam returned ${r.status}`);

    const data = await r.json();
    const result = data?.response ?? { total_count: 0, games: [] };
    _setCached(cacheKey, result, 2 * 60 * 1000); // 2 min
    return res.json(result);
  } catch (err) {
    console.error('[Profile] recent-games error:', err.message);
    return res.json({ total_count: 0, games: [] });
  }
});






// ─── Auth middleware ──────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Não autenticado' });
}

// ─── API routes ───────────────────────────────────────────────────────────────

// Dados do usuário logado
app.get('/api/me', (req, res) => {
  if (!req.isAuthenticated()) return res.status(401).json(null);
  res.json(req.user);
});

// Jogos do usuário logado
app.get('/api/games', requireAuth, async (req, res) => {
  try {
    const games = await getOwnedGames(req.user.steamId);
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conquistas do usuário logado para um jogo
app.get('/api/games/:appId/achievements', requireAuth, async (req, res) => {
  try {
    const achs = await getAchievements(Number(req.params.appId), req.user.steamId);
    res.json(achs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Buscar jogador por SteamID64, vanity URL ou link do perfil
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const steamId = await resolveSteamId(req.query.q || '');
    const summary = await getPlayerSummary(steamId);
    res.json(summary);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Dados de outro jogador
app.get('/api/player/:steamId/summary', requireAuth, async (req, res) => {
  try {
    const summary = await getPlayerSummary(req.params.steamId);
    res.json(summary);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Biblioteca completa de outro jogador (para LibraryModal)
app.get('/api/player/:steamId/library', requireAuth, async (req, res) => {
  const { steamId } = req.params;
  const cacheKey = `library:${steamId}`;
  const cached = _getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const games = await getOwnedGames(steamId);
    _setCached(cacheKey, games, 5 * 60 * 1000); // 5 min cache
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Jogos de outro jogador (com has_community_visible_stats)
app.get('/api/player/:steamId/games', requireAuth, async (req, res) => {
  const { steamId } = req.params;
  const cacheKey = `games:${steamId}`;
  const cached = _getCached(cacheKey);
  if (cached) return res.json(cached);

  try {
    const games = await getOwnedGames(steamId);
    _setCached(cacheKey, games, 5 * 60 * 1000); // 5 min cache
    res.json(games);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conquistas de outro jogador para um jogo
app.get('/api/player/:steamId/games/:appId/achievements', requireAuth, async (req, res) => {
  try {
    const achs = await getAchievements(Number(req.params.appId), req.params.steamId);
    res.json(achs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Servir build do React em produção ───────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🏆  Steam Trophy Tracker backend rodando!');
  console.log(`   API:    http://localhost:${PORT}`);
  console.log(`   Login:  http://localhost:${PORT}/auth/steam`);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`   React:  http://localhost:5173  (npm run dev em outra aba)\n`);
  }
});



// =============================================================================
//  server-leaderboard-patch.js  (v2 — SQLite)
//
//  Substitui a versão anterior (que usava Map em memória).
//
//  Cole no server.js LOGO ANTES do bloco:
//    if (process.env.NODE_ENV === 'production') { ... }
//
//  Requer:
//    npm install better-sqlite3
//    const db = require('./db/db');   ← adicione no topo do server.js
//
//  Endpoints:
//    POST   /api/leaderboard/register     → upserta stats do usuário logado
//    GET    /api/leaderboard/global       → top N jogadores (paginado)
//    GET    /api/leaderboard/friends      → amigos do Steam (combinado Steam + SQLite)
//    GET    /api/leaderboard/search?q=    → busca por nome no SQLite
//    GET    /api/leaderboard/me/rank      → posição global do usuário logado
// =============================================================================

'use strict';

// ─── Adicione esta linha no TOPO do server.js, junto com os outros requires ──
// const db = require('./db/db');
// ─────────────────────────────────────────────────────────────────────────────

// ─── Cache leve para o endpoint de amigos (evita hammerar Steam API) ─────────
// O global usa SQLite diretamente — sem cache extra necessário.
const _friendsCache = new Map();

function getFriendsCache(steamId)        { return _friendsCache.get(steamId) ?? null; }
function setFriendsCache(steamId, data)  { _friendsCache.set(steamId, { data, ts: Date.now() }); }
function isFriendsCacheFresh(steamId)    {
  const c = _friendsCache.get(steamId);
  return c && Date.now() - c.ts < 5 * 60 * 1000; // 5 min
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/leaderboard/register
//  Registra (ou atualiza) os stats do usuário logado no SQLite.
//  Deve ser chamado pelo frontend toda vez que os jogos terminam de carregar.
//
//  Body: { totalAch, platCount, rareCount, gameCount }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/leaderboard/register', requireAuth, (req, res) => {
  const { totalAch, platCount, rareCount, gameCount } = req.body;

  if (
    typeof totalAch  !== 'number' ||
    typeof platCount !== 'number' ||
    typeof gameCount !== 'number'
  ) {
    return res.status(400).json({ error: 'Body inválido: totalAch, platCount e gameCount são obrigatórios' });
  }

  const user = req.user;

  try {
    db.upsertPlayer({
      steamId    : user.steamId,
      personaName: user.personaName,
      avatarUrl  : user.avatarUrl,
      profileUrl : user.profileUrl,
      isPrivate  : user.communityVisibilityState < 3,
      totalAch,
      platCount,
      rareCount  : rareCount ?? 0,
      gameCount,
    });

    // Invalida cache de amigos de qualquer um que tenha este usuário na lista
    // (não temos essa info diretamente — simplesmente limpamos tudo)
    _friendsCache.clear();

    console.log(`[Leaderboard] ${user.personaName} registrado: ${totalAch} ach, ${platCount} plat`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Leaderboard] Erro ao registrar:', err.message);
    return res.status(500).json({ error: 'Erro interno ao salvar stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /api/leaderboard/register/:steamId
//  Registra/atualiza stats de QUALQUER jogador pesquisado no leaderboard.
//  Usado quando você pesquisa um amigo e quer sincronizar os dados dele.
//
//  Body: { totalAch, platCount, rareCount, gameCount, personaName, avatarUrl, profileUrl }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/leaderboard/register/:steamId', requireAuth, async (req, res) => {
  const { steamId } = req.params;
  const { totalAch, platCount, rareCount, gameCount, personaName, avatarUrl, profileUrl } = req.body;

  if (typeof totalAch !== 'number' || typeof platCount !== 'number' || typeof gameCount !== 'number') {
    return res.status(400).json({ error: 'Body inválido: totalAch, platCount e gameCount são obrigatórios' });
  }

  try {
    // Busca dados atualizados do jogador na Steam para ter infos frescas
    let playerData;
    try {
      const summaryData = await steamGet('/ISteamUser/GetPlayerSummaries/v2/', { steamids: steamId });
      const p = summaryData?.response?.players?.[0];
      if (p) {
        playerData = {
          steamId: p.steamid,
          personaName: p.personaname,
          avatarUrl: p.avatarfull,
          profileUrl: p.profileurl,
          isPrivate: p.communityvisibilitystate < 3,
        };
      }
    } catch {
      // Se falhar, usa os dados do body
      playerData = {
        steamId,
        personaName: personaName || 'Unknown',
        avatarUrl: avatarUrl || '',
        profileUrl: profileUrl || `https://steamcommunity.com/profiles/${steamId}`,
        isPrivate: false,
      };
    }

    db.upsertPlayer({
      ...playerData,
      totalAch,
      platCount,
      rareCount: rareCount ?? 0,
      gameCount,
    });

    // Invalida cache
    _friendsCache.clear();

    console.log(`[Leaderboard] Jogador sincronizado: ${playerData.personaName} (${steamId}): ${totalAch} ach, ${platCount} plat`);
    return res.json({ ok: true });
  } catch (err) {
    console.error('[Leaderboard] Erro ao sincronizar jogador:', err.message);
    return res.status(500).json({ error: 'Erro interno ao salvar stats' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/player/:steamId/friends
//  Retorna a lista de amigos de qualquer jogador (para mostrar no perfil).
//  Se o perfil for privado, retorna array vazio.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/player/:steamId/friends', requireAuth, async (req, res) => {
  const { steamId } = req.params;

  try {
    // 1. Busca lista de amigos do Steam
    let friendIds = [];
    try {
      const fData = await steamGet('/ISteamUser/GetFriendList/v1/', {
        steamid: steamId,
        relationship: 'friend',
      });
      friendIds = (fData?.friendslist?.friends ?? [])
        .map((f) => f.steamid)
        .slice(0, 100); // Limita a 100 amigos
    } catch {
      // Perfil privado ou sem amigos visíveis
      return res.json([]);
    }

    if (friendIds.length === 0) return res.json([]);

    // 2. Busca informações dos amigos (nome, avatar)
    const summaryData = await steamGet('/ISteamUser/GetPlayerSummaries/v2/', {
      steamids: friendIds.join(','),
    });
    const players = summaryData?.response?.players ?? [];

    // 3. Busca stats dos amigos que estão no SQLite (leaderboard)
    const friendIdsInDb = db.getPlayersByIds ? db.getPlayersByIds(friendIds) : [];

    // 4. Monta resultado combinando Steam + SQLite
    const result = players.map((p) => {
      const dbData = friendIdsInDb.find((x) => x.steamId === p.steamid);
      return {
        steamId: p.steamid,
        personaName: p.personaname,
        avatarUrl: p.avatarfull,
        profileUrl: p.profileurl,
        isPrivate: p.communityvisibilitystate < 3,
        // Stats do SQLite (se estiver registrado)
        totalAch: dbData?.totalAch ?? null,
        platCount: dbData?.platCount ?? null,
        gameCount: dbData?.gameCount ?? null,
      };
    });

    return res.json(result);
  } catch (err) {
    console.error('[Player] Erro ao buscar amigos:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/leaderboard/global?page=1&limit=50
//  Retorna o ranking global de todos os usuários registrados no SQLite.
//  Paginado. Inclui flag isMe para o usuário logado.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/leaderboard/global', requireAuth, (req, res) => {
  const page  = Math.max(1, parseInt(req.query.page  ?? '1',  10));
  const limit = Math.min(100, Math.max(10, parseInt(req.query.limit ?? '50', 10)));
  const mySteamId = req.user.steamId;

  try {
    const result = db.getGlobalLeaderboard(page, limit);

    // Injeta flag isMe e garante rank correto
    result.entries = result.entries.map((e, i) => ({
      ...e,
      rank: (page - 1) * limit + i + 1,
      isMe: e.steamId === mySteamId,
    }));

    return res.json(result);
  } catch (err) {
    console.error('[Leaderboard] Erro ao buscar global:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/leaderboard/friends
//  Retorna o ranking dos amigos do Steam + o próprio usuário.
//
//  Estratégia:
//    1. Busca lista de amigos no Steam (pode falhar se perfil privado)
//    2. Para amigos que estão no SQLite → usa dados do SQLite (ach real)
//    3. Para amigos que NÃO estão no SQLite → busca gameCount no Steam API
//    4. Ordena: registrados por totalAch desc, não-registrados por gameCount desc
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/leaderboard/friends', requireAuth, async (req, res) => {
  const mySteamId = req.user.steamId;

  // Serve cache se estiver fresco
  if (isFriendsCacheFresh(mySteamId)) {
    return res.json(getFriendsCache(mySteamId).data);
  }

  try {
    // 1. Lista de amigos (silencia se perfil privado)
    let friendIds = [];
    try {
      const fData = await steamGet('/ISteamUser/GetFriendList/v1/', {
        steamid: mySteamId, relationship: 'friend',
      });
      friendIds = (fData?.friendslist?.friends ?? [])
        .map(f => f.steamid)
        .slice(0, 99);
    } catch { /* perfil privado — só o próprio usuário */ }

    const allIds = [mySteamId, ...friendIds];

    // 2. Busca summaries no Steam (1 request para todos)
    const summaryData = await steamGet('/ISteamUser/GetPlayerSummaries/v2/', {
      steamids: allIds.join(','),
    });
    const steamPlayers = summaryData?.response?.players ?? [];

    // 3. Quem já está no SQLite?
    const dbEntries  = db.getPlayersByIds(allIds);
    const dbMap      = new Map(dbEntries.map(e => [e.steamId, e]));

    // 4. Para os que não estão no SQLite, busca gameCount em paralelo (pool de 6)
    const notInDb    = steamPlayers.filter(p => !dbMap.has(p.steamid));
    const gameCountMap = new Map();

    const POOL = 6;
    let idx = 0;
    async function worker() {
      while (idx < notInDb.length) {
        const p = notInDb[idx++];
        try {
          const gData = await steamGet('/IPlayerService/GetOwnedGames/v1/', {
            steamid: p.steamid, include_appinfo: 0, include_played_free_games: 1,
          });
          gameCountMap.set(p.steamid, gData?.response?.games?.length ?? 0);
        } catch {
          gameCountMap.set(p.steamid, 0);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(POOL, notInDb.length) }, worker));

    // 5. Monta lista unificada
    const entries = steamPlayers.map(p => {
      const dbEntry = dbMap.get(p.steamid);
      if (dbEntry) {
        return {
          ...dbEntry,
          personaName: p.personaname, // sempre usa nome fresco do Steam
          avatarUrl  : p.avatarfull,
          isMe       : p.steamid === mySteamId,
          isPrivate  : p.communityvisibilitystate < 3,
        };
      }
      return {
        steamId     : p.steamid,
        personaName : p.personaname,
        avatarUrl   : p.avatarfull,
        profileUrl  : p.profileurl,
        isPrivate   : p.communityvisibilitystate < 3,
        isMe        : p.steamid === mySteamId,
        totalAch    : null,
        platCount   : null,
        rareCount   : null,
        gameCount   : gameCountMap.get(p.steamid) ?? 0,
        registeredAt: null,
        rank        : null,
      };
    });

    // 6. Sort: apenas por totalAch (conquistas). Registrados primeiro, não-registrados no final.
    entries.sort((a, b) => {
      const aHas = a.totalAch != null;
      const bHas = b.totalAch != null;
      if (aHas && bHas)  return b.totalAch - a.totalAch;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return  1;
      return 0; // Não-registrados mantêm ordem original
    });

    // 7. Atribui ranks
    const ranked = entries.map((e, i) => ({ ...e, rank: i + 1 }));

    setFriendsCache(mySteamId, ranked);
    return res.json(ranked);
  } catch (err) {
    console.error('[Leaderboard] Erro amigos:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/leaderboard/search?q=nome
//  Busca jogadores pelo nome dentro do SQLite.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/leaderboard/search', requireAuth, (req, res) => {
  const q = (req.query.q ?? '').trim();
  if (!q || q.length < 2) return res.json([]);

  const mySteamId = req.user.steamId;

  try {
    const results = db.searchPlayers(q).map((e, i) => ({
      ...e,
      rank: i + 1,
      isMe: e.steamId === mySteamId,
    }));
    return res.json(results);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/leaderboard/me/rank
//  Retorna a posição global do usuário logado.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/leaderboard/me/rank', requireAuth, (req, res) => {
  try {
    const rank = db.getGlobalRank(req.user.steamId);
    return res.json({ rank });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Atualiza o perfil do usuário no SQLite a cada login
//  (coloque dentro do callback do passport.use, depois de done(null, user))
//
//  Adicione no bloco passport.use de Steam, dentro do try, DEPOIS do done:
//
//    const user = await getPlayerSummary(profile.id);
//    // ── Mantém perfil fresco no SQLite ──
//    db.updateProfile({
//      steamId    : user.steamId,
//      personaName: user.personaName,
//      avatarUrl  : user.avatarUrl,
//      profileUrl : user.profileUrl,
//      isPrivate  : user.communityVisibilityState < 3,
//    });
//    done(null, user);
// ─────────────────────────────────────────────────────────────────────────────
