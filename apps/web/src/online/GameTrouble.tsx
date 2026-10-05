import { Component, type ReactNode } from 'react';
import { GameTitle } from '../page/GameTitle.tsx';

interface GameTroubleProps {
  /** Back to the game list. */
  onBack(): void;
  readonly children: ReactNode;
}

/**
 * [991 A] An online game that could not be shown says so, where its map would
 * be, under the top bar with Games, instead of leaving the page dark. Andrei's
 * game of 2026-10-05 went dark: its map, made by a page from before an update,
 * had a site today's pictures do not cover, and nothing caught the error.
 * Worded and laid out as the map's own trouble message (Q86, 331).
 */
export class GameTrouble extends Component<GameTroubleProps, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="shell">
        <header className="bar">
          <GameTitle />
          <span className="seed-shown" />
          <button className="btn" type="button" onClick={this.props.onBack}>
            Games
          </button>
        </header>
        <main className="stage">
          <div className="overlay map-trouble" role="alert">
            <p>This game could not be shown. Reload the page to try again.</p>
            <button className="btn" type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </main>
      </div>
    );
  }
}
