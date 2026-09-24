import { useEffect, useMemo, useRef, useState } from 'react';
import { decodeServerMessage, encodeMessage, type ClientMessage, type ServerMessage } from '@adventure/protocol';

export type ChannelStatus = 'connecting' | 'open' | 'reconnecting';

export interface Channel {
  readonly status: ChannelStatus;
  /** Sends if the socket is open; `false` if it is not, and nothing was sent. */
  send(message: ClientMessage): boolean;
}

/** The longest wait between two tries to reconnect. */
const MAX_RETRY_MS = 10_000;

/**
 * One of the site's sockets, kept open: a socket that drops is opened again,
 * waiting a little longer each time, and the server sends the whole list or
 * the whole game on every connect, so nothing is lost in between.
 *
 * `onRefused` hears of a try that closed before it opened, which is how a
 * login the server no longer knows shows up; the page checks and logs out.
 * `url` null keeps no socket.
 */
export function useChannel(url: string | null, onMessage: (message: ServerMessage) => void, onRefused?: () => void): Channel {
  const [status, setStatus] = useState<ChannelStatus>('connecting');
  const socket = useRef<WebSocket | null>(null);
  const latest = useRef({ onMessage, onRefused });
  latest.current = { onMessage, onRefused };

  useEffect(() => {
    if (url === null) return;
    let disposed = false;
    let tries = 0;
    let retry: number | undefined;
    setStatus('connecting');

    const open = (): void => {
      const ws = new WebSocket(url);
      let opened = false;
      socket.current = ws;
      ws.addEventListener('open', () => {
        opened = true;
        tries = 0;
        setStatus('open');
      });
      ws.addEventListener('message', (event) => {
        let message: ServerMessage;
        try {
          message = decodeServerMessage(String(event.data));
        } catch {
          return;
        }
        latest.current.onMessage(message);
      });
      ws.addEventListener('close', () => {
        if (socket.current === ws) socket.current = null;
        if (disposed) return;
        if (!opened) latest.current.onRefused?.();
        setStatus('reconnecting');
        retry = window.setTimeout(open, Math.min(MAX_RETRY_MS, 500 * 2 ** tries++));
      });
    };
    open();

    return () => {
      disposed = true;
      window.clearTimeout(retry);
      socket.current?.close();
      socket.current = null;
    };
  }, [url]);

  return useMemo(
    () => ({
      status,
      send: (message: ClientMessage) => {
        const ws = socket.current;
        if (ws === null || ws.readyState !== WebSocket.OPEN) return false;
        ws.send(encodeMessage(message));
        return true;
      },
    }),
    [status],
  );
}
