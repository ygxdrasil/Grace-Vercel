import {
  ExternalLink,
  Headphones,
  Moon,
  LayoutDashboard,
  Maximize2,
  MessagesSquare,
  PanelRight,
} from 'lucide-react';
import {useEffect, useState} from 'react';
import {Boot} from './components/Boot';
import {Composer} from './components/Composer';
import {ACCENT, Rail} from './components/Rail';
import {Stage} from './components/Stage';
import {Dashboard} from './components/Dashboard';
import {Lock} from './components/Lock';
import {Holo} from './components/Holo';
import {Palette, type Command} from './components/Palette';
import {ProfilePanel} from './components/ProfilePanel';
import {Timers} from './components/Timers';
import {Transcript} from './components/Transcript';
import {VoiceCheck} from './components/VoiceCheck';
import {VoiceLock} from './components/VoiceLock';
import type {Mode} from './hooks/useGrace';
import {useGrace} from './hooks/useGrace';
import type {DayView} from '../shared/types';
import * as api from './lib/api';
import {useFreshness} from './hooks/useFreshness';
import {useRooms} from './hooks/useRooms';
import {useChats} from './hooks/useChats';
import {MANY_CONVERSATIONS} from './lib/features';
import {Module} from './components/hud/Module';
import {Sidebar} from './components/Sidebar';
import {Install} from './components/Install';
import {useTheme} from './hooks/useTheme';

const MODE_LABEL: Record<Mode, string> = {
  offline: 'Not configured',
  idle: 'Ready',
  waiting: 'Listening for “Grace”',
  listening: 'Go ahead',
  thinking: 'Thinking',
  speaking: 'Speaking',
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
  const wide = useWide();
  const freshness = useFreshness();
  const {theme, toggle: toggleTheme} = useTheme();
  // Reloading rather than clearing: the conversation just switched to is
  // whatever the server has, and an emptied screen would be a guess at it.
  const chats = useChats(() => void grace.reload());
  const [panelOpen, setPanelOpen] = useState(false);
  const [soundCheckOpen, setSoundCheckOpen] = useState(false);
  const [voiceLockOpen, setVoiceLockOpen] = useState(false);
  /** Which half of the app a narrow screen is showing. */
  const [tab, setTab] = useState<'grace' | 'talk'>('grace');
  /** Her, taking over the screen. */
  const [stage, setStage] = useState(false);
  const [holo, setHolo] = useState(false);
  const [booting, setBooting] = useState(
    () => typeof sessionStorage !== 'undefined' && !sessionStorage.getItem('grace-booted'),
  );
  const [now, setNow] = useState(() => new Date());
  const [day, setDay] = useState<DayView | null>(null);

  useEffect(() => {
    if (!stage && !holo) return;
    const tick = window.setInterval(() => setNow(new Date()), 1000);
    const load = () => void api.fetchDay().then((next) => next && setDay(next));
    load();
    const refresh = window.setInterval(load, 120_000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(refresh);
    };
  }, [stage, holo]);

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

  const notice =
    mode === 'offline'
      ? 'No Gemini API key found. Set GEMINI_API_KEY where Grace is running, then restart or redeploy her.'
      : (grace.error ?? grace.ambient.error);

  /** One press: she opens the microphone and closes it when you stop talking. */
  const talk = () => {
    if (grace.recorder.state === 'recording') grace.recorder.stop();
    else void grace.recorder.start();
  };

  const accent = ACCENT[rooms.room?.accent ?? 'ice'];

  // Everything the palette can reach. Rooms come from the server list, so a
  // room the user makes appears here for free.
  const commands: Command[] = [
    ...rooms.rooms.map((room) => ({
      id: `room:${room.id}`,
      label: `Go to ${room.name}`,
      hint: 'room',
      run: () => rooms.enter(room.id, true),
    })),
    ...(MANY_CONVERSATIONS
      ? [
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
        ]
      : []),
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
    {id: 'stage', label: 'Full screen', hint: 'view', run: () => setStage(true)},
    {id: 'holo', label: 'Projection mode', hint: 'view', run: () => setHolo(true)},
    {id: 'sound', label: 'Sound check', hint: 'audio', run: () => setSoundCheckOpen(true)},
    {
      id: 'voicelock',
      label: 'Only answer to me',
      hint: 'audio',
      run: () => setVoiceLockOpen(true),
    },
    {
      id: 'theme',
      label: theme === 'dark' ? 'Switch to daylight' : 'Switch to dark',
      hint: 'view',
      run: toggleTheme,
    },
    {id: 'panel', label: 'What Grace knows', hint: 'settings', run: () => setPanelOpen(true)},
  ];

  const dashboard = state && (
    <Dashboard
      state={state}
      mode={mode}
      micLevel={grace.recorder.level}
      recording={grace.recorder.state === 'recording'}
      micBusy={
        grace.recorder.state === 'starting' ||
        grace.recorder.state === 'working' ||
        grace.transcribing
      }
      micError={grace.recorder.error}
      voiceSource={grace.speech.source}
      voiceOn={grace.voiceOn}
      google={grace.google}
      concerns={grace.pulse.concerns}
      held={grace.pulse.held}
      lastLookedAt={grace.pulse.lastLookedAt}
      onSetAttention={(next) => void grace.setAttention(next)}
      onTalk={talk}
      onOpenSoundCheck={() => setSoundCheckOpen(true)}
      room={rooms.room}
    />
  );

  return (
    <div className="relative flex h-screen flex-col overflow-hidden">
      {/* The room, in layers, back to front: two bodies of light crossing at
          different speeds, the ruled grid, a film of grain to stop the
          gradients banding, and a vignette so the light has a direction. */}
      <div className="field pointer-events-none" />
      <div className="field-counter pointer-events-none" />
      <div className="grid-veil" />
      <div className="grain" />
      <div className="vignette" />

      {/* The status bar, rather than a page heading.
          A title that says the name of the application is the least useful
          thing a bar like this can carry — you know what you opened. What
          earns the space is what is true right now: which room, what she is
          doing, and whether the voice is the live one or the fallback. */}
      <header className="relative z-10 flex items-center justify-between gap-3 border-b border-ice/15 bg-void/40 px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <span className="readout text-ice/80">
            {rooms.room && rooms.room.id !== 'grace' ? rooms.room.name : 'Grace'}
          </span>
          <span
            className="readout hidden items-center gap-1.5 text-mist/60 sm:flex"
            aria-live="polite">
            <span className={`h-1 w-1 rounded-full ${MODE_DOT[mode]}`} />
            {MODE_LABEL[mode]}
          </span>
        </div>

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Which voice is actually running.
              This is here because its absence cost a day: the live voice was
              blocked by a security header, she fell back to recording and
              replying, and the fallback works well enough that nobody could
              tell. Two states that behave almost identically need to be
              legible somewhere, or the broken one passes for the working one. */}
          <span
            className={`readout hidden sm:inline ${
              grace.live.available ? 'text-ice/60' : 'text-mist/40'
            }`}
            title={
              grace.live.available
                ? 'Live voice — she hears you while she is talking'
                : 'Fallback voice — records, then replies. She cannot be interrupted.'
            }>
            {grace.live.available ? 'LIVE' : 'RELAY'}
          </span>
          <button
            type="button"
            onClick={() => setSoundCheckOpen((open) => !open)}
            aria-pressed={soundCheckOpen}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition ${
              soundCheckOpen
                ? 'border-ice/40 bg-ice/15 text-ice'
                : 'border-edge bg-surface text-mist hover:border-ice/40 hover:text-ice'
            }`}>
            <Headphones size={14} />
            <span className="hidden sm:inline">Sound check</span>
          </button>
          <button
            type="button"
            onClick={() => setStage(true)}
            aria-label="Full screen"
            className="text-mist transition hover:text-slate-200">
            <Maximize2 size={17} />
          </button>
          <button
            type="button"
            onClick={() => setPanelOpen((open) => !open)}
            aria-label="What Grace knows"
            className="text-mist transition hover:text-slate-200">
            <PanelRight size={18} />
          </button>
        </div>
      </header>

      {/* On a narrow screen the dashboard used to be hidden outright, so a phone
          showed an orb and nothing else. It gets equal billing now. */}
      <div className="flex shrink-0 border-b border-edge/70 lg:hidden">
        {(
          [
            ['grace', 'Grace', <LayoutDashboard key="d" size={14} />],
            ['talk', 'Conversation', <MessagesSquare key="t" size={14} />],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={`flex flex-1 items-center justify-center gap-2 py-2.5 text-xs transition ${
              tab === id
                ? 'border-b-2 border-ice text-ice'
                : 'border-b-2 border-transparent text-mist hover:text-slate-200'
            }`}>
            {icon}
            {label}
          </button>
        ))}
      </div>

      <main className="relative flex min-h-0 flex-1 max-lg:flex-col">
        <Sidebar
          chats={chats.chats}
          currentChat={chats.current}
          rooms={rooms.rooms}
          currentRoom={rooms.current}
          onNewChat={() => void chats.start()}
          onOpenChat={(id) => void chats.open(id)}
          onArchiveChat={(id) => void chats.archive(id)}
          onRoom={(id) => rooms.enter(id, true)}
          onFiles={() => rooms.enter('day', false)}
          onSettings={() => setPanelOpen(true)}
        />

        {/* The rail stays for phones, where a 15rem sidebar is the screen. */}
        <Rail
          rooms={rooms.rooms}
          current={rooms.current}
          onPick={(id) => rooms.enter(id, true)}
        />

        {/* One mount, whichever shape the screen is. Rendering it in both a
            desktop aside and a phone tab looked free — CSS hid one — but a
            hidden component still runs, so every panel polled its services
            twice. On a page that lives open all day, that doubled her bill.
            One ELEMENT too, not a ternary of two: branching on the breakpoint
            remounted the whole tree at 1024px, which threw away an unsaved
            note edit mid-drag. The element stays; only its clothes change. */}
        <aside
          className={
            wide
              ? 'w-80 shrink-0 border-r border-edge/70'
              : `min-h-0 flex-1 ${tab === 'grace' ? '' : 'hidden'}`
          }>
          {dashboard}
        </aside>

        <section
          className={`min-w-0 flex-1 flex-col p-3 lg:flex ${
            tab === 'talk' ? 'flex' : 'hidden'
          }`}>
          {/* Framed rather than bare.
              The conversation used to run edge to edge, which made it the
              page itself. Inside a labelled frame it becomes one instrument
              among several — which is the point of the arrangement, and also
              what stops a long transcript reading as the whole application. */}
          <Module
            label="Conversation"
            fill
            status={grace.live.state === 'closed' ? undefined : grace.live.state}
            className="min-h-0 flex-1">
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
          </Module>
        </section>

        {state && (
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
            voiceGuarded={Boolean(grace.guard?.on)}
            theme={theme}
            onToggleTheme={toggleTheme}
            voiceMode={grace.voiceMode}
            onVoiceMode={grace.setVoiceMode}
            volume={grace.volume}
            onVolume={grace.setVolume}
            outputs={grace.outputs}
            output={grace.output}
            onOutput={grace.setOutput}
          />
        )}
      </main>

      {freshness.stale && (
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="w-full border-t border-ice/25 bg-ice/10 px-5 py-2 text-left text-xs text-ice">
          There is a newer version of me. Tap to reload.
        </button>
      )}

      {/*
        A blocked page, made one tap rather than a paragraph.

        A browser will not open a tab unless it believes a person asked, and
        her instruction arrives seconds after you spoke, down a stream — by
        which time it has stopped believing. Nothing in the page can talk it
        round; that is the whole point of the protection.

        But a tap *is* the gesture, so a button here always works. That turns a
        refusal into one press, which is a far better answer than a sentence
        about popup blockers, and the sentence is offered underneath for the
        person who would rather fix it permanently.
      */}
      {rooms.blocked.length > 0 && (
        <div className="glass edge-run mx-4 mb-2 p-3">
          <p className="text-xs text-slate-200">
            Your browser wouldn’t let me open{' '}
            {rooms.blocked.length === 1 ? 'this' : 'these'} on my own.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {rooms.blocked.map((url) => (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noreferrer"
                onClick={rooms.dismissBlocked}
                className="inline-flex items-center gap-1.5 rounded-full border border-ice/40 bg-ice/15 px-3 py-1 text-xs text-ice transition hover:bg-ice/25">
                <ExternalLink size={11} />
                Open {new URL(url).hostname.replace(/^www\./, '')}
              </a>
            ))}
            <button
              type="button"
              onClick={rooms.dismissBlocked}
              className="ml-auto rounded-full border border-edge px-3 py-1 text-xs text-mist hover:text-slate-200">
              Not now
            </button>
          </div>
          <p className="mt-2 text-[0.65rem] leading-relaxed text-mist/55">
            To stop this happening: allow pop-ups for this site — in Chrome, the
            icon at the right of the address bar, or Settings, Privacy and
            security, Site settings, Pop-ups and redirects.
          </p>
        </div>
      )}

      {notice && (
        <p className="border-t border-ember/20 bg-ember/10 px-5 py-2 text-xs text-ember/90">
          {notice}
        </p>
      )}

      {/* Everything the microphone has to say for itself, in one place. */}
      {(grace.recorder.error || grace.misheard) && (
        <p className="flex items-center justify-between gap-3 border-t border-rose-400/20 bg-rose-400/10 px-5 py-2 text-xs text-rose-200">
          <span>{grace.recorder.error ?? grace.misheard}</span>
          <button
            type="button"
            onClick={() => setSoundCheckOpen(true)}
            className="shrink-0 underline underline-offset-2 hover:text-rose-100">
            Sound check
          </button>
        </p>
      )}

      {grace.recorder.state === 'recording' && (
        <p className="border-t border-ice/20 bg-ice/5 px-5 py-2 text-xs text-ice/90">
          {grace.recorder.heardSomething
            ? 'Hearing you — I’ll stop when you do.'
            : 'Listening, but nothing’s reaching me yet. Start talking.'}
        </p>
      )}

      {grace.speech.blocked && grace.voiceOn && (
        <p className="border-t border-ember/20 bg-ember/10 px-5 py-2 text-xs text-ember/90">
          Your browser is refusing to play my voice. Tap anywhere on the page,
          then send another message — that usually settles it.
        </p>
      )}

      {grace.speech.source === 'browser' && grace.voiceOn && (
        <p className="flex items-center justify-between gap-3 border-t border-ember/20 bg-ember/10 px-5 py-2 text-xs text-ember/90">
          <span>
            I’m speaking through the browser’s voice — my own wouldn’t come
            through{grace.speech.error ? `: ${grace.speech.error}` : '.'}
          </span>
          <button
            type="button"
            onClick={() => setSoundCheckOpen(true)}
            className="shrink-0 underline underline-offset-2 hover:text-ember">
            Sound check
          </button>
        </p>
      )}

      {grace.transcribing && (
        <p className="border-t border-edge/70 bg-surface/50 px-5 py-2 text-xs text-mist/70">
          Working out what you said…
        </p>
      )}

      {booting && (
        <Boot
          onDone={() => {
            sessionStorage.setItem('grace-booted', '1');
            setBooting(false);
          }}
        />
      )}

      {holo && (
        <Holo mode={mode} level={grace.recorder.level} now={now} onClose={() => setHolo(false)} />
      )}

      <Palette commands={commands} />

      {stage && state && (
        <Stage
          state={state}
          day={day}
          mode={mode}
          level={grace.recorder.level}
          now={now}
          onTalk={talk}
          onClose={() => setStage(false)}
        />
      )}

      {soundCheckOpen && (
        <VoiceCheck
          onClose={() => setSoundCheckOpen(false)}
          deviceId={grace.deviceId}
          onPickDevice={grace.setDeviceId}
          onOpenVoiceLock={() => {
            setSoundCheckOpen(false);
            setVoiceLockOpen(true);
          }}
          ambient={grace.ambient}
        />
      )}

      {/*
        The lockout, made visible.

        She used to ignore a voice and give no sign at all, which is
        indistinguishable from being broken — and that is exactly how it was
        reported. Three refusals in a row is no longer the television; it is
        somebody trying to be heard, so it says so and offers the two ways out.
      */}
      {/*
        Asleep, and saying so.

        A silent assistant needs a reason on screen, or "she stopped working"
        and "I told her to stop" look identical — which is the same mistake the
        voice guard made, and it took two rounds to find that one.
      */}
      <Install />

      {grace.ambient.dormant && (
        <div className="glass mx-4 mb-2 flex items-center gap-3 p-3">
          <Moon size={14} className="accent shrink-0" />
          <p className="flex-1 text-xs text-slate-200">
            Asleep. Say “Grace” and I’m back.
          </p>
          <button
            type="button"
            onClick={grace.ambient.rouse}
            className="rounded-full border border-ice/40 bg-ice/15 px-3 py-1 text-xs text-ice hover:bg-ice/25">
            Wake her
          </button>
        </div>
      )}

      {grace.ambient.strangers >= 3 && grace.guard?.on && !voiceLockOpen && (
        <div className="glass edge-run fixed inset-x-4 bottom-24 z-30 mx-auto max-w-md p-3 lg:bottom-6">
          <p className="text-xs leading-relaxed text-slate-200">
            I’ve ignored {grace.ambient.strangers} things I didn’t recognise as your
            voice. If one of those was you, I’m being too fussy.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                void api.saveVoice({strictness: 'lenient'}).then(grace.setGuard);
              }}
              className="rounded-full border border-ice/40 bg-ice/15 px-3 py-1 text-xs text-ice hover:bg-ice/25">
              Be less fussy
            </button>
            <button
              type="button"
              onClick={() => setVoiceLockOpen(true)}
              className="rounded-full border border-edge px-3 py-1 text-xs text-mist hover:text-slate-200">
              Record my voice again
            </button>
            <button
              type="button"
              onClick={() => {
                void api.saveVoice({on: false}).then(grace.setGuard);
              }}
              className="ml-auto rounded-full border border-edge px-3 py-1 text-xs text-mist hover:text-slate-200">
              Turn it off
            </button>
          </div>
        </div>
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

      <Timers enabled={session === 'ok' || session === 'open'} />

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
        onSend={(text) => void grace.send(text, 'text')}
        onStop={grace.stop}
        onToggleMic={() => grace.setMicOn(!grace.micOn)}
        onToggleVoice={() => grace.setVoiceOn(!grace.voiceOn)}
        onTalk={talk}
      />
    </div>
  );
}
