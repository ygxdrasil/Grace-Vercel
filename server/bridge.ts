import {randomBytes, randomUUID, timingSafeEqual} from 'node:crypto';
import {Document} from './store/index';

/**
 * The way into your living room.
 *
 * Grace runs in a data centre. A PlayStation answers to nothing but the local
 * network — the wake packet is a UDP broadcast, and no amount of cloud will
 * put her on your Wi-Fi. So a small program runs on the laptop that is already
 * on in the room, and that program is her hands.
 *
 * It reaches out to her rather than the other way round, which matters: there
 * is no port to forward, no router to reconfigure, and nothing on your home
 * network is listening for anything from outside. She leaves an instruction;
 * the laptop picks it up on its next look and reports back what happened.
 *
 * The one credential involved is a token generated here. It is shown in full
 * exactly once, in the interface, because it has to be copied onto the laptop —
 * unlike every other key she holds, which is never echoed back at all.
 */

export type BridgeAction =
  | 'wake'
  | 'sleep'
  | 'status'
  | 'open'
  | 'lock'
  /*
   * Her hands on the machine, not only in the room.
   *
   * The same channel carries these, and that is exactly why they are safe to
   * have at all: the laptop reaches out to her, so nothing on the home network
   * is listening for anything, and an instruction only ever exists because the
   * machine went and asked whether there was one.
   */
  | 'ls'
  | 'read'
  | 'write'
  | 'remove'
  | 'shell';

export interface Command {
  id: string;
  action: BridgeAction;
  /** What the action is about: an address, a path, or a command line. */
  arg?: string;
  /** What to write — the one action that carries content of its own. */
  body?: string;
  /** Permission to land on top of something that already exists. */
  replace?: boolean;
  at: string;
  /** Set when the laptop has taken it, so it is never run twice. */
  claimedAt?: string;
  doneAt?: string;
  ok?: boolean;
  detail?: string;
}

export interface ConsoleState {
  found: boolean;
  /** "AWAKE" or "STANDBY", as the console itself reports it. */
  status: string | null;
  name: string | null;
  address: string | null;
  at: string;
}

interface BridgeDoc {
  token: string | null;
  queue: Command[];
  state: ConsoleState | null;
  /** When the laptop last made contact. */
  seenAt: string | null;
}

const store = new Document<BridgeDoc>('bridge', () => ({
  token: null,
  queue: [],
  state: null,
  seenAt: null,
}));

/** A command older than this was never picked up, and never will be. */
const STALE_MS = 2 * 60 * 1000;

/** How long since the laptop checked in before she calls it offline. */
const ABSENT_MS = 90 * 1000;

export async function bridgeToken(): Promise<string> {
  const current = await store.read();
  if (current.token) return current.token;

  const token = randomBytes(24).toString('base64url');
  await store.write({...current, token});
  return token;
}

/**
 * Replaces the token, which stops the laptop dead until it is given the new one.
 *
 * The phone's token had this from the start and this one did not, which was an
 * oversight rather than a decision. A credential you cannot change is one you
 * have to be perfect about, and nobody is: it gets read aloud over a shoulder,
 * pasted into the wrong window, left in a screenshot. The answer is to make
 * replacing it a two-second job rather than to hope.
 */
export async function rollBridgeToken(): Promise<string> {
  const token = randomBytes(24).toString('base64url');
  await store.update((current) => ({...current, token}));
  return token;
}

/** Constant-time, because this is the only thing standing in front of it. */
async function tokenMatches(offered: string): Promise<boolean> {
  const real = await bridgeToken();
  const left = Buffer.from(offered);
  const right = Buffer.from(real);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function bridgeStatus(): Promise<{
  online: boolean;
  seenAt: string | null;
  state: ConsoleState | null;
}> {
  const current = await store.read();
  const seen = current.seenAt ? new Date(current.seenAt).getTime() : 0;
  return {
    online: Date.now() - seen < ABSENT_MS,
    seenAt: current.seenAt,
    state: current.state,
  };
}

/** Leaves an instruction for the laptop, and returns its id to wait on. */
export async function enqueue(
  action: BridgeAction,
  arg?: string,
  extra: {body?: string; replace?: boolean} = {},
): Promise<string> {
  const id = randomUUID();
  const now = Date.now();

  await store.update((current) => ({
    ...current,
    queue: [
      // Anything nobody collected is not worth carrying, and a queue that only
      // grows is a console that suddenly does five things at once.
      ...current.queue.filter((command) => now - new Date(command.at).getTime() < STALE_MS),
      {
        id,
        action,
        ...(arg ? {arg} : {}),
        ...(extra.body !== undefined ? {body: extra.body} : {}),
        ...(extra.replace ? {replace: true} : {}),
        at: new Date(now).toISOString(),
      },
    ],
  }));

  return id;
}

/**
 * Waits for the laptop to report back on one instruction.
 *
 * She has to be able to say what actually happened rather than that she asked.
 * If the laptop is quiet, that is an answer too, and a truthful one.
 */
export async function awaitResult(
  id: string,
  patienceMs = 12_000,
): Promise<Command | null> {
  const until = Date.now() + patienceMs;

  while (Date.now() < until) {
    const current = await store.read();
    const found = current.queue.find((command) => command.id === id);
    if (found?.doneAt) return found;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return null;
}

/** The laptop, asking whether there is anything to do. */
export async function claim(
  token: string,
  state: ConsoleState | null,
): Promise<{ok: boolean; commands: Command[]}> {
  if (!(await tokenMatches(token))) return {ok: false, commands: []};

  const now = new Date().toISOString();
  let taken: Command[] = [];

  await store.update((current) => {
    taken = current.queue.filter((command) => !command.claimedAt && !command.doneAt);
    return {
      ...current,
      seenAt: now,
      state: state ?? current.state,
      queue: current.queue.map((command) =>
        taken.some((one) => one.id === command.id)
          ? {...command, claimedAt: now}
          : command,
      ),
    };
  });

  return {ok: true, commands: taken};
}

/** The laptop, saying what came of it. */
export async function report(
  token: string,
  results: {id: string; ok: boolean; detail: string}[],
): Promise<boolean> {
  if (!(await tokenMatches(token))) return false;

  const now = new Date().toISOString();
  await store.update((current) => ({
    ...current,
    seenAt: now,
    queue: current.queue.map((command) => {
      const result = results.find((one) => one.id === command.id);
      return result
        ? {...command, doneAt: now, ok: result.ok, detail: result.detail}
        : command;
    }),
  }));

  return true;
}
