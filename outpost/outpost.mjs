#!/usr/bin/env node
/**
 * The machine that holds Grace's voice open.
 *
 * Grace herself lives on Vercel, where every request is answered and then
 * forgotten, with a sixty-second ceiling on how long it may take. That is a
 * fine place to keep an assistant who is asked questions. It is an impossible
 * place to keep a conversation, because a conversation is one connection held
 * open for as long as you are talking — minutes, sometimes — with audio moving
 * both ways at once.
 *
 * So this runs on a small machine that is always on, and its whole job is to
 * hold that connection. Your browser opens a socket to here; this opens a
 * socket to Google; audio flows through. Nothing is stored here.
 *
 * Why not talk to Google directly from the browser and skip the hop? Because
 * doing that needs a short-lived token, and short-lived tokens are an AI
 * Studio feature that Vertex does not offer. Vertex is where the credits can
 * be spent. Given the choice between paying for the voice out of pocket and
 * adding thirty milliseconds, thirty milliseconds is the easy trade.
 *
 * The important thing this is NOT: a second Grace. It holds no memory, makes
 * no decisions, and owns none of her tools. At the start of every session it
 * asks the real Grace who she is — her prompt, her tool list — and when the
 * model wants to do something, that request is forwarded to her and her
 * answer comes back. What was said is handed back to her afterwards, so the
 * typed Grace remembers the spoken conversation. There is one Grace, and she
 * is on Vercel. This is a wire.
 */

import {createServer} from 'node:http';
import {GoogleGenAI, Modality} from '@google/genai';
import {WebSocketServer} from 'ws';

const settings = {
  port: Number(process.env.PORT ?? 8787),
  project: process.env.GCP_PROJECT_ID ?? '',
  location: process.env.GCP_LOCATION ?? 'global',
  /** Where the real Grace lives. */
  grace: (process.env.GRACE_URL ?? '').replace(/\/+$/, ''),
  model: process.env.GRACE_LIVE_MODEL ?? 'gemini-3.8-live',
  voice: process.env.GRACE_VOICE ?? 'Kore',
};

/**
 * How this machine proves who it is.
 *
 * On a Google VM: it does not carry a key at all. The machine is given an
 * identity when it is created, and the SDK asks the metadata server for a
 * fresh token whenever it needs one. Nothing to copy, nothing to leak,
 * nothing to rotate — and a key that does not exist cannot be stolen from a
 * machine that sits on the public internet holding a port open.
 *
 * Anywhere else — a laptop, someone else's cloud — it falls back to the same
 * service-account JSON that Vercel uses, so this can be run and debugged
 * without a Google VM in front of you.
 */
function credentials() {
  const raw = process.env.GCP_SERVICE_ACCOUNT_JSON?.trim();
  if (!raw) return null;

  const parsed = JSON.parse(raw);
  // Some ways of moving this file around turn the PEM's newlines into the two
  // characters backslash-n. The key then looks perfect and fails to sign.
  if (parsed.private_key?.includes('\\n') && !parsed.private_key.includes('\n')) {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

for (const [name, value] of Object.entries(settings)) {
  if (value === '' || value === undefined) {
    console.error(`[outpost] ${name} is not configured; refusing to start half-deaf`);
    process.exit(1);
  }
}

const carried = credentials();
const google = new GoogleGenAI({
  vertexai: true,
  project: settings.project,
  location: settings.location,
  // No credentials given means "ask the machine you are running on", which on
  // a Google VM is the right answer and on anything else fails loudly at the
  // first request rather than silently doing something unexpected.
  ...(carried ? {googleAuthOptions: {credentials: carried}} : {}),
});
console.log(
  `[outpost] authenticating ${carried ? 'with a carried key' : "as this machine's own identity"}`,
);

/**
 * One call to the real Grace, with the token this conversation arrived with.
 *
 * The token is the browser's, not a copy kept here. This machine used to hold
 * its own, which meant replacing the token in her side panel — the thing that
 * is supposed to lock every door at once — left this door open until someone
 * remembered to redeploy. Now there is nothing here to go stale: whatever
 * proved you were you at the start of the conversation is what she is asked
 * with for the rest of it.
 */
async function askGrace(token, body) {
  const response = await fetch(`${settings.grace}/api/relay`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token, ...body}),
  });
  if (!response.ok) throw new Error(`Grace answered ${response.status}`);
  return response.json();
}

/**
 * Whether this socket is really from you.
 *
 * Checked against her rather than against a copy kept here, so that replacing
 * the token kills every existing connection immediately — which is what the
 * button says it does, and would quietly not be true if this held its own.
 */
async function vouchedFor(token) {
  if (!token) return false;
  try {
    const response = await fetch(`${settings.grace}/api/relay`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token, probe: true}),
    });
    // 401 is the only answer that means "not yours". Anything else — including
    // her being briefly down — must not lock you out of your own voice.
    return response.status !== 401;
  } catch (error) {
    console.error('[outpost] could not reach Grace to check the token:', error.message);
    return false;
  }
}

const server = createServer((req, res) => {
  // A plain GET is how the VM proves it is alive, to you and to a monitor.
  if (req.url === '/health') {
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({ok: true, model: settings.model}));
    return;
  }
  res.writeHead(404).end();
});

const sockets = new WebSocketServer({server, path: '/voice'});

sockets.on('connection', async (browser, request) => {
  const token = new URL(request.url, 'http://x').searchParams.get('token');

  if (!(await vouchedFor(token))) {
    // Nothing more than the code. An unauthenticated caller learns only that
    // it was refused, never why or what would have worked.
    browser.close(4401, 'no');
    return;
  }

  let session = null;
  /*
   * Audio that arrived before Google was ready.
   *
   * Opening the upstream connection takes a moment — longer now, because she
   * is briefed first — and a person who has said her name and started talking
   * does not know that. Without this, the first second of every conversation
   * is silently dropped, which reads as her mishearing you rather than as a
   * race, and is maddening precisely because it only affects the first word.
   */
  const waiting = [];

  const toBrowser = (message) => {
    if (browser.readyState === browser.OPEN) browser.send(JSON.stringify(message));
  };

  /*
   * What has been said this turn, on each side, so it can be handed back.
   *
   * Transcription arrives in fragments. The user's side is flushed the moment
   * the model begins to respond — and always before a tool call is forwarded,
   * because a tool that was refused for approval checks what the user last
   * said, and "yes" has to be on the record before the model asks whether it
   * was said. Her side is flushed when her turn completes.
   */
  let heard = '';
  let said = '';
  let heardFlushed = false;

  const flushHeard = async () => {
    if (heardFlushed || !heard.trim()) return;
    heardFlushed = true;
    const text = heard.trim();
    await askGrace(token, {record: true, heard: text}).catch((error) =>
      console.error('[outpost] could not record what was heard:', error.message),
    );
  };
  const flushSaid = async () => {
    const text = said.trim();
    if (!text) return;
    said = '';
    await askGrace(token, {record: true, said: text}).catch((error) =>
      console.error('[outpost] could not record what was said:', error.message),
    );
    // The turn is over; what she hears next is a new one.
    heard = '';
    heardFlushed = false;
  };

  // Who she is, this time. Every session, because what she knows changes.
  // This is also where the spend brake reaches the voice: she refuses the
  // briefing when the credit is gone, in words that can be passed straight
  // to the person who asked.
  let brief;
  try {
    const response = await fetch(`${settings.grace}/api/relay`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token, brief: true}),
    });
    if (response.status === 402) {
      const {error} = await response.json().catch(() => ({error: 'the credit has run out'}));
      toBrowser({type: 'trouble', detail: error});
      browser.close(1008, 'over budget');
      return;
    }
    if (!response.ok) throw new Error(`Grace answered ${response.status}`);
    brief = await response.json();
  } catch (error) {
    console.error('[outpost] could not get her briefing:', error.message);
    toBrowser({type: 'trouble', detail: 'could not reach Grace for her briefing'});
    browser.close(1011, 'no briefing');
    return;
  }

  /*
   * The books for this session.
   *
   * Google bills the line by the minute of audio in and out — every second it
   * is open counts as input, silence included, and every second she speaks
   * counts as output. The outpost is the only thing that knows either figure,
   * so it keeps them and hands them over when the line closes. Output is
   * measured from the audio actually sent: 16-bit samples at 24kHz, so bytes
   * over 48,000 is seconds.
   */
  const openedAt = Date.now();
  let outputBytes = 0;

  try {
    session = await google.live.connect({
      model: settings.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {prebuiltVoiceConfig: {voiceName: settings.voice}},
        },
        // Her, and her hands. Without these two lines this was a nameless
        // model that could do nothing, wearing her voice.
        systemInstruction: brief.system,
        ...(brief.tools?.length ? {tools: [{functionDeclarations: brief.tools}]} : {}),
        /*
         * The same character, with a real range.
         *
         * Composed and unhurried is the brief and stays the brief. Affective
         * dialog is not a different personality — it is the difference
         * between reading every sentence at one pitch and actually sounding
         * like someone who noticed what you said.
         */
        enableAffectiveDialog: true,
        /*
         * Both halves of the conversation come back as text as well as
         * sound, so the typed Grace and the spoken one share one memory.
         */
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        /*
         * Long conversations outlive the context window. Compression keeps
         * the session alive across that boundary instead of ending it.
         */
        contextWindowCompression: {slidingWindow: {}},
        sessionResumption: {},
      },
      callbacks: {
        onopen: () => {
          for (const chunk of waiting.splice(0)) session?.sendRealtimeInput(chunk);
          toBrowser({type: 'ready'});
        },
        onmessage: async (message) => {
          const content = message.serverContent;

          if (content?.inputTranscription?.text) {
            heard += content.inputTranscription.text;
            toBrowser({type: 'heard', text: content.inputTranscription.text});
          }
          if (content?.outputTranscription?.text) {
            // She has started answering, so what you said is complete.
            void flushHeard();
            said += content.outputTranscription.text;
            toBrowser({type: 'said', text: content.outputTranscription.text});
          }

          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              // Base64 is four characters per three bytes.
              outputBytes += Math.floor((part.inlineData.data.length * 3) / 4);
              toBrowser({type: 'audio', data: part.inlineData.data});
            }
          }

          /*
           * You started talking over her.
           *
           * The model stops generating, but audio already sent is still in
           * the browser's buffer and will keep playing for a second or two
           * over the top of you. Telling the browser to throw away what it
           * has not played yet is the entire difference between interrupting
           * her and talking at the same time as her.
           */
          if (content?.interrupted) toBrowser({type: 'interrupted'});
          if (content?.turnComplete) {
            toBrowser({type: 'done'});
            void flushSaid();
          }

          // The model wants to do something. It travels to the real Grace.
          if (message.toolCall?.functionCalls?.length) {
            // On the record first: an action she was told to ask about is
            // approved by what the user last said, and that has to be written
            // down before the model asks whether it was.
            await flushHeard();

            const answers = [];
            for (const call of message.toolCall.functionCalls) {
              toBrowser({type: 'doing', name: call.name});
              let result;
              try {
                ({result} = await askGrace(token, {tool: call.name, args: call.args ?? {}}));
              } catch (error) {
                result = `Grace could not do that: ${error.message}`;
              }
              answers.push({id: call.id, name: call.name, response: {result}});
            }
            session?.sendToolResponse({functionResponses: answers});
          }
        },
        onerror: (error) => {
          console.error('[outpost] upstream:', error?.message ?? error);
          toBrowser({type: 'trouble', detail: 'the connection to the model failed'});
        },
        onclose: () => {
          if (browser.readyState === browser.OPEN) browser.close(1000, 'upstream closed');
        },
      },
    });
  } catch (error) {
    console.error('[outpost] could not open a session:', error.message);
    toBrowser({type: 'trouble', detail: error.message});
    browser.close(1011, 'no session');
    return;
  }

  browser.on('message', (raw) => {
    let note;
    try {
      note = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (note.type === 'audio' && note.data) {
      const chunk = {
        audio: {data: note.data, mimeType: note.mimeType ?? 'audio/pcm;rate=16000'},
      };
      if (session) session.sendRealtimeInput(chunk);
      else waiting.push(chunk);
      return;
    }

    // A frame of what you are looking at, about once a second. Dropped rather
    // than queued when the session is not open yet: a backlog of stale
    // screenshots arriving all at once is the one thing worse than none.
    if (note.type === 'video' && note.data) {
      session?.sendRealtimeInput({
        video: {data: note.data, mimeType: note.mimeType ?? 'image/jpeg'},
      });
      return;
    }

    // Said rather than spoken — the fallback when the microphone is refused
    // or you would rather type in company.
    if (note.type === 'text' && note.text) {
      heard += note.text;
      session?.sendClientContent({
        turns: [{role: 'user', parts: [{text: note.text}]}],
        turnComplete: true,
      });
    }
  });

  browser.on('close', () => {
    // Whatever was said last is not lost with the connection, and neither is
    // the bill for it.
    const audioIn = (Date.now() - openedAt) / 1000;
    const audioOut = outputBytes / 48_000;
    void flushHeard()
      .then(flushSaid)
      .then(() => askGrace(token, {record: true, audioIn, audioOut}))
      .catch((error) => console.error('[outpost] could not report the minutes:', error.message));
    // Every open session is billed by the minute for as long as it is open,
    // whether or not anyone is talking. A leaked session is a meter running
    // in an empty room, and nothing would ever close it.
    try {
      session?.close();
    } catch {
      // Already gone. Nothing to do and nothing worth saying.
    }
  });
});

server.listen(settings.port, '127.0.0.1', () => {
  console.log(
    `[outpost] listening on 127.0.0.1:${settings.port}, ` +
      `speaking to ${settings.model} in ${settings.location}`,
  );
});
