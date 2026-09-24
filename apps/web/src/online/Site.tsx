import { useCallback, useEffect, useState } from 'react';
import { asGameId, type GameId } from '@adventure/core';
import { App } from '../page/App.tsx';
import { toNewGameSetup, type LocalSetup } from '../setup/local.ts';
import { createGame, logOut, saveLogin, savedLogin, whoAmI, type Login } from './api.ts';
import { GameListScreen } from './GameListScreen.tsx';
import { LoginScreen } from './LoginScreen.tsx';
import { OnlineGameScreen } from './OnlineGameScreen.tsx';
import './site.css';

/**
 * The online site (docs/IMPLEMENTATION_PLAN.md phase 6): the pages the Worker
 * serves at its own address, up to the start of a game.
 *
 *   /             the login page, or once logged in the game list
 *   /games/<id>   one game: its setup, and once started the map
 *   /hotseat      a game on this device: the one setup screen with "Play online"
 *                 off (Q51), from the login page's "Play on one device" (Q48, 1)
 *                 or by turning "Play online" off; logged in, the switch is there
 *
 * A game's address works before logging in too: the login page shows first,
 * then the game.
 */
type Route = { readonly page: 'home' } | { readonly page: 'game'; readonly gameId: GameId } | { readonly page: 'hotseat' };

function routeOf(pathname: string): Route {
  if (pathname === '/hotseat') return { page: 'hotseat' };
  const game = /^\/games\/([a-z0-9]{4,32})\/?$/.exec(pathname)?.[1];
  return game === undefined ? { page: 'home' } : { page: 'game', gameId: asGameId(game) };
}

export function Site() {
  const [route, setRoute] = useState<Route>(() => routeOf(window.location.pathname));
  const [login, setLogin] = useState<Login | null>(savedLogin);
  // [Q51, 25] A stored game's setup, carried here when "Play online" is turned off.
  const [carried, setCarried] = useState<LocalSetup | undefined>(undefined);

  useEffect(() => {
    const onPop = (): void => setRoute(routeOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    document.title = route.page === 'hotseat' ? 'Adventure Hot Seat' : 'Adventure';
  }, [route]);

  const go = useCallback((path: string): void => {
    window.history.pushState(null, '', path);
    const next = routeOf(window.location.pathname);
    // A carried setup is for the one visit to the game on this device it was carried to.
    if (next.page !== 'hotseat') setCarried(undefined);
    setRoute(next);
  }, []);

  const forget = useCallback((): void => {
    saveLogin(null);
    setLogin(null);
  }, []);

  // A socket that will not open may mean the server has forgotten this login
  // (it lasted its 30 days, or it logged out elsewhere). Ask, and log out here
  // only if the server says so; a server that can't be reached keeps the login.
  const token = login?.token ?? null;
  const checkLogin = useCallback((): void => {
    if (token === null) return;
    whoAmI(token).then(
      (user) => {
        if (user === null) forget();
      },
      () => undefined,
    );
  }, [token, forget]);

  useEffect(checkLogin, [checkLogin]);

  if (route.page === 'hotseat') {
    // [Q51, 25, 26 and 29] Logged in, the setup screen has "Play online", and
    // the top bar the way back to the game list.
    return (
      <App
        carried={carried}
        playOnline={
          login === null
            ? undefined
            : async (setup, seed) => {
                const gameId = await createGame(login.token, `${login.user.displayName}’s game`, toNewGameSetup(setup, seed));
                go(`/games/${gameId}`);
              }
        }
        barExtra={
          login === null ? null : (
            <button className="btn" type="button" onClick={() => go('/')}>
              Your games
            </button>
          )
        }
      />
    );
  }

  if (login === null) {
    return (
      <LoginScreen
        onLogin={(next) => {
          saveLogin(next);
          setLogin(next);
        }}
        onHotseat={() => go('/hotseat')}
      />
    );
  }

  const leave = (): void => {
    void logOut(login.token);
    forget();
    go('/');
  };

  return route.page === 'game' ? (
    <OnlineGameScreen
      key={route.gameId}
      gameId={route.gameId}
      login={login}
      onBack={() => go('/')}
      onRefused={checkLogin}
      onGoLocal={(setup, seed) => {
        go(`/hotseat?seed=${encodeURIComponent(seed)}`);
        setCarried(setup);
      }}
    />
  ) : (
    <GameListScreen
      login={login}
      onOpen={(gameId) => go(`/games/${gameId}`)}
      onLogOut={leave}
      onRefused={checkLogin}
    />
  );
}
