***English** · [Français](README.fr.md)*

<div align="center">

# Tacita

**Self-hosted, end-to-end encrypted messaging for a closed circle.**

One command deploys the whole stack on your own server; your family or friends install
it from the browser as an app. It replaces Instagram DMs and group chats, without the
surveillance and without the ads.

[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg?style=flat-square)](LICENSE)
![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange.svg?style=flat-square)
![Protocol: Matrix](https://img.shields.io/badge/protocol-Matrix-000.svg?style=flat-square)
![Node: 22+](https://img.shields.io/badge/node-22%2B-5FA04E.svg?style=flat-square)
![Ubuntu 22.04 / 24.04](https://img.shields.io/badge/ubuntu-22.04%20%7C%2024.04-E95420.svg?style=flat-square)

</div>

<!-- HERO: replace with a screenshot of a conversation, mobile, dark theme.
     Then add a 3-shot grid: conversation · call · settings.
     ![Tacita](assets/hero.png) -->

> [!WARNING]
> Read **[THREAT_MODEL.md](THREAT_MODEL.md)** before you trust Tacita with anything.
> It is the honest version of the sentence above: what the encryption covers, what it
> does not, and where the sharp edges are — starting with the recovery key.

## Overview

Tacita is not an app you point at someone else's server. It is the **entire stack**,
deployed as one unit on a machine you control:

| Component | Role |
| --- | --- |
| **Synapse** | Matrix homeserver, encrypted rooms |
| **PostgreSQL** | its database |
| **Garage** | S3 object storage for encrypted media blobs |
| **LiveKit + Element Call** | voice and video calls, in a widget |
| **nginx** | TLS termination, Let's Encrypt certificates |
| **Push gateway** | Web Push (VAPID) relay — Sygnal only speaks APNs and FCM |
| **Invite service** | short-lived invite links, resolved to a user ID |
| **The PWA** | a mobile-first web app installed from the home screen |

If you want a client for an existing Matrix account, use [Element](https://element.io) —
it is excellent, and this is not that. If you want a private messenger for a dozen
people that lives entirely on your box, that is what this is.

## Features

- **End-to-end encrypted** conversations, direct and group, Rust crypto (vodozemac) — [`messaging`](packages/messaging)
- **Voice and video calls** through Element Call, encrypted, no home-made RTC client — [`calls`](packages/calls)
- **Photos, video, voice notes and files**, encrypted client-side, one single pipeline — [`media-pipeline`](packages/media-pipeline)
- **Offline first** — read, search and compose with no connection, and a reload loses nothing — [`outbox`](packages/outbox)
- **Local search** over your own history, in a Web Worker, never on the server — [`search`](packages/search)
- **Replies, reactions, edits, pins, mentions, typing**, and `sending → sent → delivered → read` — [`receipts`](packages/receipts)
- **Installable** on iOS and Android, with push notifications that carry no content — [`push-gateway`](apps/push-gateway)
- **Invite links** with a bounded lifetime: an existing user adds an existing user — [`invite-tokens`](apps/invite-tokens)

## What the server can see

The server never sees message content. It does see metadata, and the difference matters:

- **who talks to whom**, in which rooms, and when
- **the exact byte size of every attachment** — which, at a near-constant bitrate, gives
  away the duration of every video and every voice note
- **reactions**, which are sent unencrypted, and **pinned lists**, which are room state

> [!CAUTION]
> Your **recovery key** reaches the server when you change your password, it decrypts
> your entire history, and it opens a session on its own. This is tolerable because you
> are the operator. It stops being tolerable the moment you host for strangers.

All of it, in full: **[THREAT_MODEL.md](THREAT_MODEL.md)**.

## Getting started

### Requirements

- **Ubuntu 22.04 or 24.04**, root or sudo. On other distributions, install Node 22+,
  pnpm, Docker with the compose v2 plugin and certbot yourself, then run the script.
- **4 GB RAM recommended**, 2 GB minimum with swap. The web app is compiled on your
  machine during install, because the build inlines your domain into the bundle — this
  is the heaviest moment of the install by a wide margin.
- **A domain** with an `A` record for it *and* for `call.<your-domain>`.

> [!IMPORTANT]
> Open ports: `80/tcp` (certbot, during the certificate challenge only), `443/tcp`,
> `3478/udp` and `5349/tcp` (TURN), `7881/tcp` and `50000-50100/udp` (call media).
> [`install.sh`](install.sh) opens the RTC ones itself when `ufw` is present. Miss them and a call
> connects, shows the participants, then dies at 15–20 seconds with nothing said.

### Install

On a fresh server with a domain pointed at it:

```sh
git clone https://github.com/adamAubry/tacita.git
cd tacita
./install.sh --domaine=chat.example.org --email=you@example.org
```

Six steps: prerequisites, configuration, DNS, certificate, stack, verification. The
script is **resumable** — if it stops, fix what it names and run it again; it picks up
where it was, and never redoes what is already done.

When it finishes, open your domain and create the first account from the app.
Registration is open by design on a private box: see [THREAT_MODEL.md](THREAT_MODEL.md)
if that is not your situation.

> [!TIP]
> `./install.sh --dev` installs on a local machine with a self-signed certificate, and
> `--oui` skips every confirmation for an unattended run.

### Administration

The `admin` CLI has no dependencies — it runs straight after `git clone`, without
`pnpm install`, on Node 22+ alone.

```sh
pnpm admin init --domaine=chat.example.org --email=you@example.org
pnpm admin dns          # the two A records to create, and their current state
pnpm admin certificat   # issues the TLS certificate, once DNS is in place
pnpm admin doctor       # diagnoses a running stack without touching it
```

Each command names the next one. An unknown option stops the command instead of being
ignored: `--domain` answers *"did you mean `--domaine`?"*.

## Project structure

A pnpm monorepo. The packages are headless — zero DOM, zero business logic in the UI.

```
apps/
  web/            Next.js 15 PWA (App Router, Astryx UI) — composes the packages
  admin/          the self-hoster's CLI: init, dns, certificat, doctor
  push-gateway/   Matrix Push Gateway → Web Push (VAPID)
  invite-tokens/  invite links, resolved to a user ID and nothing else
packages/
  client-core/    session, crypto, store, sync — the only place matrix-js-sdk lives
  messaging/      DMs and groups, encrypted send, replies, reactions, edits, pins
  outbox/         persistent send queue in IndexedDB, survives a reload
  receipts/       sending → sent → delivered → read, observable per event
  media-pipeline/ compress → encrypt → upload, and its inverse
  search/         Orama index in a Web Worker, persisted in IndexedDB
  calls/          MatrixRTC orchestration, Element Call widget URL and driver
infra/            config-as-code: compose files, Synapse, nginx, LiveKit, smoke tests
```

Every package carries its own `README.md` with its interface contract and its **accepted
limits**. Those limits are not marketing copy: several of them are enforced by tests that
fail if the README stops saying them.


## Status

Pre-1.0 - The project distinguishes two gates:

```sh
npm test        # unit and configuration tests, mocks, no external dependency
npm run smoke   # real Synapse, real crypto, real IndexedDB (needs Docker)
```

**Proven at runtime:** Rust crypto actually loading, a room genuinely encrypted
server-side, the encrypt → server → decrypt round trip, and session resume with no
network.

> [!NOTE]
> **Not proven:** everything else. The push gateway end to end (verified by hand once,
> no test replays it), media against a real server, LiveKit under load. Nothing has been
> rendered in a real browser by an automated test — [`apps/web/README.md`](apps/web/README.md)
> lists what that leaves unverified.

## Documentation

| Document | What it covers |
| --- | --- |
| [THREAT_MODEL.md](THREAT_MODEL.md) | what is protected, what is not, and why |
| [`infra/README.md`](infra/README.md) | the server stack, in detail |
| [`apps/web/README.md`](apps/web/README.md) | the PWA, and what it does not prove |
| `packages/*/README.md` | one contract and one limits list per module |
