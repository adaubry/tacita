import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  canEdit,
  canRedact,
  edit,
  messages,
  messageText,
  react,
  reactions,
  REACTIONS_METADATA,
  redact,
  reply,
  replyRelation,
  replyTo,
  replyToOf,
  sendText,
  subscribe,
} from "../src";
import { fakeEvent, fakeSession } from "./session-mock";

const ROOM = "!salon:tacita.test";

let ctx: ReturnType<typeof fakeSession>;

beforeEach(() => {
  ctx = fakeSession();
});

const lastSend = () => ctx.client.sendEvent.mock.calls.at(-1)!;

/** Les interdits portent sur ce que le package exécute, pas sur ce qu'il documente. */
const codeOf = (...names: string[]) =>
  names
    .map((name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf-8"))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

describe("envoi et réception de messages texte chiffrés", () => {
  it("envoie un m.room.message via la Session", async () => {
    await sendText(ctx.session, ROOM, "salut");
    const [roomId, type, content] = lastSend();
    expect(roomId).toBe(ROOM);
    expect(type).toBe("m.room.message");
    expect(content).toMatchObject({ msgtype: "m.text", body: "salut" });
  });

  it("refuse d'envoyer dans un salon non chiffré", async () => {
    ctx.crypto.isEncryptionEnabledInRoom.mockResolvedValue(false);
    await expect(sendText(ctx.session, ROOM, "salut")).rejects.toThrow(/non chiffré/);
    expect(ctx.client.sendEvent).not.toHaveBeenCalled();
  });

  it("réception : les messages du salon viennent de la timeline de la Session", () => {
    ctx.setTimeline([fakeEvent("$a", { body: "un" }), fakeEvent("$b", { body: "deux" })]);
    expect(messages(ctx.session, ROOM).map((event) => event.getId())).toEqual(["$a", "$b"]);
  });

  it("le signal de changement est branché sur l'émetteur du SDK", () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(ctx.session, ROOM, listener);
    expect(ctx.client.on).toHaveBeenCalledWith("Room.timeline", expect.any(Function));
    unsubscribe();
    expect(ctx.client.off).toHaveBeenCalledWith("Room.timeline", expect.any(Function));
  });
});

describe("déduplication par txnId, mécanisme natif du SDK", () => {
  it("rejouer la même requête avec le même txnId produit le même event_id", async () => {
    const first = await sendText(ctx.session, ROOM, "salut", { txnId: "txn-1" });
    const second = await sendText(ctx.session, ROOM, "salut", { txnId: "txn-1" });

    expect(second.event_id).toBe(first.event_id);
    expect(ctx.client.sendEvent.mock.calls.map((call) => call[3])).toEqual(["txn-1", "txn-1"]);
  });

  it("sans txnId fourni, aucun n'est fabriqué ici : c'est makeTxnId du SDK qui s'en charge", async () => {
    await sendText(ctx.session, ROOM, "salut");
    expect(lastSend()[3]).toBeUndefined();
  });

  it("aucune déduplication maison n'est empilée par-dessus", () => {
    expect(codeOf("messages.ts")).not.toMatch(/makeTxnId|randomUUID|crypto\.randomUUID/);
  });
});

describe("réponse via m.in_reply_to", () => {
  it("attache la relation au message cité", async () => {
    await reply(ctx.session, ROOM, "$cible", "d'accord");
    expect(lastSend()[2]).toMatchObject({
      msgtype: "m.text",
      body: "d'accord",
      "m.relates_to": { "m.in_reply_to": { event_id: "$cible" } },
    });
  });
});

describe("la réponse, dans les deux sens", () => {
  it("écrit la relation `m.in_reply_to`", async () => {
    await reply(ctx.session, ROOM, "$cible", "oui");
    expect(lastSend()[2]).toMatchObject({
      body: "oui",
      "m.relates_to": { "m.in_reply_to": { event_id: "$cible" } },
    });
  });

  /**
   * Le côté lecture manquait, et c'est ce qui empêchait le shard de montrer à quel
   * message une réponse répond : le `body` porte bien une citation en `> `, mais
   * `messageText` la retire, et elle ne dit ni qui ni quoi quand le message
   * cité est une photo.
   */
  it("relit la cible depuis l'événement comme depuis un contenu en file", () => {
    const evenement = fakeEvent("$reponse", replyRelation("$cible"));
    expect(replyTo(evenement as never)).toBe("$cible");
    // La file d'envoi tient un contenu, pas encore un événement : l'affichage
    // optimiste doit citer aussi bien qu'un message revenu de /sync.
    expect(replyToOf(replyRelation("$cible"))).toBe("$cible");
  });

  it("un message ordinaire ne répond à rien, et une relation malformée non plus", () => {
    expect(replyTo(fakeEvent("$a", { body: "x" }) as never)).toBeUndefined();
    expect(replyToOf({ "m.relates_to": { "m.in_reply_to": { event_id: 42 } } })).toBeUndefined();
    expect(replyToOf(undefined)).toBeUndefined();
    // Une édition est une relation, mais pas une réponse.
    expect(replyToOf({ "m.relates_to": { rel_type: "m.replace", event_id: "$c" } })).toBeUndefined();
  });
});

describe("réactions emoji en clair, métadonnée exposée", () => {
  it("envoie une annotation m.reaction", async () => {
    await react(ctx.session, ROOM, "$cible", "👍");
    const [, type, content] = lastSend();
    expect(type).toBe("m.reaction");
    expect(content).toEqual({
      "m.relates_to": { rel_type: "m.annotation", event_id: "$cible", key: "👍" },
    });
  });

  it("expose cleartext: true avec la raison", () => {
    expect(REACTIONS_METADATA.cleartext).toBe(true);
    expect(REACTIONS_METADATA.reason).toMatch(/agrég/i);
  });

  it("la limite est documentée, pas masquée", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf-8");
    expect(readme).toMatch(/réaction/i);
    expect(readme).toMatch(/clair/i);
  });

  it("relit les réactions agrégées : emoji, compte, et la mienne", () => {
    const salon = fakeSession({
      reactions: [
        { key: "👍", sender: "@alice:tacita.test" },
        { key: "👍", sender: "@bob:tacita.test" },
        { key: "🎉", sender: "@alice:tacita.test" },
      ],
    });

    expect(reactions(salon.session, ROOM, "$cible")).toEqual([
      { key: "👍", count: 2, mine: true },
      { key: "🎉", count: 1, mine: false },
    ]);
  });

  it("une réaction retirée ne compte pas — sinon l'emoji reste sans personne derrière", () => {
    const salon = fakeSession({
      reactions: [
        { key: "👍", sender: "@alice:tacita.test", redacted: true },
        { key: "👍", sender: "@bob:tacita.test" },
      ],
    });

    expect(reactions(salon.session, ROOM, "$cible")).toEqual([{ key: "👍", count: 1, mine: true }]);
  });

  /**
   * Le défaut signalé par les utilisateurs : « les réactions d'un message peuvent être
   * spam (pas 1 par utilisateur) ». `react` ne savait qu'ajouter, et le `ToggleButton`
   * de la timeline appelait donc un envoi de plus à chaque appui — le compteur montait
   * sans fin, et rien ne redescendait jamais.
   */
  it("réagir deux fois avec le même emoji le retire au lieu de l'empiler", async () => {
    const salon = fakeSession({
      reactions: [{ key: "👍", sender: "@bob:tacita.test", id: "$mienne" }],
    });

    await react(salon.session, ROOM, "$cible", "👍");

    expect(salon.client.redactEvent).toHaveBeenCalledWith(ROOM, "$mienne", undefined);
    expect(salon.client.sendEvent).not.toHaveBeenCalled();
  });

  it("l'emoji d'un autre n'est pas le mien : réagir l'ajoute, sans rien retirer", async () => {
    const salon = fakeSession({
      reactions: [{ key: "👍", sender: "@alice:tacita.test", id: "$sienne" }],
    });

    await react(salon.session, ROOM, "$cible", "👍");

    expect(salon.client.redactEvent).not.toHaveBeenCalled();
    expect(salon.client.sendEvent.mock.calls.at(-1)![1]).toBe("m.reaction");
  });

  /**
   * La bascule empêche d'en écrire de nouveaux ; elle n'efface pas ceux qui sont déjà
   * dans les salons. Le compte est donc **par personne**, sinon un message spammé hier
   * resterait affiché avec son « 👍 7 » pour toujours.
   */
  it("un même émetteur ne compte qu'une fois, même s'il a déjà empilé", () => {
    const salon = fakeSession({
      reactions: [
        { key: "👍", sender: "@alice:tacita.test" },
        { key: "👍", sender: "@alice:tacita.test" },
        { key: "👍", sender: "@alice:tacita.test" },
        { key: "👍", sender: "@bob:tacita.test" },
      ],
    });

    expect(reactions(salon.session, ROOM, "$cible")).toEqual([{ key: "👍", count: 2, mine: true }]);
  });
});

describe("modification, suppression, et droits par message", () => {
  it("l'édition passe par m.replace avec m.new_content", async () => {
    await edit(ctx.session, ROOM, "$cible", "corrigé");
    expect(lastSend()[2]).toMatchObject({
      body: "* corrigé",
      "m.new_content": { msgtype: "m.text", body: "corrigé" },
      "m.relates_to": { rel_type: "m.replace", event_id: "$cible" },
    });
  });

  it("la suppression passe par une redaction", async () => {
    await redact(ctx.session, ROOM, "$cible");
    expect(ctx.client.redactEvent).toHaveBeenCalledWith(ROOM, "$cible", undefined);
  });

  it("modifiable seulement par l'auteur", () => {
    const mien = fakeEvent("$a", { body: "x" }, "@bob:tacita.test");
    const autre = fakeEvent("$b", { body: "x" }, "@alice:tacita.test");
    expect(canEdit(ctx.session, ROOM, mien as never)).toBe(true);
    expect(canEdit(ctx.session, ROOM, autre as never)).toBe(false);
  });

  it("modifiable seulement si l'utilisateur peut encore poster", () => {
    const muet = fakeSession({ maySendEvent: false });
    const mien = fakeEvent("$a", { body: "x" }, "@bob:tacita.test");
    expect(canEdit(muet.session, ROOM, mien as never)).toBe(false);
  });

  it("supprimable selon les droits de redaction du SDK", () => {
    const event = fakeEvent("$a", { body: "x" }, "@alice:tacita.test");
    expect(canRedact(ctx.session, ROOM, event as never)).toBe(true);
    expect(ctx.room.currentState.maySendRedactionForEvent).toHaveBeenCalled();

    const sansDroit = fakeSession({ mayRedact: false });
    expect(canRedact(sansDroit.session, ROOM, event as never)).toBe(false);
  });
});

describe("extraction du texte pour copie", () => {
  it("rend le corps du message", () => {
    expect(messageText(fakeEvent("$a", { body: "salut" }) as never)).toBe("salut");
  });

  it("rend le texte édité plutôt que le fallback étoilé", () => {
    const edited = fakeEvent("$a", {
      body: "* corrigé",
      "m.new_content": { body: "corrigé" },
    });
    expect(messageText(edited as never)).toBe("corrigé");
  });

  it("retire la citation que Matrix préfixe aux réponses", () => {
    const answer = fakeEvent("$a", { body: "> <@alice:tacita.test> question\n\nréponse" });
    expect(messageText(answer as never)).toBe("réponse");
  });

  it("rend une chaîne vide sur un événement sans corps texte", () => {
    expect(messageText(fakeEvent("$a", {}) as never)).toBe("");
  });
});

describe("ordre repris de OrderedTimeline, aucun tri propre", () => {
  it("conserve l'ordre de la timeline malgré des timestamps décroissants", () => {
    ctx.setTimeline([
      fakeEvent("$a", { body: "un" }),
      fakeEvent("$reaction", {}, "@bob:tacita.test", "m.reaction"),
      fakeEvent("$b", { body: "deux" }),
    ]);
    expect(messages(ctx.session, ROOM).map((event) => event.getId())).toEqual(["$a", "$b"]);
    expect(ctx.session.timeline).toHaveBeenCalledWith(ROOM);
  });

  it("aucun tri n'est écrit dans le package", () => {
    const code = codeOf("messages.ts", "rooms.ts", "typing.ts", "mentions.ts", "index.ts");
    expect(code).not.toMatch(/\.sort\(|origin_server_ts|getTs\(/);
  });
});

describe("déchiffrement et suppression redemandent un rendu", () => {
  it("s'abonne aussi à MatrixEventEvent.Decrypted, et se désabonne des deux", () => {
    // Un message entre dans la timeline **chiffré** ; son texte n'existe qu'au
    // `Decrypted` qui suit, parfois bien plus tard — la clé Megolm arrive par to-device.
    // Sans cet écouteur, rien ne redemandait de rendu : mesuré au navigateur le
    // 08/08/2026, une conversation rouverte affichait une heure et un nom, sans texte.
    const rafraichir = vi.fn();
    const off = subscribe(ctx.session, ROOM, rafraichir);

    const ecoutes = ctx.client.on.mock.calls.map((appel: unknown[]) => appel[0] as string);
    expect(ecoutes).toContain("Room.timeline");
    expect(ecoutes).toContain("Event.decrypted");
    // Une suppression non plus n'est pas un événement de timeline : le SDK émet
    // `Room.redaction` et vide l'événement sur place. Sans elle, l'auteur voyait son
    // message partir et le destinataire continuait de le lire.
    expect(ecoutes).toContain("Room.redaction");

    // Le désabonnement doit couvrir les deux : un écouteur oublié survit au changement
    // de salon et fait rendre une conversation qu'on ne regarde plus.
    off();
    const relaches = ctx.client.off.mock.calls.map((appel: unknown[]) => appel[0] as string);
    expect(relaches).toEqual(expect.arrayContaining(ecoutes));
  });
});

describe("une modification remplace, elle ne s'ajoute pas à la timeline", () => {
  it("l'événement `m.replace` n'est pas rendu à côté de l'original", () => {
    // Un `m.replace` est lui aussi un `m.room.message`. Le SDK réécrit le contenu de
    // l'original sur place : le garder tous les deux affichait **deux fois** le même
    // texte. Mesuré au navigateur, entre deux sessions réelles — et la
    // suppression n'en effaçait qu'un, la redaction ne visant que l'original.
    ctx.setTimeline([
      fakeEvent("$original", { body: "corrigé" }),
      fakeEvent("$edition", {
        body: "* corrigé",
        "m.new_content": { body: "corrigé" },
        "m.relates_to": { rel_type: "m.replace", event_id: "$original" },
      }),
    ]);

    expect(messages(ctx.session, ROOM).map((event) => event.getId())).toEqual(["$original"]);
  });
});
