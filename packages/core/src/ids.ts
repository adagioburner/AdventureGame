/**
 * Branded identifiers. Node ids are plain integers so the graph can be stored
 * in flat arrays indexed by id — the MCTS rollouts (§9) touch these in tight
 * loops, and the remoteness harness (§5.1) runs 100 full-map walks.
 */
declare const nodeIdBrand: unique symbol;
declare const playerIdBrand: unique symbol;
declare const gameIdBrand: unique symbol;
declare const userIdBrand: unique symbol;

export type NodeId = number & { readonly [nodeIdBrand]: true };
export type PlayerId = string & { readonly [playerIdBrand]: true };
export type GameId = string & { readonly [gameIdBrand]: true };
export type UserId = string & { readonly [userIdBrand]: true };

export const asNodeId = (n: number): NodeId => n as NodeId;
export const asPlayerId = (s: string): PlayerId => s as PlayerId;
export const asGameId = (s: string): GameId => s as GameId;
export const asUserId = (s: string): UserId => s as UserId;

/** 1-based seat number. Turn order is fixed at game start (§6). */
export type Seat = number;

// deliberate type error to verify branch protection
const __verifyProtection: number = "not a number";
