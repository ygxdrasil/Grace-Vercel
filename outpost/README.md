# The outpost

The machine that holds Grace's voice open.

## Why it exists

Grace lives on Vercel, where every request is answered and then forgotten,
with a sixty-second ceiling. That is a fine home for an assistant who is
asked questions. It cannot host a conversation, because a conversation is one
connection held open for minutes with audio moving both ways at once.

So this runs on a small always-on machine whose entire job is to hold that
connection. Your browser opens a socket to here; this opens a socket to
Google; audio flows through. Nothing is stored here.

## What it is not

A second Grace. It holds no memory, makes no decisions, and owns none of her
tools. When the model wants to do something, the request is forwarded to the
real Grace and her answer comes back — same permissions, same confirmations,
same memory. There is one Grace, and she is on Vercel. This is a wire.

## Setting it up

Run this in [Google Cloud Shell](https://shell.cloud.google.com), which
already has `gcloud` and is already signed in as you. Nothing is installed on
your own computer.

```bash
export GRACE_URL=https://your-grace-address
export GRACE_OUTPOST_TOKEN=the-token-from-her-side-panel
bash setup.sh
```

It is safe to run more than once — everything it creates is checked for
first, so a second run repairs rather than duplicates. Which matters, because
the usual reason to run it again is that something went wrong halfway.

## What it costs

An `e2-small` is roughly £10/month, billed from the Google credit while that
lasts. Stop it when you are not using it and it costs nothing but the disk:

```bash
gcloud compute instances stop grace-outpost --zone=europe-north1-b
```

Not `e2-micro`, despite it being free. One gigabyte of memory is spent on the
operating system, and Node plus a browser for the web agent does not fit.
Discovering that as random out-of-memory kills weeks later is worse than the
few pounds.

## Security

- The only port open from outside is 443. The service itself listens on
  localhost, with Caddy in front holding the certificate.
- The machine carries **no key**. It is given an identity when it is created
  and asks Google for a fresh token when it needs one, so there is nothing on
  disk to steal.
- Tokens are checked against Grace on every connection rather than against a
  copy kept here — so replacing the token in her side panel drops every live
  conversation at once, which is what that button claims to do.
