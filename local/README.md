# Grace, on your own machine

Everything on one computer: her thinking, her memory, her voice, her hands.
Nothing of yours leaves the machine except the model calls themselves, which
have to go to Google because that is where the model is.

## Start her

```
git clone https://github.com/ygxdrasil/Grace-Vercel
cd Grace-Vercel
npm run local
```

The first run asks for two things and works the rest out:

1. **A password.** She's reachable from anything on this computer — every
   program you run and every page you open can reach localhost — and she holds
   mail, a diary and a shell. It's worth a real one.
2. **The Google key.** Save the service-account JSON you downloaded from Google
   Cloud as `local/service-account.json`. It's the same file you pasted into
   Vercel. Nothing here reads it except Google's own library, it's in
   `.gitignore`, and it never leaves the machine.

Then open **http://localhost:7766**.

Everything else — the key that encrypts her memory, the ports, where her voice
lives — is decided for you and written to `.env.local`. That file holds your
secrets. Keep it, don't commit it (it's already ignored), and if you delete it
she forgets how to decrypt everything she remembers.

Stop her with Ctrl+C. Start her again with `npm run local`, which skips
everything it did last time and comes up in a couple of seconds.

## What's different from the hosted one

**Her hands are direct.** Listing a folder, reading a file, running a command:
no queue, no polling, no bridge, no token. She *is* the program on the machine.
The bridge is still there and still works, but it's for reaching a *different*
computer — you don't need it for this one.

**Her voice needs no Google VM.** The outpost existed because Vercel can't hold
a socket open for the length of a conversation. This can, so the same program
runs here and your browser opens its socket to localhost. Nothing in Sweden,
nothing to pay for, nothing to redeploy.

**Her memory never leaves.** It was always encrypted at rest; now the disk is
yours.

**What you lose, plainly:** she's reachable from this machine only. No phone,
nothing from another room, and nothing at all while the computer is asleep or
off. If you want both, run both — they're separate installs with separate
memories, and pointing them at one Google project is fine.

## Where she can reach

Her files default to your home folder. It's the `roots` setting, the same one
the bridge uses — see `bridge/README.md`, which explains the boundary and is
honest about what the command filter does and doesn't catch. Set it in
`.env.local`:

```
GRACE_ROOTS='/Users/you/Documents,/Volumes/Work'
```

Deleting, overwriting and commands that could destroy something still stop and
ask, and still do so with the machine policy set to "act freely" — that's a
promise rather than a setting, and there's a test that proves it.

## Keeping her running

**macOS** — System Settings → General → Login Items → add a script that runs
`npm run local` in this folder.

**Linux** — a systemd user service with `ExecStart=npm run local` and
`WorkingDirectory=` this folder.

**Windows** — `Win+R`, `shell:startup`, and a `.cmd` file that does
`cd /d C:\path\to\Grace-Vercel` then `npm run local`.

All three run without a terminal attached, so put `GRACE_PASSWORD` in
`.env.local` first (the first interactive run does this for you). Started that
way with something still missing, she says what to set and stops, rather than
waiting forever for an answer from a terminal that isn't there.

## When it doesn't work

**"She needs the Google service-account key to think."** Save it at the exact
path it names. A JSON file, not the contents pasted somewhere.

**The top bar says `RELAY FALLBACK`.** Her voice didn't connect. The voice half
logs to the same terminal — look for `[outpost]` lines. A `403` there means the
service account can't reach Vertex in this project; anything else, send me the
line.

**Port already in use.** Set `PORT` and `GRACE_VOICE_PORT` in `.env.local`.

**She can't see a folder you expected.** It's outside `roots`. She'll say so,
naming the path and the folders she's allowed — that message is the answer, not
a symptom.
