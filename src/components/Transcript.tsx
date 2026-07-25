import {useEffect, useRef} from 'react';
import type {Message} from '../../shared/types.ts';

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function Bubble({message}: {message: Message}) {
  const fromGrace = message.speaker === 'grace';

  return (
    <div className={`rise flex ${fromGrace ? 'justify-start' : 'justify-end'}`}>
      <div className="max-w-[85%]">
        <div
          className={`rounded-2xl px-4 py-2.5 text-[0.95rem] leading-relaxed ${
            fromGrace
              ? 'bg-raised/80 text-slate-200'
              : 'bg-ice/10 text-slate-100 ring-1 ring-ice/20'
          }`}>
          {message.text}
        </div>
        <div
          className={`mt-1 flex items-center gap-1.5 px-1 text-[0.68rem] text-mist/60 ${
            fromGrace ? '' : 'justify-end'
          }`}>
          {fromGrace && <span className="font-serif italic text-mist/80">Grace</span>}
          <span>{timeOf(message.at)}</span>
          {message.via === 'voice' && <span aria-label="spoken">·  spoken</span>}
        </div>
      </div>
    </div>
  );
}

interface TranscriptProps {
  messages: Message[];
  streaming: string;
  heard: string;
}

export function Transcript({messages, streaming, heard}: TranscriptProps) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({behavior: 'smooth', block: 'end'});
  }, [messages.length, streaming, heard]);

  if (messages.length === 0 && !streaming && !heard) {
    return (
      <div className="flex h-full items-center justify-center px-8 text-center">
        <p className="max-w-sm text-sm leading-relaxed text-mist/70">
          Nothing said yet. Turn on the microphone and say{' '}
          <span className="text-ice/90">“Grace”</span>, or simply type below.
        </p>
      </div>
    );
  }

  return (
    <div className="scroll-thin h-full space-y-4 overflow-y-auto px-6 py-6">
      {messages.map((message) => (
        <Bubble key={message.id} message={message} />
      ))}

      {/* What the microphone is picking up, before it is submitted. */}
      {heard && (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl border border-dashed border-ice/20 px-4 py-2.5 text-[0.95rem] italic text-mist/70">
            {heard}
          </div>
        </div>
      )}

      {streaming && (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-2xl bg-raised/80 px-4 py-2.5 text-[0.95rem] leading-relaxed text-slate-200">
            {streaming}
            <span className="caret ml-0.5 text-ice">▍</span>
          </div>
        </div>
      )}

      <div ref={endRef} />
    </div>
  );
}
