import { useEffect, useMemo, useRef, useState } from 'react';
import {
  decodeServerMessage,
  encodeMessage,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_PING,
  HEARTBEAT_PONG,
  type ClientMessage,
  type ServerMessage,
} from '@adventure/protocol';

export type ChannelStatus = 'connecting' | 'open' | 'reconnecting';

export interface Channel {
  readonly status: ChannelStatus;
  /** Sends if the socket is open; `false` if it is not, and nothing was sent. */
  send(message: ClientMessage): boolean;
  /** Drops the socket and opens a new one, for a page that missed a message and needs the whole game again. */
  restart(): void;
}

/** The longest wait between two tries to reconnect. */
const MAX_RETRY_MS = 10_000;

/** How long a ping may go unanswered before the socket is taken for dead ([Q54, 31]). */
const PONG_WAIT_MS = 10_000;

/**
 * One of the site's sockets, kept open: a socket that drops is opened again,
 * waiting a little longer each time, and the server sends the whole list or
 * the whole game on every connect, so nothing is lost in between.
 *
 * `onRefused` hears of a try that closed before it opened, which is how a
 * login the server no longer knows shows up; the page checks and logs out.
 * `url` null keeps no socket.
 *
 * [Q54, 31] The heartbeat: every 20 seconds the page sends a ping, which the
 * server answers without waking the game, and which tells the game this page
 * is still there. A ping left unanswered for 10 seconds means the connection
 * has died without closing, as happens when a laptop sleeps or a phone
 * changes network, and the page drops it and opens a new one.
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
      let gone = false;
      let beat: number | undefined;
      let silence: number | undefined;
      socket.current = ws;
      // Once, whether the socket closed or was given up for dead: a dead one
      // may take a long while to report its close, so it is not waited for.
      const drop = (): void => {
        if (gone) return;
        gone = true;
        window.clearInterval(beat);
        window.clearTimeout(silence);
        if (socket.current === ws) socket.current = null;
        if (disposed) return;
        if (!opened) latest.current.onRefused?.();
        setStatus('reconnecting');
        retry = window.setTimeout(open, Math.min(MAX_RETRY_MS, 500 * 2 ** tries++));
      };
      ws.addEventListener('open', () => {
        opened = true;
        tries = 0;
        setStatus('open');
        beat = window.setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(HEARTBEAT_PING);
          window.clearTimeout(silence);
          silence = window.setTimeout(() => {
            drop();
            ws.close();
          }, PONG_WAIT_MS);
        }, HEARTBEAT_INTERVAL_MS);
      });
      ws.addEventListener('message', (event) => {
        if (gone) return;
        if (event.data === HEARTBEAT_PONG) {
          window.clearTimeout(silence);
          return;
        }
        let message: ServerMessage;
        try {
          message = decodeServerMessage(String(event.data));
        } catch {
          return;
        }
        latest.current.onMessage(message);
      });
      ws.addEventListener('close', drop);
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
      restart: () => {
        // Closing it reconnects, as any close does; the server sends everything again.
        socket.current?.close();
      },
    }),
    [status],
  );
}
