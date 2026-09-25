import { asGameId, asUserId, type UserId } from '@adventure/core';
import type { GameSummary } from '@adventure/protocol';
import type { GameListing } from '@adventure/session';
import type { SqlLike } from './adapters/durable-object.ts';

/**
 * The game list (§6.1, [Q48, 5]): every game reports its row here, and each
 * logged-in user is sent the rows that concern them.
 */

/**
 * [Q48, 5] Your games, waiting, started or finished ([Q55, 36]), then the open
 * games waiting for players; newest first in each.
 */
export function gameListFor(user: UserId, listings: readonly GameListing[]): GameSummary[] {
  const newestFirst = [...listings].sort((a, b) => b.createdAt - a.createdAt);
  const mine = newestFirst.filter((listing) => listing.members.includes(user));
  const open = newestFirst.filter(
    (listing) => !listing.members.includes(user) && listing.phase === 'setup' && listing.seatsTaken < listing.seatsTotal,
  );
  return [...mine.map((listing) => summary(listing, true, user)), ...open.map((listing) => summary(listing, false, user))];
}

function summary(listing: GameListing, mine: boolean, user: UserId): GameSummary {
  return {
    gameId: listing.gameId,
    name: listing.name,
    gameMaster: listing.gameMaster,
    gameMasterName: listing.gameMasterName,
    phase: listing.phase,
    seatsTaken: listing.seatsTaken,
    seatsTotal: listing.seatsTotal,
    createdAt: listing.createdAt,
    // A row stored before games had a lifetime has none.
    endsAt: listing.endsAt ?? null,
    mine,
    yourTurn: listing.turnOf === user,
    result: listing.result ?? null,
  };
}

export interface ListingStore {
  all(): GameListing[];
  put(listing: GameListing): void;
  remove(gameId: string): void;
}

/** The rows in the lobby object's SQLite, one per game still on the list. */
export function createSqlListingStore(sql: SqlLike): ListingStore {
  sql.exec(`CREATE TABLE IF NOT EXISTS games (
    game_id TEXT PRIMARY KEY,
    listing TEXT NOT NULL
  )`);
  return {
    all: () =>
      sql
        .exec('SELECT listing FROM games')
        .toArray()
        .map((row) => revive(JSON.parse(String(row['listing'])) as GameListing)),
    put: (listing) => {
      sql.exec(
        'INSERT INTO games (game_id, listing) VALUES (?, ?) ON CONFLICT(game_id) DO UPDATE SET listing = excluded.listing',
        listing.gameId,
        JSON.stringify(listing),
      );
    },
    remove: (gameId) => {
      sql.exec('DELETE FROM games WHERE game_id = ?', gameId);
    },
  };
}

function revive(listing: GameListing): GameListing {
  return {
    ...listing,
    gameId: asGameId(listing.gameId),
    members: listing.members.map((id) => asUserId(id)),
    turnOf: listing.turnOf === undefined || listing.turnOf === null ? null : asUserId(listing.turnOf),
  };
}
