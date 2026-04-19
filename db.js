// =============================================================================
//  db.js
//
//  Modulo MySQL para o leaderboard global.
//
//  Variaveis de ambiente aceitas:
//    DATABASE_URL / MYSQL_URL / JAWSDB_URL / CLEARDB_DATABASE_URL
//    ou MYSQL_HOST, MYSQL_PORT, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
// =============================================================================

'use strict';

const mysql = require('mysql2/promise');

const DEFAULT_DB_NAME = 'steam_trophy_tracker';
const DB_URL =
  process.env.DATABASE_URL ||
  process.env.MYSQL_URL ||
  process.env.JAWSDB_URL ||
  process.env.CLEARDB_DATABASE_URL ||
  null;

const pool = mysql.createPool(buildPoolConfig());
let ready = null;

function buildPoolConfig() {
  const connectionLimit = parseInt(
    process.env.MYSQL_CONNECTION_LIMIT || process.env.DB_CONNECTION_LIMIT || '10',
    10
  );

  const config = {
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    charset: 'utf8mb4',
  };

  if (DB_URL) {
    const url = new URL(DB_URL);
    config.host = url.hostname;
    config.port = parseInt(url.port || '3306', 10);
    config.user = decodeURIComponent(url.username || '');
    config.password = decodeURIComponent(url.password || '');
    config.database = decodeURIComponent(url.pathname.replace(/^\//, '') || DEFAULT_DB_NAME);

    for (const [key, value] of url.searchParams.entries()) {
      if (key === 'ssl') continue;
      config[key] = value;
    }

    applySslConfig(config, url.searchParams.get('ssl'));
    return config;
  }

  config.host = process.env.MYSQL_HOST || process.env.DB_HOST || 'localhost';
  config.port = parseInt(process.env.MYSQL_PORT || process.env.DB_PORT || '3306', 10);
  config.user = process.env.MYSQL_USER || process.env.DB_USER || 'root';
  config.password = process.env.MYSQL_PASSWORD ?? process.env.DB_PASSWORD ?? '';
  config.database = process.env.MYSQL_DATABASE || process.env.DB_NAME || DEFAULT_DB_NAME;

  applySslConfig(config, process.env.MYSQL_SSL || process.env.DB_SSL);
  return config;
}

function applySslConfig(config, sslValue) {
  if (!sslValue || sslValue === 'false' || sslValue === '0') return;

  config.ssl = {
    rejectUnauthorized:
      process.env.MYSQL_SSL_REJECT_UNAUTHORIZED !== 'false' &&
      process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
  };
}

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      steam_id      VARCHAR(32)  NOT NULL,
      persona_name  VARCHAR(255) NOT NULL,
      avatar_url    TEXT         NOT NULL,
      profile_url   TEXT         NOT NULL,
      is_private    TINYINT(1)   NOT NULL DEFAULT 0,
      total_ach     INT          NOT NULL DEFAULT 0,
      plat_count    INT          NOT NULL DEFAULT 0,
      rare_count    INT          NOT NULL DEFAULT 0,
      game_count    INT          NOT NULL DEFAULT 0,
      updated_at    BIGINT       NOT NULL,
      PRIMARY KEY (steam_id),
      INDEX idx_players_total_ach (total_ach, updated_at),
      INDEX idx_players_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureReady() {
  if (!ready) {
    ready = initSchema().catch((err) => {
      console.error('[MySQL] Falha ao inicializar schema:', err.message);
      throw err;
    });
  }

  await ready;
}

/**
 * Upserta stats completos do jogador.
 * Chamado pelo endpoint POST /api/leaderboard/register.
 */
async function upsertPlayer(data) {
  await ensureReady();

  await pool.execute(
    `
      INSERT INTO players
        (steam_id, persona_name, avatar_url, profile_url, is_private,
         total_ach, plat_count, rare_count, game_count, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        persona_name = VALUES(persona_name),
        avatar_url   = VALUES(avatar_url),
        profile_url  = VALUES(profile_url),
        is_private   = VALUES(is_private),
        total_ach    = VALUES(total_ach),
        plat_count   = VALUES(plat_count),
        rare_count   = VALUES(rare_count),
        game_count   = VALUES(game_count),
        updated_at   = VALUES(updated_at)
    `,
    [
      data.steamId,
      data.personaName,
      data.avatarUrl ?? '',
      data.profileUrl ?? '',
      data.isPrivate ? 1 : 0,
      data.totalAch ?? 0,
      data.platCount ?? 0,
      data.rareCount ?? 0,
      data.gameCount ?? 0,
      Date.now(),
    ]
  );
}

/**
 * Atualiza apenas o perfil (sem sobrescrever stats).
 * Chamado no login para manter avatar/nome frescos.
 */
async function updateProfile(data) {
  await ensureReady();

  await pool.execute(
    `
      INSERT INTO players
        (steam_id, persona_name, avatar_url, profile_url, is_private,
         total_ach, plat_count, rare_count, game_count, updated_at)
      VALUES
        (?, ?, ?, ?, ?, 0, 0, 0, 0, ?)
      ON DUPLICATE KEY UPDATE
        persona_name = IF(updated_at < VALUES(updated_at), VALUES(persona_name), persona_name),
        avatar_url   = IF(updated_at < VALUES(updated_at), VALUES(avatar_url), avatar_url),
        profile_url  = IF(updated_at < VALUES(updated_at), VALUES(profile_url), profile_url),
        is_private   = IF(updated_at < VALUES(updated_at), VALUES(is_private), is_private)
    `,
    [
      data.steamId,
      data.personaName,
      data.avatarUrl ?? '',
      data.profileUrl ?? '',
      data.isPrivate ? 1 : 0,
      Date.now(),
    ]
  );
}

/**
 * Retorna pagina do leaderboard global.
 * @param {number} page  - 1-based
 * @param {number} limit - itens por pagina (default 50)
 * @returns {Promise<{ entries: object[], total: number, page: number, pages: number }>}
 */
async function getGlobalLeaderboard(page = 1, limit = 50) {
  await ensureReady();

  const offset = (page - 1) * limit;
  const [entries] = await pool.execute(
    `
      SELECT
        steam_id,
        persona_name,
        avatar_url,
        profile_url,
        is_private,
        total_ach,
        plat_count,
        rare_count,
        game_count,
        updated_at
      FROM players
      WHERE total_ach > 0
      ORDER BY total_ach DESC, updated_at DESC
      LIMIT ? OFFSET ?
    `,
    [limit, offset]
  );
  const [[{ total }]] = await pool.execute(
    'SELECT COUNT(*) AS total FROM players WHERE total_ach > 0'
  );

  return {
    entries: entries.map(rowToEntry),
    total,
    page,
    pages: Math.ceil(total / limit),
  };
}

/**
 * Retorna entradas do leaderboard para um conjunto especifico de steamIds.
 * Usado pelo leaderboard de amigos.
 * @param {string[]} steamIds
 * @returns {Promise<object[]>}
 */
async function getPlayersByIds(steamIds) {
  await ensureReady();
  if (!steamIds.length) return [];

  const placeholders = steamIds.map(() => '?').join(', ');
  const [rows] = await pool.execute(
    `
      SELECT
        steam_id, persona_name, avatar_url, profile_url, is_private,
        total_ach, plat_count, rare_count, game_count, updated_at
      FROM players
      WHERE steam_id IN (${placeholders})
    `,
    steamIds
  );

  return rows.map(rowToEntry);
}

/**
 * Busca jogadores por nome.
 * @param {string} query
 * @returns {Promise<object[]>}
 */
async function searchPlayers(query) {
  await ensureReady();

  const [rows] = await pool.execute(
    `
      SELECT
        steam_id, persona_name, avatar_url, profile_url, is_private,
        total_ach, plat_count, rare_count, game_count, updated_at
      FROM players
      WHERE total_ach > 0
        AND LOWER(persona_name) LIKE CONCAT('%', LOWER(?), '%')
      ORDER BY total_ach DESC
      LIMIT 50
    `,
    [query]
  );

  return rows.map(rowToEntry);
}

/**
 * Posicao global de um steamId.
 * @param {string} steamId
 * @returns {Promise<number | null>}
 */
async function getGlobalRank(steamId) {
  await ensureReady();

  const [players] = await pool.execute(
    'SELECT * FROM players WHERE steam_id = ?',
    [steamId]
  );
  const player = players[0];
  if (!player || !player.total_ach) return null;

  const [[{ rank }]] = await pool.execute(
    `
      SELECT COUNT(*) + 1 AS rank
      FROM players
      WHERE total_ach > ?
         OR (total_ach = ? AND updated_at < ?)
    `,
    [player.total_ach, player.total_ach, player.updated_at]
  );

  return rank;
}

async function close() {
  await pool.end();
}

function rowToEntry(row) {
  return {
    steamId     : row.steam_id,
    personaName : row.persona_name,
    avatarUrl   : row.avatar_url,
    profileUrl  : row.profile_url,
    isPrivate   : row.is_private === 1 || row.is_private === true,
    totalAch    : row.total_ach   > 0 ? row.total_ach   : null,
    platCount   : row.plat_count  > 0 ? row.plat_count  : null,
    rareCount   : row.rare_count  > 0 ? row.rare_count  : null,
    gameCount   : row.game_count,
    registeredAt: row.updated_at,
    rank        : row.rank ?? null,
  };
}

module.exports = {
  upsertPlayer,
  updateProfile,
  getGlobalLeaderboard,
  getPlayersByIds,
  searchPlayers,
  getGlobalRank,
  close,
  _pool: pool,
  _ready: ensureReady,
};
