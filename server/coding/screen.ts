import {mkdirSync, readdirSync, rmSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {config} from '../config';

/**
 * A look at the screen, on demand.
 *
 * She could already see it, but only while the voice line was open — the
 * browser shares the display into the live session and the frames stop when
 * the call does. That is the wrong shape for "what does this error say": you
 * do not want to start a phone call to have something read.
 *
 * So: one frame, written to a file, and handed to a model that can read it.
 * Nothing streams, nothing is held open, and there is no camera light on for
 * an hour because somebody asked a question once.
 *
 * Two things to be straight about, both of which the tool says out loud.
 *
 * A screenshot is whatever is on the screen — a password manager left open, a
 * private message, somebody else's email. It leaves this machine, because the
 * model that reads it is not on this machine. That is not a footnote.
 *
 * And the captures are deleted as they age. A folder quietly accumulating
 * pictures of somebody's desktop is a worse liability than the screenshot
 * itself, because nobody remembers it is there.
 */

/**
 * How the screen is captured, per platform, as a literal.
 *
 * Nothing model-written is ever interpolated into these. The only substitution
 * is the output path, which is generated here from a timestamp — so there is
 * no route from anything said to her into a command line.
 *
 * Windows goes through .NET rather than an external program, because there is
 * no screenshot binary to rely on: System.Drawing is present on every install
 * and needs nothing fetched.
 */
function captureCommand(to: string): string | null {
  if (process.platform === 'win32') {
    return [
      'powershell -NoProfile -Command "',
      "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;",
      '$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;',
      '$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height;',
      '$g=[System.Drawing.Graphics]::FromImage($i);',
      '$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);',
      `$i.Save('${to}',[System.Drawing.Imaging.ImageFormat]::Png)`,
      '"',
    ].join('');
  }

  // -x silences the shutter, which is startling when nobody pressed anything.
  if (process.platform === 'darwin') return `screencapture -x "${to}"`;

  // Two of the several things a Linux desktop might have. Tried in turn.
  return `(command -v gnome-screenshot >/dev/null && gnome-screenshot -f "${to}") || ` +
    `(command -v import >/dev/null && import -window root "${to}")`;
}

/** Old enough that nobody is coming back to it. */
const KEEP_FOR_MS = 30 * 60 * 1000;

export function screensFolder(): string {
  const folder = join(config.dataDir, 'screens');
  mkdirSync(folder, {recursive: true});
  return folder;
}

/**
 * Throws away captures older than half an hour.
 *
 * Run before taking a new one rather than on a timer: a timer is a thing that
 * can fail to be running, and this only matters at the moment another picture
 * is about to be added to the pile.
 */
export function sweep(): void {
  const folder = screensFolder();
  const now = Date.now();

  for (const name of readdirSync(folder)) {
    if (!name.endsWith('.png')) continue;
    const path = join(folder, name);
    try {
      if (now - statSync(path).mtimeMs > KEEP_FOR_MS) rmSync(path, {force: true});
    } catch {
      // Being unable to tidy up is not a reason to refuse to take a picture.
    }
  }
}

export interface Capture {
  ok: boolean;
  path?: string;
  why?: string;
}

export async function captureScreen(
  run: (command: string, folder: string) => Promise<{ok: boolean; detail: string}>,
): Promise<Capture> {
  sweep();

  const folder = screensFolder();
  const path = join(folder, `screen-${Date.now()}.png`);
  const command = captureCommand(path);

  if (!command) {
    return {ok: false, why: `I do not know how to photograph the screen on ${process.platform}.`};
  }

  const done = await run(command, folder);
  if (!done.ok) {
    return {
      ok: false,
      why:
        `the screen could not be captured: ${done.detail.trim() || 'no reason given'}` +
        (process.platform === 'linux'
          ? '. On Linux this needs gnome-screenshot or ImageMagick installed.'
          : ''),
    };
  }

  try {
    if (statSync(path).size > 0) return {ok: true, path};
  } catch {
    // Fall through to the same answer: the command claimed success and there
    // is no picture, which is worth saying rather than passing on an empty file.
  }

  return {ok: false, why: 'the capture command succeeded but produced no image.'};
}
