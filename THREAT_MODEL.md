# What Tacita protects, and what it doesn't

Tacita is end-to-end encrypted: **the server never sees the content of a message.**
That sentence is exact, and this document is where its edges are drawn. Everything
below is a property of the system as shipped, not a roadmap.

If you are deciding whether to trust Tacita with your conversations, read this page
before the README.

## Who Tacita protects you from

- **Anyone on the network** between your device and the server.
- **Anyone who obtains the server's database or its object storage**, for message
  content: rooms are encrypted with Megolm, media blobs are encrypted client-side
  before upload, and the server stores opaque bytes.
- **Anyone who compromises the server and reads it going forward**, for the content
  of messages sent while they are not holding a recovery key — see the limits below.

## Who Tacita does not protect you from

**The operator of your server, for everything that isn't message content.** Tacita is
self-hosted software; the deployment model assumes the operator is you, your household,
or someone you already trust with your social life. Every limit on this page is
tolerable because of that assumption, and stops being tolerable the moment you host
for strangers.

## What the server always sees

Encryption covers content. It does not cover metadata, and Tacita does not pretend
otherwise.

- **The social graph.** Who talks to whom, in which rooms, with whom else.
- **Activity patterns.** When you are online, when you send, how often, how long a
  conversation runs.
- **The exact byte size of every attachment.** Encryption here does not pad: the
  ciphertext is the same length as the plaintext. At a roughly constant bitrate,
  `size ÷ bitrate ≈ duration` — so **the server can infer the length of every video
  and every voice note**, even though the duration field itself is inside the
  encrypted event. A thumbnail is a second blob whose size and timestamp correlate
  with the first.
- **Reactions**, which are sent unencrypted, and **pinned message lists**, which are
  room state rather than encrypted content.

This is a deliberate trade, not an oversight. Padding attachments would cost bandwidth
to close one window in a wall that has no others: an observer who already has your
contact list and the rhythm of your conversations learns little more from a video's
length. If your threat model includes an operator doing traffic analysis, Tacita is
the wrong tool, and padding alone would not make it the right one.

## The recovery key

The recovery key is the most powerful secret in the system. It does three things, and
you should know all three before you write it down.

**1. It decrypts your entire history.** It unlocks the secret storage, not a single
message. Anyone holding it can read everything in the account, past and future.

**2. The server sees it when you change your password.** Changing a password is
guarded by the recovery key and nothing else — the check happens server-side, so it
holds against any client. The consequence is that the key travels to the server in
the clear on every password change. The module verifies it and discards it, but
*not stored is not the same as not seen*: a hostile, compromised, or over-logging
server keeps what passed in front of it.

**This exposure cannot be undone.** The only way to replace a recovery key also
replaces the backup and the cross-signing identity, which makes everything encrypted
under the old key unreadable. After an incident, the choice is to keep a key you know
was exposed, or to lose your history. A non-destructive rotation is conceivable; it
does not exist here.

**3. It opens a session on its own.** If you lose your password, your username plus
your recovery key logs you in — the deployment has no email, no SSO, and no security
questions, so without this a forgotten password would mean a permanently dead account.
The endpoint is unauthenticated and rate-limited per IP, and it refuses every failure
identically (unknown account, no key, wrong key) so it cannot be used to enumerate
accounts.

The consequence is direct: **taking over an account used to require two secrets, and
now requires one** — and it is the one we ask you to write down. "Keep your recovery
key as carefully as your password" is not general caution. It is the thing protecting
your account.

## Your password protects your encrypted history

The secret storage key is derived from your account password (PBKDF2), so that logging
in on a new device unlocks your history without asking you for anything extra.

The derivation parameters — salt, iteration count, IV, MAC — live in account data,
which the server can read. **Anyone who reads that can mount an offline attack against
your password**, and a weak password then yields the key that decrypts everything. The
server enforces a 12-character minimum. Choose a real password; on this deployment it
is not merely a login credential.

## Known gaps

- **Changing your password does not re-derive your key.** After a change, the key
  still corresponds to the old password, so silent unlock stops working and each new
  device asks for the recovery key once. Nobody is locked out — the written key still
  works — but "your password is enough" has a hole here, and this is it.
- **Registration is open.** Anyone who can reach the server can create an account.
  There is no email verification and no captcha, and rate limits are loosened well
  beyond the defaults. The response to an unwanted account is to disable it by hand.
- **The user directory is enumerable.** Any local account can list the others by
  prefix. With open registration, that means the server's user list is available to
  anyone willing to spend thirty seconds signing up.
- **The access token is stored unencrypted** in the browser's IndexedDB, and a
  restored token is not revalidated at startup.
- **"Delivered" receipts are a Tacita extension.** Matrix defines only `m.read`. Ours
  is not a standard guarantee and is never presented as one.
- **Push notifications carry no message content** — by construction, since the service
  worker holds no Megolm keys. A notification for a closed app shows who wrote, never
  what: the payload carries the sender's ID and display name, metadata the server
  already holds in clear, encrypted to the device (RFC 8291) so the push service cannot
  read it.
- **The push gateway receives the full Synapse event.** Synapse has no "sender only"
  pusher format, so the gateway gets the event with its content *encrypted*, plus the
  room name and counters. It forwards four fields to the browser and logs none of the
  body.

## What would change all of this

One thing, above every other: **hosting for people who are not part of your circle.**
Every limit above is accepted because the operator is the person taking the risk. When
the operator carries the risk for others instead, the recovery key limits, open
registration, and the directory all need to be reopened before anything else.

## Reporting a problem

Please read [SECURITY.md](SECURITY.md). If you find something that contradicts this
page, that is a bug in the software or a bug in this page, and both are worth an issue.
