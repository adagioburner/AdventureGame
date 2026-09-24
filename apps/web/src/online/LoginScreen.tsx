import { useState } from 'react';
import { logIn, LoginRefused, register, type Login } from './api.ts';

interface LoginScreenProps {
  onLogin(login: Login): void;
  onHotseat(): void;
}

type Mode = 'login' | 'register';

const MODES: readonly { readonly mode: Mode; readonly label: string }[] = [
  { mode: 'login', label: 'Log in' },
  { mode: 'register', label: 'Register' },
];

/**
 * [Q48, 1 to 3] Log in or register with a username and a password, or play
 * hot seat on this device without an account. The rules are the server's
 * (`apps/server/src/auth/rules.ts`); a refusal shows the server's sentence.
 */
export function LoginScreen({ onLogin, onHotseat }: LoginScreenProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const registering = mode === 'register';

  const submit = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      onLogin(await (registering ? register : logIn)(username.trim(), password));
    } catch (error) {
      setProblem(error instanceof LoginRefused ? error.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  };

  return (
    <div className="shell">
      <header className="bar">
        <h1>Adventure</h1>
      </header>
      <main className="site-page">
        <form
          className="card site-card"
          aria-label={registering ? 'Register' : 'Log in'}
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy) void submit();
          }}
        >
          <div className="control-toggle" role="radiogroup" aria-label="Log in or register">
            {MODES.map((choice) => (
              <button
                key={choice.mode}
                type="button"
                role="radio"
                aria-checked={mode === choice.mode}
                onClick={() => {
                  setMode(choice.mode);
                  setProblem(null);
                }}
              >
                {choice.label}
              </button>
            ))}
          </div>
          <label className="field">
            <span>Username</span>
            <input
              name="username"
              value={username}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(event) => setUsername(event.target.value)}
            />
            {registering ? <small>3 to 20 letters, digits or underscores.</small> : null}
          </label>
          <label className="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              value={password}
              autoComplete={registering ? 'new-password' : 'current-password'}
              onChange={(event) => setPassword(event.target.value)}
            />
            {registering ? <small>At least 8 characters. A forgotten password can’t be reset.</small> : null}
          </label>
          {problem === null ? null : (
            <p className="problem" role="alert">
              {problem}
            </p>
          )}
          <button className="btn primary start" type="submit" disabled={busy || username.trim().length === 0 || password.length === 0}>
            {registering ? 'Create the account' : 'Log in'}
          </button>
          <hr />
          <button className="btn start" type="button" onClick={onHotseat}>
            Play on one device
          </button>
        </form>
      </main>
    </div>
  );
}
