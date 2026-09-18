import {requiresConfirmation} from '../actions';
import {hold, restore, take} from '../approvals';
import {lastUserSaid} from '../memory';
import {noteDeed} from '../journal';
import {askTools} from './ask';
import {codingTools} from './coding';
import {consoleTools} from './console';
import {googleTools} from './google';
import {machineTools} from './machine';
import {keepTools} from './keep';
import {lightTools} from './lights';
import {openTools} from './open';
import {playstationTools} from './playstation';
import {recallTools} from './recall';
import {reminderTools} from './reminders';
import {selfTools} from './self';
import {timerTools} from './timers';
import {webTools} from './web';
import {workTools} from './work';
import type {Tool, ToolCall, ToolOutcome} from './types';

/**
 * Everything Grace can actually do.
 *
 * One thing is true of this list and must stay true: nothing in it sends a
 * message or spends money. Those are the user's absolute limits, there is no
 * tool for either, and so there is nothing to talk her past.
 *
 * Deleting used to be the same kind of absence, and is not any more. The user
 * asked for her to have their machine, in their words: "can delete, but always
 * asks." So the tools that destroy something exist, and every one of them is
 * marked — either always, or by reading the particular request — so the gate
 * holds it until the user has said yes in their own words. The difference
 * between that and the two above is worth keeping clear in the head: sending
 * and spending are impossible, deleting is merely never silent.
 */
const TOOLS: Tool[] = [
  ...webTools,
  ...machineTools,
  ...codingTools,
  ...reminderTools,
  ...googleTools,
  ...playstationTools,
  ...consoleTools,
  ...recallTools,
  ...askTools,
  ...openTools,
  ...keepTools,
  ...timerTools,
  ...workTools,
  ...selfTools,
  ...lightTools,
];

/**
 * What counts as a yes.
 *
 * Deliberately narrow. "Yes", "go ahead", "send it", "do it" — the things a
 * person says when agreeing to something they have just been asked. Not
 * "maybe", not "what would that do", and not a sentence that merely contains
 * the word yes somewhere. The cost of being too strict is that she asks
 * again; the cost of being too loose is an email that went out.
 */
const AGREED =
  /^\s*(yes|yeah|yep|yup|ok(ay)?|sure|go ahead|do it|confirm(ed)?|send it|approved?|please do|go on|fine|absolutely|of course|make it so)\b/i;

/** A yes older than this is about something else. */
const AGREEMENT_FRESH_MS = 3 * 60 * 1000;

const confirmTool: Tool = {
  name: 'confirm_action',
  description:
    'Run an action that was held for approval. Only call this after the user ' +
    'has clearly said yes to the specific thing you described. Pass the id ' +
    'you were given when the action was held.',
  category: 'research',
  parameters: {
    id: {type: 'string', description: 'The id from the hold message.'},
  },
  required: ['id'],
  run: async (args) => {
    const id = String(args.id ?? '').trim();

    /*
     * The check that makes this a real gate.
     *
     * The model is asking to run something it was refused. Whether it may is
     * decided by what the *user* last said — a record the server wrote from
     * what actually arrived, which the model has no way to author. It has to
     * be a plain yes, said after the action was held, and recently. A model
     * that has talked itself into believing consent was given still cannot
     * manufacture the sentence this reads.
     */
    const said = await lastUserSaid();
    const entry = await take(id);
    if (!entry) {
      return `Nothing is held under "${id}" — it may have expired. Ask again if it still matters.`;
    }
    const agreed =
      said !== null &&
      AGREED.test(said.text) &&
      new Date(said.at).getTime() >= new Date(entry.at).getTime() &&
      Date.now() - new Date(said.at).getTime() < AGREEMENT_FRESH_MS;
    if (!agreed) {
      // Put back under the same id, so a genuine yes a moment later still works.
      await restore(entry);
      return (
        `The user has not clearly said yes to that yet. Ask them plainly and ` +
        `wait for their answer. Do not call this again until they have.`
      );
    }

    const tool = findTool(entry.name);
    if (!tool) return `The held action (${entry.name}) no longer exists.`;
    const result = await tool.run(entry.args);
    await noteDeed('acted', `${describe(tool.name, result)} (confirmed by you)`).catch(() => {});
    return result;
  },
};
TOOLS.push(confirmTool);

export function allTools(): Tool[] {
  return TOOLS;
}

export function findTool(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

/** Words that would mean a tool destroys something. Checked, not trusted. */
const DESTRUCTIVE = /\b(delete|destroy|erase|purge|wipe|permanently remove)\b/i;

/**
 * Proves the hard limits about the tool list itself, rather than about any
 * particular call. Run at startup and by the self-test.
 *
 * This used to say that nothing may destroy anything at all, and that stopped
 * being the user's instruction when they handed her their machine. The rule
 * now is narrower and, unlike a blanket ban, survivable: destruction is
 * allowed, it is confined to the one category that governs their own computer,
 * and it is never silent. A tool that reads as destroying something and
 * declares nothing is the actual danger here — it would slip past the gate
 * looking harmless — so that is what this hunts for.
 */
export function auditTools(): string[] {
  const problems: string[] = [];

  for (const tool of TOOLS) {
    if (tool.category === 'communication') {
      problems.push(`${tool.name} is a communication tool; she has no such power`);
    }
    if (tool.category === 'purchase') {
      problems.push(`${tool.name} would spend money`);
    }

    const reads = DESTRUCTIVE.test(tool.description) || DESTRUCTIVE.test(tool.name);
    const declares = Boolean(tool.destructive || tool.risky);

    if ((reads || declares) && tool.category !== 'machine') {
      problems.push(
        `${tool.name} can destroy something but is not governed by the machine policy`,
      );
    }
    if (reads && !declares) {
      problems.push(
        `${tool.name} describes itself as destroying something but is not marked ` +
          `destructive, so the gate would let it through unannounced`,
      );
    }
  }

  return problems;
}

/** Tool names read like function calls; the journal is read by a person. */
const LABELS: Record<string, string> = {
  search_web: 'Searched the web',
  add_reminder: 'Added to the list',
  list_reminders: 'Checked the list',
  complete_reminder: 'Marked something done',
  check_mail: 'Checked the mail',
  read_mail: 'Read an email',
  draft_reply: 'Wrote a draft',
  check_diary: 'Checked the diary',
  add_to_diary: 'Added to the diary',
  check_playstation: 'Looked at the PlayStation',
  recent_games: 'Checked recent games',
  search_memory: 'Went back through the record',
  ask_choice: 'Asked you something',
  open_pages: 'Opened a page',
  open_workspace: 'Switched workspace',
  write_note: 'Added to a note',
  read_note: 'Read a note back',
  track_situation: 'Logged a development',
  list_situations: 'Checked what is open',
  resolve_situation: 'Marked something settled',
  set_timer: 'Started a timer',
  list_timers: 'Checked the timers',
  start_watch: 'Started watching something',
  list_watches: 'Checked the watches',
  stop_watch: 'Stopped a watch',
  search_files: 'Looked through your documents',
  read_document: 'Read a document',
  write_document: 'Wrote a document',
  set_lights: 'Changed the lights',
  dim_lights: 'Dimmed the lights',
  colour_lights: 'Recoloured the lights',
  list_lights: 'Checked the lights',
  check_github: 'Checked GitHub',
  check_workflows: 'Checked the workflows',
  file_mail: 'Filed a message',
  label_mail: 'Labelled a message',
  mark_mail: 'Marked a message',
  change_diary: 'Moved something in the diary',
  pause_workflow: 'Changed a workflow',
  rerun_checks: 'Set the build running again',
  open_on_laptop: 'Put a page on the laptop',
  lock_laptop: 'Locked the laptop',
  remember_this: 'Kept something in mind',
  correct_memory: 'Corrected herself',
  set_attention: 'Changed how much she interrupts',
  make_room: 'Built a room',
  notify_phone: 'Reached your phone',
};

function label(name: string): string {
  return LABELS[name] ?? name.replace(/_/g, ' ');
}

/**
 * What the interface shows about an action.
 *
 * Emphatically not the tool's output. Checking the mail returns every subject
 * line in the inbox because the model needs to read them — putting that on
 * screen underneath her reply buried the reply itself under a wall of other
 * people's email. The user should see that she looked, not what she read.
 *
 * A short result is worth keeping, though: "Noted: ring the dentist" says more
 * than "Added to the list" and costs a line either way.
 */
function describe(name: string, result: string): string {
  const short = result.trim().split('\n')[0];
  return short.length > 0 && short.length <= 60 && !short.includes('  ')
    ? `${label(name)} — ${short}`
    : label(name);
}

/**
 * Run one call the model asked for.
 *
 * Everything that could go wrong here is returned as a readable sentence
 * rather than thrown: the model reads the result and has to be able to tell
 * the user what happened, and a stack trace tells it nothing.
 */
export async function runTool(call: ToolCall): Promise<ToolOutcome> {
  const tool = findTool(call.name);
  if (!tool) {
    return {
      name: call.name,
      ok: false,
      result: `There is no tool called ${call.name}.`,
      summary: `Tried to use a tool that doesn't exist (${call.name})`,
    };
  }

  const missing = tool.required.filter(
    (key) => call.args[key] === undefined || call.args[key] === '',
  );
  if (missing.length > 0) {
    return {
      name: tool.name,
      ok: false,
      result: `Missing: ${missing.join(', ')}. Ask the user for it.`,
      summary: `Needed more detail for ${tool.name}`,
    };
  }

  // The policy layer, finally load-bearing rather than advisory.
  //
  // The confirmer is exempt from it. It carries a stricter check of its own —
  // a plain yes from the user, on the record, after the hold — and gating it
  // by category would mean that the moment a category was set to "always
  // ask", nothing in that category could ever be agreed to again.
  /*
   * Whether this particular call destroys something.
   *
   * Asked of the arguments, not only of the tool, because one shell is both
   * "list that folder" and "delete that folder".
   */
  const destroys = tool.risky?.(call.args) ?? tool.destructive ?? false;

  /*
   * Destruction asks. Always, and not as a matter of policy.
   *
   * The user's words were "can delete, but always asks", and a setting that
   * can switch that off is not that promise — it is that promise until
   * somebody, including her, changes a dropdown. So it sits outside the
   * policy layer entirely: policy decides how much of the rest she gets on
   * with, and has no say here at all.
   */
  if (
    tool.name !== confirmTool.name &&
    (destroys || (await requiresConfirmation(tool.category, destroys)))
  ) {
    // Held under an id, so that saying yes runs exactly this and nothing else.
    const receipt = await hold(tool.name, call.args);
    return {
      name: tool.name,
      ok: false,
      result:
        `That needs the user's explicit go-ahead first. Describe exactly what ` +
        `you are about to do and ask them to confirm — then stop. Do not claim ` +
        `to have done it. If they say yes, call confirm_action with the id ` +
        `"${receipt.id}". It is held for five minutes.`,
      summary: `Waiting on approval for ${tool.name}`,
    };
  }

  try {
    const result = await tool.run(call.args);
    // Everything she does goes on the record. An assistant who acts for you
    // and leaves no trace is asking to be taken on trust, and she shouldn't
    // have to be: the interface shows this list.
    await noteDeed('acted', describe(tool.name, result)).catch(() => {});
    // `result` is what the model reads; `summary` is what the user sees. They
    // used to be the same string, which is how an inbox ended up on screen.
    return {name: tool.name, ok: true, result, summary: describe(tool.name, result)};
  } catch (error) {
    const detail = (error as Error).message;
    console.error(`[grace] tool ${tool.name} failed:`, detail);
    return {
      name: tool.name,
      ok: false,
      result: `That didn't work: ${detail}. Tell the user plainly.`,
      summary: `${tool.name} failed`,
    };
  }
}

/**
 * What each tool needs before it can do anything at all.
 *
 * A tool whose service is not connected is worse than useless: it costs its
 * declaration on every single request, and when she does reach for it, it
 * answers "GitHub is not connected" — which she then has to explain. Leaving it
 * out is both cheaper and more honest, since she stops offering what she cannot
 * do.
 *
 * Anything not listed here always works, because it depends on nothing but her.
 */
const NEEDS: Record<string, keyof Available> = {
  check_mail: 'google',
  read_mail: 'google',
  draft_reply: 'google',
  file_mail: 'google',
  label_mail: 'google',
  mark_mail: 'google',
  check_diary: 'google',
  add_to_diary: 'google',
  change_diary: 'google',
  check_github: 'github',
  rerun_checks: 'github',
  check_workflows: 'n8n',
  pause_workflow: 'n8n',
  check_playstation: 'playstation',
  recent_games: 'playstation',
  open_on_laptop: 'room',
  /*
   * The machine tools need the bridge only when she is somewhere else.
   *
   * Running on the machine itself, they need nothing — so gating them on the
   * bridge would hide her own hands from her, which is a very strange way for
   * a local install to behave. `available.ts` reports the room as present when
   * she is not deployed for exactly this reason.
   */
  list_folder: 'room',
  read_file: 'room',
  write_file: 'room',
  delete_file: 'room',
  run_command: 'room',
  // Coding needs both a machine to code on and Claude Code installed on it.
  // Offering it without either means she promises and then explains herself.
  write_code: 'coding',
  check_code: 'coding',
  run_tests: 'coding',
  lock_laptop: 'room',
  notify_phone: 'phone',
  set_lights: 'lights',
  dim_lights: 'lights',
  colour_lights: 'lights',
  list_lights: 'lights',
  check_lights: 'lights',
  set_scene: 'lights',
  adjust_scene: 'lights',
  restore_scene: 'lights',
  list_scenes: 'lights',
};

export interface Available {
  google: boolean;
  github: boolean;
  n8n: boolean;
  /** The read-only PlayStation Network view. */
  playstation: boolean;
  /** The laptop bridge — the console's switch, and the laptop itself. */
  room: boolean;
  phone: boolean;
  lights: boolean;
  /** Claude Code, on the machine she is running on. */
  coding: boolean;
}

/**
 * The shape Gemini wants for a function declaration.
 *
 * Given what is connected, the list narrows to what can actually run. Note what
 * this deliberately is not: a per-message guess at which tools this particular
 * sentence needs. That would save more on paper and cost more in practice —
 * Gemini's implicit cache discounts a repeated prompt prefix to a quarter, and
 * the prefix includes the tool list, so a list that changes every message turns
 * every request into a full-price one. What is connected changes when a key is
 * pasted, which is roughly never, so this stays cacheable.
 */
export function declarations(have?: Available) {
  const usable = have
    ? TOOLS.filter((tool) => {
        const needs = NEEDS[tool.name];
        return !needs || have[needs];
      })
    : TOOLS;

  return usable.map((tool) => {
    const keys = Object.keys(tool.parameters);
    // A declaration with an empty properties object is malformed, and a
    // malformed declaration can take the whole tool list down with it.
    if (keys.length === 0) {
      return {name: tool.name, description: tool.description};
    }

    return {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'OBJECT' as const,
        properties: Object.fromEntries(
          Object.entries(tool.parameters).map(([key, spec]) => [
            key,
            {
              type: spec.type.toUpperCase(),
              description: spec.description,
              ...(spec.values ? {enum: spec.values} : {}),
            },
          ]),
        ),
        required: tool.required,
      },
    };
  });
}
