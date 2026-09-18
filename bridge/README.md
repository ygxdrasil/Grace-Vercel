# The bridge

Grace runs on a server somewhere else. Your files are not there, your terminal
is not there, and your PlayStation only takes orders from something on your own
Wi-Fi.

So this small program runs on the machine that's already switched on. It asks
Grace whether she's left an instruction, does it, and tells her what happened.

It only ever dials out. Nothing here listens on a port, so there's no router
setting to change and nothing on your home network becomes reachable from
outside. An instruction exists only because your machine went and asked
whether there was one.

## What she can actually do

| | |
|---|---|
| List a folder | ✅ |
| Read a text file | ✅ |
| Write a new file | ✅ |
| Overwrite a file that exists | ✅ — asks first |
| Delete a file | ✅ — asks first |
| Run a command in your terminal | ✅ — asks first if it could destroy something |
| Turn the PlayStation on, or put it to rest | ✅ |
| Open a page on your screen, lock the machine | ✅ |
| Start a specific game, press buttons | ❌ |

The last one isn't about trust. A PS5 won't accept it from anything except a
live Remote Play session, which is a different piece of software entirely.
She'll say so rather than pretend she tried.

## Where she can reach

**Your home folder, and nothing else** — unless you say otherwise.

Set `roots` in `config.json` to change it. It's a list, so you can add an
external drive or a projects folder somewhere else, or narrow it to a single
directory if you'd rather she were nowhere near the rest:

```json
"roots": ["~/Documents", "/Volumes/Work"]
```

This is enforced **here**, on your machine, not by Grace. Paths are resolved
through symlinks and `..` before they're checked, so a path that merely looks
like it's inside your home folder doesn't get in. That separation is
deliberate: everything on her side of the wire was composed by a language
model, and a check that runs where the request was written isn't a check.

## What stops and asks

Deleting, overwriting, and commands that could destroy something (`rm`, `mv`,
`sudo`, `>`, force-pushes, and a long list besides) are held until you say yes
in your own words. That's the rule you set — she can get on with anything she
can undo, and stops for anything she can't.

**Be straight with yourself about the limit.** The check on commands reads the
command line, so it catches every ordinary way to lose a folder and it is not
a proof. A script whose name gives nothing away, or a Python one-liner, can
destroy something without matching any pattern. `roots` is the boundary that
actually holds; the confirmation is a very good seatbelt, not a locked door.
If that trade isn't one you want, narrow `roots` to a folder you don't mind
losing.

She also can't reach anything outside `roots`, so the bridge's own
`config.json` — and the token in it — is only readable if you put `roots`
somewhere that includes it.

## Setting it up

Do this once, on the laptop that stays on. You need **Node 18 or newer** —
check with `node --version`. If you can't install things on that machine, see
*No administrator rights* below.

**1. Get the program.** In Grace, open the side panel and press **Download the
bridge** under *The laptop bridge*. That's the whole thing — one file, no
dependencies to install.

**2. Install playactor**, in the same folder you saved `bridge.mjs` to. This
is the piece that knows how to pair with a console:

```
npm install playactor
```

If `npm` is blocked — see *When batch files are blocked* below — run it as
plain JavaScript instead, which is never blocked:

```
node <your-node-folder>\node_modules\npm\bin\npm-cli.js install playactor
```

**3. Pair with the console.** Turn the PS5 on first, then:

```
node node_modules\playactor\dist\cli\index.js login --ps5
```

It opens a browser to sign in to PlayStation, then asks for an eight-digit
code. On the console that's **Settings → System → Remote Play → Link Device**.
Type in the number it shows. This is the same pairing Remote Play uses, and
you only do it once.

**4. Start it.** In Grace, press **Copy command** — it already has her
address and your token in it. Paste it into the terminal:

```
node bridge.mjs https://your-grace-address YOUR-TOKEN
```

You should see it find the console. Now ask Grace to turn on your PlayStation.

## Keeping it running

The point is that it's always there, so it should start with the laptop.

**Windows** — press `Win+R`, type `shell:startup`, and put a file called
`grace-bridge.cmd` in the folder that opens:

```
cd /d C:\path\to\the\folder
node bridge.mjs https://your-grace-address YOUR-TOKEN
```

**macOS** — System Settings → General → Login Items → add a small script that
runs `npm start` in this folder.

**Linux** — a systemd user service, or whatever your desktop uses for startup
programs.

## When it doesn't work

**"No console answered yet."** The PS5 is off at the wall, on a different
network, or the laptop is on a guest Wi-Fi that blocks broadcasts. If you know
the console's IP, put it in `config.json` as `ps5Ip` — that skips discovery.

**"Grace does not recognise this token."** The token in `config.json` doesn't
match the one in her side panel. Copy it again.

**"node is not recognised".** See *No administrator rights* below.

**"This program is blocked by group policy."** See the next section.

**Waking fails after pairing.** Rest mode has to be allowed to accept it:
on the console, **Settings → System → Power Saving → Features Available in
Rest Mode**, and turn on *Stay Connected to the Internet* and *Enable Turning
On PS5 from Network*. Without those the console genuinely cannot be woken by
anything, including Sony's own app.

## When batch files are blocked

On a managed laptop you will often find that `node.exe` runs perfectly while
`npm` and `npx` are refused outright:

    This program is blocked by group policy.

That is not about Node. `npm` and `npx` are `.cmd` batch files, and the policy
blocks batch files. The programs themselves are ordinary JavaScript, so
running them through node directly is allowed and does exactly the same thing.

Wherever these instructions say `npm something`, use:

```
node <your-node-folder>\node_modules\npm\bin\npm-cli.js something
```

The bridge itself never calls `npm` or `npx` for this reason — it runs
playactor's JavaScript with the same node that is already running it.

## No administrator rights

You don't need any. Node ships as a plain zip that runs from your own folder —
the installer is only a convenience.

**Windows**

1. Download <https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip>
2. Right-click it → **Extract All** → put it somewhere in your user folder,
   for example `C:\Users\you\node`
3. Open a terminal (Start → type `cmd`) and point it at that folder for this
   session:

   ```
   set PATH=C:\Users\you\node\node-v24.18.0-win-x64;%PATH%
   node --version
   ```

That version number is the proof it worked. Everything above now runs in that
same window. If you close it, run the `set PATH` line again — or put it as the
first line of the startup file described earlier, which is what you want
anyway.

**macOS**

```
curl -O https://nodejs.org/dist/v24.18.0/node-v24.18.0-darwin-arm64.tar.gz
tar xzf node-v24.18.0-darwin-arm64.tar.gz
export PATH="$PWD/node-v24.18.0-darwin-arm64/bin:$PATH"
node --version
```

(Use `darwin-x64` instead if the Mac is an older Intel one.)

Nothing here touches system folders, so nothing asks for a password.
