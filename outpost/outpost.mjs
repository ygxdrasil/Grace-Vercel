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
 * socket to Google; audio flows through. Nothing is stored.
 *
 * Why not talk to Google directly from the browser and skip the hop? Because
 * doing that needs a short-lived token, and short-lived tokens are an AI
 * Studio feature that Vertex does not offer. Vertex is where the credits can
 * be spent. Given the choice between paying for the voice out of pocket and
 * adding thirty milliseconds, thirty milliseconds is the easy trade.
 *
 * The important thing this is NOT: a second Grace. It holds no memory, makes
 * no decisions, and owns none of her tools. When the model asks to do
 * something, that request is forwarded to the real Grace and her answer comes
 * back. There is one Grace, and she is on Vercel. This is a wire.
 */

import {createServer} from 'node:http';
import {GoogleGenAI, Modality} from '@google/genai';
import {WebSocketServer} from 'ws';

const settings = {
  port: Number(process.env.PORT ?? 8787),
  project: process.env.GCP_PROJECT_ID ?? '',
  location: process.env.GCP_LOCATION ?? 'global',
  /** Where the real Grace lives, and how this proves it is hers. */
  grace: (process.env.GRACE_URL ?? '').replace(/\/+$/, ''),
  token: process.env.GRACE_OUTPOST_TOKEN ?? '',
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
 * Whether this socket is really from you.
 *
 * The token is minted by Grace for a signed-in browser and handed over at the
 * start of the connection. It is checked against her rather than against a
 * copy kept here, so that replacing it in her side panel kills every existing
 * connection immediately — which is what the button says it does, and would
 * quietly not be true if this held its own copy.
 */
async function vouchedFor(token) {
  if (!token) return false;
  try {
    const response = await fetch(`${settings.grace}/api/relay`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({token, text: '', probe: true}),
    });
    // 401 is the only answer that means "not yours". Anything else — including
    // her being briefly down — must not lock you out of your own voice.
    return response.status !== 401;
  } catch (error) {
    console.error('[outpost] could not reach Grace to check the token:', error.message);
    return false;
  }
}

/**
 * Hands a tool call to the real Grace and brings back what she says.
 *
 * This is the seam that keeps there being one Grace. The model running the
 * conversation has her tools in its list, but not her hands: when it decides
 * to turn a light off, that decision travels to Vercel, is carried out by the
 * same code that would have carried it out in a typed conversation, and is
 * recorded in the same memory. A voice that had its own copy of the tools
 * would drift from the typed one within a week, and the drift would show up
 * as her denying she had done something she had just done.
 */
async function askGrace(name, args) {
  const response = await fetch(`${settings.grace}/api/relay`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({token: settings.token, tool: name, args}),
  });
  if (!response.ok) {
    return {error: `Grace could not do that (${response.status})`};
  }
  return await response.json();
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
   * Opening the upstream connection takes a moment, and a person who has
   * pressed the button and started talking does not know that. Without this,
   * the first half-second of every conversation is silently dropped — which
   * reads as her mishearing you rather than as a race, and is maddening
   * precisely because it only affects the first word.
   */
  const waiting = [];

  const toBrowser = (message) => {
    if (browser.readyState === browser.OPEN) browser.send(JSON.stringify(message));
  };

  try {
    session = await google.live.connect({
      model: settings.model,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {prebuiltVoiceConfig: {voiceName: settings.voice}},
        },
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
         * sound, so the typed Grace and the spoken one share one memory. A
         * voice that remembered nothing would be a second assistant wearing
         * her name, and you would find out the first time you referred back
         * to something you had said out loud.
         */
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        /*
         * Long conversations outlive the context window. Compression keeps
         * the session alive across that boundary instead of ending it, which
         * is the difference between her trailing off mid-conversation and
         * her simply continuing.
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

          // What she said and what you said, as text, for her memory.
          if (content?.inputTranscription?.text) {
            toBrowser({type: 'heard', text: content.inputTranscription.text});
          }
          if (content?.outputTranscription?.text) {
            toBrowser({type: 'said', text: content.outputTranscription.text});
          }

          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
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
          if (content?.turnComplete) toBrowser({type: 'done'});

          // The model wants to do something. It travels to the real Grace.
          if (message.toolCall?.functionCalls?.length) {
            const answers = [];
            for (const call of message.toolCall.functionCalls) {
              toBrowser({type: 'doing', name: call.name});
              const result = await askGrace(call.name, call.args ?? {});
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

    // Said rather than spoken — the fallback when the microphone is refused
    // or you would rather type in company.
    if (note.type === 'text' && note.text) {
      session?.sendClientContent({
        turns: [{role: 'user', parts: [{text: note.text}]}],
        turnComplete: true,
      });
    }
  });

  browser.on('close', () => {
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
