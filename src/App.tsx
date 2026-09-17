import {useEffect, useState} from 'react';
import {Boot} from './components/Boot';
import {Composer} from './components/Composer';
import {Core} from './components/hud/Core';
import {Head, Polar, Row} from './components/hud/Parts';
import {Files} from './components/Files';
import {Install} from './components/Install';
import {NotesPanel} from './components/Keep';
import {Lock} from './components/Lock';
import {Palette, type Command} from './components/Palette';
import {ProfilePanel} from './components/ProfilePanel';
import {Timers} from './components/Timers';
import {Transcript} from './components/Transcript';
import {VoiceCheck} from './components/VoiceCheck';
import {VoiceLock} from './components/VoiceLock';
import {bearingOf, bearingWarns} from '../shared/bearing';
import type {DayView} from '../shared/types';
import {useChats} from './hooks/useChats';
import {useFreshness} from './hooks/useFreshness';
import type {Mode} from './hooks/useGrace';
import {useGrace} from './hooks/useGrace';
import {useRooms} from './hooks/useRooms';
import * as api from './lib/api';

/**
 * Her, as an instrument panel.
 *
 * This replaced a sidebar, a tab bar, a transcript column and a slide-over —
 * a perfectly good chat application, and the same shape as every other chat
 * application. The transcript is still a keystroke away, because voice fails
 * in company and on bad connections and a panel with no way to type would be
 * a worse assistant wearing a better coat. It is simply no longer the thing
 * you are looking at.
 */

const STATE_LABEL: Record<Mode, string> = {
  offline: 'OFFLINE',
  idle: 'READY',
  waiting: 'STANDBY',
  listening: 'LISTENING',
  thinking: 'THINKING',
  speaking: 'SPEAKING',
};

const MODE_DOT: Record<Mode, string> = {
  offline: 'bg-rose-400/70',
  idle: 'bg-mist/40',
  waiting: 'bg-ice/60',
  listening: 'bg-ice',
  thinking: 'bg-ember/70',
  speaking: 'bg-ice',
};

/** Whether the desktop layout applies. Drives which dashboard mount exists. */
function useWide(): boolean {
  const [wide, setWide] = useState(
    () => window.matchMedia('(min-width: 1024px)').matches,
  );
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setWide(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return wide;
}

export default function App() {
  const grace = useGrace();
  const rooms = useRooms();
  const freshness = useFreshness();
  // Reloading rather than clearing: the conversation just switched to is
  // whatever the server has, and an emptied screen would be a guess at it.
  const chats = useChats(() => void grace.reload());
  const [panelOpen, setPanelOpen] = useState(false);
  const [soundCheckOpen, setSoundCheckOpen] = useState(false);
  const [voiceLockOpen, setVoiceLockOpen] = useState(false);
  /*
   * Whether the transcript is covering her.
   *
   * Closed by default, which is the whole change. It opens on its own the
   * moment you type, because typing is an unambiguous request to see what you
   * are typing into.
   */
  const [showTalk, setShowTalk] = useState(false);
  /*
   * Documents and notes.
   *
   * These were per-room panels in the layout that was deleted, and deleting
   * the layout took them with it — which mattered, because giving her a
   * document to read is something you do, not something you look at. The
   * panel shows nothing you do not need; it still has to let you hand her
   * things.
   */
  const [showFiles, setShowFiles] = useState(false);
  const [booting, setBooting] = useState(
    () => typeof sessionStorage !== 'undefined' && !sessionStorage.getItem('grace-booted'),
  );
  /*
   * How big she is drawn.
   *
   * Measured rather than fixed, because the panel runs on a phone and on a
   * television and a single number is wrong on both. Capped so she never
   * fills a large screen — the emptiness around her is doing as much work as
   * she is.
   */
  const [coreSize, setCoreSize] = useState(380);
  useEffect(() => {
    const fit = () =>
      setCoreSize(Math.max(200, Math.min(440, Math.min(window.innerWidth - 120, window.innerHeight - 320))));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  const [now, setNow] = useState(() => new Date());
  const [day, setDay] = useState<DayView | null>(null);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    const load = () => void api.fetchDay().then((next) => next && setDay(next));
    load();
    const refresh = window.setInterval(load, 120_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(refresh);
    };
  }, []);

  const {session, state, mode} = grace;
  const {opening} = grace;
  const {enter, open} = rooms;

  // She asked the browser for something. Moving room is instant; the pages are
  // attempted and whatever the browser refused comes back as links to tap.
  // The room's colour is a variable on the root, so every panel picks it up
  // without any of them knowing which room they are in.
  useEffect(() => {
    document.documentElement.dataset.room = rooms.current;
  }, [rooms.current]);

  useEffect(() => {
    if (!opening) return;
    if (opening.workspace) enter(opening.workspace);
    if (opening.urls.length > 0) open(opening.urls);
  }, [opening, enter, open]);

  /*
   * A question she has asked opens the transcript.
   *
   * She can ask before doing something — that is the whole confirmation
   * mechanism, and the answer is a set of buttons. With the transcript
   * closed those buttons are on a screen nobody is looking at: the panel
   * would show WAITING ON YOU and give you no way to answer, which is worse
   * than not asking at all, because the action then silently never happens.
   *
   * Placed here, above the early returns, because it is a hook. Put below
   * them it runs on some renders and not others, and React tears the whole
   * tree down with "rendered more hooks than during the previous render" —
   * which presents as a black screen, exactly like the last one.
   */
  const asked = grace.asked;
  useEffect(() => {
    if (asked) setShowTalk(true);
  }, [asked]);

  // Nothing of hers renders until the session is settled, so a lapsed cookie
  // can't flash her transcript on screen first. But an unreachable server used
  // to leave this as a blank glow forever, with nothing to explain it.
  if (session === null) {
    return (
      <div className="relative grid h-screen place-items-center overflow-hidden px-6">
        <div className="ambient pointer-events-none absolute inset-0 -z-10" />
        <div className="max-w-sm text-center">
          <h1 className="font-serif text-3xl tracking-wide text-slate-100">Grace</h1>
          {grace.error ? (
            <>
              <p className="mt-4 text-sm leading-relaxed text-mist/80">
                I can’t reach my own server, so I can’t tell you anything useful
                yet.
              </p>
              <p className="mt-3 rounded-lg border border-ember/25 bg-ember/10 px-3 py-2 text-left font-mono text-xs text-ember/90">
                {grace.error}
              </p>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="mt-4 rounded-full border border-edge px-4 py-1.5 text-sm text-mist transition hover:text-slate-200">
                Try again
              </button>
            </>
          ) : (
            <p className="mt-2 text-sm text-mist/60">One moment…</p>
          )}
        </div>
      </div>
    );
  }

  if (session === 'required' || session === 'misconfigured') {
    return <Lock status={session} onSubmit={grace.signIn} />;
  }

  /*
   * She is signed in, and her state has not arrived yet.
   *
   * This guard is why the screen went black. A signed-in session and a loaded
   * state are two different things — the cookie is settled locally, the state
   * is a request — and for the moment between them `state` is null. Every
   * readout below reads from it, so the first render threw, React unmounted
   * the tree, and what was left was the background colour.
   *
   * The old layout never hit this because it guarded each panel separately
   * with `state && (...)`. Consolidating the readouts into one place made the
   * guard a single point rather than a dozen, which is better — but the
   * single point has to actually exist.
   *
   * Drawn as the panel with nothing in it rather than as a spinner, so the
   * frame you see first is the frame you keep.
   */
  if (!state) {
    return (
      <div
        className="fixed inset-0 grid place-items-center bg-void"
        style={{fontFamily: 'var(--font-mono)'}}>
        <div className="field pointer-events-none" />
        <div className="vignette" />
        <div className="relative text-center">
          <p
            className="text-[0.78rem] tracking-[0.34em] text-ice"
            style={{textShadow: '0 0 12px rgb(var(--accent) / 0.5)'}}>
            G.R.A.C.E.
          </p>
          <p className="readout mt-3 text-mist/40">
            {grace.error ? 'NO LINK' : 'INITIALISING'}
          </p>
          {grace.error && (
            <p className="readout mt-4 max-w-xs normal-case tracking-normal text-ember/80">
              {grace.error}
            </p>
          )}
        </div>
      </div>
    );
  }

  const notice =
    mode === 'offline'
      ? 'No Gemini API key found. Set GEMINI_API_KEY where Grace is running, then restart or redeploy her.'
      : (grace.error ?? grace.ambient.error);

  /*
   * Everything the panel reads from, worked out once.
   *
   * Gathered here rather than inline so that the markup below is a layout and
   * nothing else. When a readout and the thing it reports are computed in the
   * same breath as the div that shows them, the two drift — and on a panel
   * built to be trusted, a number that is subtly wrong is worse than a number
   * that is missing.
   */
  const bearing = bearingOf({
    offline: mode === 'offline',
    listening: mode === 'waiting' || mode === 'listening',
    thinking: mode === 'thinking',
    speaking: mode === 'speaking',
    acting: Boolean(grace.live.doing),
    asking: Boolean(grace.asked),
  });
  const warnBearing = bearingWarns(bearing);
  const busyNow = mode === 'thinking' || mode === 'speaking' || Boolean(grace.live.doing);

  const onPool = state.spend.against === 'pool';
  const used = onPool ? state.spend.pool : state.spend.dollars;
  // Amber on pace rather than amount: half the credit gone is excellent in
  // December and alarming in September.
  const aheadOfPace =
    onPool && state.spend.elapsed !== null && state.spend.elapsed > 0.05
      ? used / state.spend.cap / state.spend.elapsed > 1.35
      : false;

  /** One press: she opens the microphone and closes it when you stop talking. */
  const talk = () => {
    if (grace.recorder.state === 'recording') grace.recorder.stop();
    else void grace.recorder.start();
  };


  // Everything the palette can reach. Rooms come from the server list, so a
  // room the user makes appears here for free.
  const commands: Command[] = [
    ...rooms.rooms.map((room) => ({
      id: `room:${room.id}`,
      label: `Go to ${room.name}`,
      hint: 'room',
      run: () => rooms.enter(room.id, true),
    })),
    {
      id: 'newchat',
      label: 'New conversation',
      hint: 'chat',
      run: () => void chats.start(),
    },
    ...chats.chats.slice(0, 8).map((chat) => ({
      id: `chat:${chat.id}`,
      label: chat.title,
      hint: 'chat',
      run: () => void chats.open(chat.id),
    })),
    {id: 'talk', label: 'Talk to Grace', hint: 'mic', run: talk},
    {
      id: 'mic',
      label: grace.micOn ? 'Stop always-listening' : 'Always-listen for “Grace”',
      hint: 'mic',
      run: () => grace.setMicOn(!grace.micOn),
    },
    {
      id: 'voice',
      label: grace.voiceOn ? 'Mute her voice' : 'Unmute her voice',
      hint: 'voice',
      run: () => grace.setVoiceOn(!grace.voiceOn),
    },
    {
      id: 'transcript',
      label: showTalk ? 'Hide the transcript' : 'Show the transcript',
      hint: 'view',
      run: () => setShowTalk((open) => !open),
    },
    {id: 'sound', label: 'Sound check', hint: 'audio', run: () => setSoundCheckOpen(true)},
    {
      id: 'voicelock',
      label: 'Only answer to me',
      hint: 'audio',
      run: () => setVoiceLockOpen(true),
    },
    {id: 'panel', label: 'Settings', hint: 'settings', run: () => setPanelOpen(true)},
  ];

  return (
    <div
      className="fixed inset-0 flex flex-col overflow-hidden bg-void"
      style={{fontFamily: 'var(--font-mono)'}}>
      {/* The room, behind everything. */}
      <div className="field pointer-events-none" />
      <div className="grid-veil" />
      <div className="grain" />
      <div className="vignette" />

      {/* ---- top rule ---- */}
      <header className="relative z-20 flex shrink-0 items-center justify-between gap-4 border-b border-ice/15 px-4 py-2">
        <div className="flex min-w-0 items-center gap-4">
          <span
            className="whitespace-nowrap text-[0.78rem] tracking-[0.34em] text-ice"
            style={{textShadow: '0 0 12px rgb(var(--accent) / 0.5)'}}>
            G.R.A.C.E.
          </span>
          <span className="readout flex shrink-0 items-center gap-1.5 text-mist/60">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: warnBearing ? 'var(--color-ember)' : 'rgb(var(--accent))',
                boxShadow: `0 0 6px ${
                  warnBearing ? 'var(--color-ember)' : 'rgb(var(--accent))'
                }`,
              }}
            />
            {STATE_LABEL[mode]}
          </span>
          <span className="readout hidden shrink-0 text-mist/30 md:inline">
            [{grace.live.available ? 'LIVE NATIVE AUDIO' : 'RELAY FALLBACK'}]
          </span>
          <span className="readout hidden shrink-0 text-mist/30 xl:inline">
            {rooms.room?.name?.toUpperCase() ?? 'GRACE'}
          </span>
        </div>

        <div className="flex shrink-0 items-baseline gap-4">
          <button
            type="button"
            onClick={() => setShowTalk((open) => !open)}
            className={`readout transition ${
              showTalk ? 'text-ice' : 'text-mist/40 hover:text-ice/70'
            }`}>
            TRANSCRIPT
          </button>
          <button
            type="button"
            onClick={() => setShowFiles((open) => !open)}
            className={`readout transition ${
              showFiles ? 'text-ice' : 'text-mist/40 hover:text-ice/70'
            }`}>
            FILES
          </button>
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            className="readout text-mist/40 transition hover:text-ice/70">
            CONFIG
          </button>
          <div className="text-right">
            <div className="text-lg leading-none tabular-nums text-ice">
              {now.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit'})}
            </div>
            <div className="readout mt-0.5 text-mist/30">
              {now.toISOString().slice(0, 10)}
            </div>
          </div>
        </div>
      </header>

      <div className="relative z-10 flex min-h-0 flex-1">
        {/* ---- left column ---- */}
        <aside className="hidden w-52 shrink-0 flex-col overflow-y-auto scroll-thin border-r border-ice/10 px-3 py-4 lg:flex">
          <Head>VITALS</Head>
          <Row
            label={onPool ? 'CREDIT' : 'MONTH'}
            value={`$${used.toFixed(3)}`}
            share={used / state.spend.cap}
            tone={aheadOfPace ? 'warn' : 'ice'}
          />
          {state.spend.elapsed !== null && (
            <Row
              label="WINDOW"
              value={`${Math.round(state.spend.elapsed * 100)}%`}
              share={state.spend.elapsed}
            />
          )}
          <Row label="REQUESTS" value={String(state.spend.requests)} />
          <Row
            label="VOICE"
            value={grace.live.available ? 'OPEN' : 'RELAY'}
            tone={grace.live.available ? 'live' : 'ice'}
          />
          <Row
            label="MEMORY"
            value={state.ready ? 'RUNNING' : 'IDLE'}
            tone={state.ready ? 'live' : 'ice'}
          />
          <Row label="STORE" value={state.storage.backend.toUpperCase()} />
          <Row label="CRYPTO" value={state.storage.encrypted ? 'AES-256' : 'NONE'} />

          <div className="mt-5">
            <Head>ROOMS</Head>
            {rooms.rooms.map((room) => (
              <button
                key={room.id}
                type="button"
                onClick={() => rooms.enter(room.id, true)}
                className={`readout block w-full truncate py-[3px] text-left transition ${
                  rooms.current === room.id
                    ? 'text-ice'
                    : 'text-mist/40 hover:text-ice/70'
                }`}>
                {rooms.current === room.id ? '> ' : '  '}
                {room.name}
              </button>
            ))}
          </div>

          <div className="mt-5">
            <Head>OUTSTANDING</Head>
            {day && day.reminders.length > 0 ? (
              <ul className="space-y-1">
                {day.reminders.slice(0, 6).map((one) => (
                  <li key={one.id} className="readout truncate text-mist/60" title={one.text}>
                    {one.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="readout text-mist/25">NONE</p>
            )}
          </div>

          <div className="mt-5">
            <Head>LOG</Head>
            {day && day.deeds.length > 0 ? (
              <ul className="space-y-1">
                {day.deeds.slice(0, 8).map((deed) => (
                  <li key={deed.id} className="readout truncate text-mist/35" title={deed.text}>
                    {deed.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="readout text-mist/25">QUIET</p>
            )}
          </div>
        </aside>

        {/* ---- centre ---- */}
        <main className="relative flex min-w-0 flex-1 flex-col items-center justify-center">
          {(
            [
              ['left-5 top-5', 'border-l border-t'],
              ['right-5 top-5', 'border-r border-t'],
              ['bottom-5 left-5', 'border-b border-l'],
              ['bottom-5 right-5', 'border-b border-r'],
            ] as const
          ).map(([place, edges]) => (
            <span
              key={place}
              aria-hidden
              className={`pointer-events-none absolute z-10 h-8 w-8 border-ice/25 ${place} ${edges}`}
            />
          ))}

          {showTalk ? (
            /*
             * The conversation, when it is asked for.
             *
             * Not the default view any more, and that is the point of the
             * whole rewrite. A wall of chat bubbles is what every assistant
             * looks like; the instrument is what this one looks like. The
             * transcript is still one keystroke away because voice fails —
             * in company, on a bad connection, when the microphone is
             * refused — and a panel with no way to type would be a worse
             * assistant wearing a better coat.
             */
            <div className="flex h-full w-full flex-col px-4 py-4">
              <Head>TRANSCRIPT</Head>
              <div className="min-h-0 flex-1 overflow-hidden">
                <Transcript
                  messages={grace.messages}
                  streaming={grace.streaming}
                  searched={grace.searched}
                  actions={grace.actions}
                  asked={grace.asked}
                  onAnswer={(label) => void grace.send(label, 'text')}
                  heard={grace.micOn ? grace.ambient.heard : ''}
                  onOpener={(text) => void grace.send(text, 'text')}
                />
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                onClick={talk}
                aria-label="Talk to Grace"
                className="rounded-full outline-none transition-transform focus-visible:ring-1 focus-visible:ring-ice/50 active:scale-[0.99]">
                <Core level={grace.recorder.level} active={busyNow} size={coreSize} />
              </button>

              <p className="mt-6 text-[0.8rem] tracking-[0.42em] text-ice/85">
                {STATE_LABEL[mode]}
              </p>
              <p
                className="mt-2 text-[0.62rem] uppercase tracking-[0.3em] transition-opacity duration-700"
                style={{
                  color: warnBearing ? 'var(--color-ember)' : 'rgb(var(--accent) / 0.55)',
                }}>
                {grace.live.doing ? grace.live.doing.replace(/_/g, ' ') : bearing}
              </p>

              {/* The last thing said, under her, for when the transcript is
                  closed — which is most of the time. */}
              <p className="mt-8 max-w-xl px-6 text-center text-xs leading-relaxed text-mist/45">
                {grace.streaming ||
                  grace.messages[grace.messages.length - 1]?.text ||
                  ''}
              </p>
            </>
          )}
        </main>

        {/* ---- right column ---- */}
        <aside className="hidden w-52 shrink-0 flex-col overflow-y-auto scroll-thin border-l border-ice/10 px-3 py-4 lg:flex">
          <Head>MIC LEVEL / POLAR</Head>
          <div className="grid place-items-center py-1">
            <Polar
              level={grace.recorder.level}
              live={mode === 'listening' || mode === 'waiting'}
              size={150}
            />
          </div>

          <div className="mt-4">
            <Head>AUDIO LEVEL</Head>
            <Row
              label="RMS"
              value={grace.recorder.level.toFixed(3)}
              share={grace.recorder.level}
            />
          </div>

          <div className="mt-4">
            <Head>SESSION</Head>
            <Row label="MODEL" value={state.model} />
            <Row label="VOICE" value={grace.live.available ? 'NATIVE' : 'RECORDED'} />
            <Row label="LANG" value="EN-GB" />
            <Row label="WAKE" value="GRACE" />
            <Row
              label="BEARING"
              value={bearing.toUpperCase()}
              tone={warnBearing ? 'warn' : 'ice'}
            />
            {/* The listener, made legible. Before any audio is sent it passes
                a pitch check and, when the voice lock is on, a speaker check —
                and a rejected clip is silently dropped. Silently is the
                problem: a lock that no longer recognises you looks exactly
                like a wake word that has stopped working. These rows are the
                difference. */}
            <Row
              label="EAR"
              value={
                !grace.micOn ? 'OFF' : grace.ambient.ear === 'none' ? 'NONE' : grace.ambient.ear.toUpperCase()
              }
              tone={!grace.micOn ? 'ice' : grace.ambient.ear === 'none' ? 'warn' : 'live'}
            />
            <Row
              label="VOICE LOCK"
              value={grace.guard?.on ? grace.guard.strictness.toUpperCase() : 'OFF'}
            />
            {grace.guard?.on && (
              <Row
                label="REJECTED"
                value={String(grace.ambient.strangers)}
                tone={grace.ambient.strangers >= 3 ? 'warn' : 'ice'}
              />
            )}
            <Row label="TOOLS" value={String(state.tools)} />
            <Row label="CONFIRMS" value={String(state.policies.length)} />
            <Row
              label="PAYING"
              value={onPool ? 'CREDIT' : 'CARD'}
              tone={onPool ? 'ice' : 'warn'}
            />
          </div>

          <div className="mt-4">
            <Head>BUILD</Head>
            <Row label="VERSION" value={freshness.build} />
            {/* Amber when the page has been open long enough to be running
                code that has since been replaced. A panel reporting on a
                version of itself that no longer exists is worse than one
                that admits it. */}
            <Row
              label="CURRENT"
              value={freshness.stale ? 'STALE' : 'YES'}
              tone={freshness.stale ? 'warn' : 'live'}
            />
            <Row
              label="GOOGLE"
              value={grace.google?.connected ? 'LINKED' : 'NONE'}
              tone={grace.google?.connected ? 'live' : 'ice'}
            />
          </div>
        </aside>
      </div>

      {grace.ambient.strangers >= 3 && grace.guard?.on && !voiceLockOpen && (
        <div className="relative z-20 flex shrink-0 flex-wrap items-center gap-3 border-t border-ember/25 bg-ember/10 px-4 py-2">
          <span className="readout shrink-0 text-ember/80">VOICE LOCK</span>
          <span className="readout normal-case tracking-normal text-ember/90">
            I’ve ignored {grace.ambient.strangers} things I didn’t recognise as your voice.
            If one of those was you, I’m being too fussy.
          </span>
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => void api.saveVoice({strictness: 'lenient'}).then(grace.setGuard)}
              className="readout border border-ember/40 px-2 py-1 text-ember hover:bg-ember/15">
              Be less fussy
            </button>
            <button
              type="button"
              onClick={() => setVoiceLockOpen(true)}
              className="readout border border-ice/20 px-2 py-1 text-mist/70 hover:text-ice">
              Record me again
            </button>
            <button
              type="button"
              onClick={() => void api.saveVoice({on: false}).then(grace.setGuard)}
              className="readout border border-ice/20 px-2 py-1 text-mist/70 hover:text-ice">
              Turn it off
            </button>
          </span>
        </div>
      )}

      {notice && (
        <p className="relative z-20 flex shrink-0 items-center gap-2 border-t border-ember/25 bg-ember/10 px-4 py-1.5">
          <span className="readout shrink-0 text-ember/80">NOTICE</span>
          <span className="readout truncate normal-case tracking-normal text-ember/90">
            {notice}
          </span>
        </p>
      )}

      <div className="relative z-20 shrink-0 border-t border-ice/15">
        <Composer
          busy={mode === 'thinking'}
          canStop={mode === 'thinking' || mode === 'speaking'}
          micOn={grace.micOn}
          voiceOn={grace.voiceOn}
          micSupported
          voiceSupported={grace.speech.supported}
          awake={grace.ambient.awake}
          recording={grace.recorder.state === 'recording'}
          recorderBusy={
            grace.recorder.state === 'starting' ||
            grace.recorder.state === 'working' ||
            grace.transcribing
          }
          level={grace.recorder.level}
          onRecordStart={talk}
          onRecordStop={grace.recorder.stop}
          onSend={(text) => {
            setShowTalk(true);
            void grace.send(text, 'text');
          }}
          onStop={grace.stop}
          onToggleMic={() => grace.setMicOn(!grace.micOn)}
          onToggleVoice={() => grace.setVoiceOn(!grace.voiceOn)}
          onTalk={talk}
        />
      </div>

      {showFiles && (
        <div className="absolute inset-x-0 bottom-14 top-11 z-30 flex justify-center bg-void/80 p-4">
          <div className="flex w-full max-w-3xl flex-col border border-ice/20 bg-surface/90">
            <div className="flex items-center justify-between border-b border-ice/15 px-4 py-2">
              <span className="readout text-ice/70">FILES &amp; NOTES</span>
              <button
                type="button"
                onClick={() => setShowFiles(false)}
                className="readout text-mist/40 transition hover:text-ice">
                CLOSE
              </button>
            </div>
            <div className="scroll-thin min-h-0 flex-1 space-y-6 overflow-y-auto p-4">
              <Files />
              <NotesPanel />
            </div>
          </div>
        </div>
      )}

      {booting && <Boot onDone={() => setBooting(false)} />}
      <Palette commands={commands} />
      <Install />
      <Timers enabled={session === 'ok' || session === 'open'} />

      {(
        <ProfilePanel
          open={panelOpen}
          profile={state.profile}
          policies={state.policies}
          onClose={() => setPanelOpen(false)}
          onForget={grace.forget}
          onSupersede={grace.supersede}
          onRename={grace.rename}
          onClear={grace.clear}
          onSignOut={session === 'ok' ? () => void grace.signOut() : undefined}
          onKeysChanged={grace.refreshGoogle}
          onOpenVoiceLock={() => {
            setPanelOpen(false);
            setVoiceLockOpen(true);
          }}
        />
      )}

      {voiceLockOpen && (
        <VoiceLock
          guard={grace.guard}
          deviceId={grace.deviceId}
          onSave={async (patch) => {
            grace.setGuard(await api.saveVoice(patch));
          }}
          onForget={async () => {
            grace.setGuard(await api.forgetVoice());
          }}
          onClose={() => setVoiceLockOpen(false)}
        />
      )}

      {soundCheckOpen && (
        <VoiceCheck
          deviceId={grace.deviceId}
          onPickDevice={grace.setDeviceId}
          onClose={() => setSoundCheckOpen(false)}
          onOpenVoiceLock={() => {
            setSoundCheckOpen(false);
            setVoiceLockOpen(true);
          }}
        />
      )}
    </div>
  );
}
