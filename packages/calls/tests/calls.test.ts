import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { WidgetDriver } from "matrix-widget-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";

import {
  activeCall,
  buildCallWidget,
  CALL_MEMBER_EVENT_TYPE,
  callMemberStateKey,
  CallWidgetDriver,
  discoverFocus,
  hangupLocal,
  RtcFociMissingError,
  RTC_FOCI_WELL_KNOWN_KEY,
} from "../src/index";

const HOMESERVER = "https://tacita.chat";
const SALON = "!salon:tacita.chat";
const MOI = "@bob:tacita.chat";
const APPAREIL = "DEVICE1";
const FOCUS = { type: "livekit", livekit_service_url: "https://tacita.chat/livekit/jwt" };

const WIDGET = {
  elementCallUrl: "https://call.tacita.chat",
  parentUrl: "https://app.tacita.chat",
  widgetId: "widget-1",
};

/** Un événement d'état réduit à ce que le module en lit. */
function membership(
  stateKey: string,
  content: Record<string, unknown>,
  ts = Date.now(),
  sender = MOI,
) {
  return {
    getType: () => CALL_MEMBER_EVENT_TYPE,
    getRoomId: () => SALON,
    getStateKey: () => stateKey,
    // L'émetteur, et non la state key découpée : `activeCall` nomme des personnes.
    getSender: () => sender,
    getContent: () => content,
    getTs: () => ts,
    getEffectiveEvent: () => ({
      type: CALL_MEMBER_EVENT_TYPE,
      sender: MOI,
      event_id: `$${stateKey}`,
      room_id: SALON,
      state_key: stateKey,
      content,
      origin_server_ts: ts,
      unsigned: {},
    }),
  };
}

type Membership = ReturnType<typeof membership>;

function fakeSession(state: Membership[] = []) {
  const handlers = new Set<(event: Membership) => void>();
  const events = [...state];
  return {
    events,
    emit(event: Membership) {
      for (const handler of handlers) handler(event);
    },
    client: {
      baseUrl: HOMESERVER,
      getUserId: () => MOI,
      getDeviceId: () => APPAREIL,
      getRoom: () => ({
        getLiveTimeline: () => ({
          getState: () => ({
            getStateEvents: (_type: string, stateKey?: string) =>
              stateKey === undefined
                ? events
                : (events.find((event) => event.getStateKey() === stateKey) ?? null),
          }),
        }),
      }),
      sendEvent: vi.fn(async () => ({ event_id: "$evt" })),
      sendStateEvent: vi.fn(async () => ({ event_id: "$state" })),
      sendToDevice: vi.fn(async () => ({})),
      encryptAndSendToDevice: vi.fn(async () => {}),
      getOpenIdToken: vi.fn(async () => ({ access_token: "openid_secret", matrix_server_name: "tacita.chat" })),
      getTurnServers: () => [
        { urls: ["turns:tacita.chat:443"], username: "u", credential: "turn_secret" },
      ],
      on: (_event: string, handler: (event: Membership) => void) => void handlers.add(handler),
      off: (_event: string, handler: (event: Membership) => void) => void handlers.delete(handler),
    },
  };
}

let fake: ReturnType<typeof fakeSession>;
let session: Session;

beforeEach(() => {
  vi.unstubAllGlobals();
  fake = fakeSession();
  // Ce paquet ne lit que `client`. `asSession` fournit le reste du contrat en
  // levées nommées : un membre ajouté à `Session` ne manque plus en silence.
  session = asSession({ client: fake.client });
});

const wellKnown = (body: unknown, ok = true) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 404 }));

describe("URL Element Call complète et paramétrée", () => {
  it("porte salon, identité et homeserver, sans aucun credential LiveKit", () => {
    const { url, params } = buildCallWidget(session, SALON, WIDGET);

    expect(url.startsWith("https://call.tacita.chat/room#?")).toBe(true);
    const fragment = new URLSearchParams(url.slice(url.indexOf("#?") + 2));
    expect(fragment.get("roomId")).toBe(SALON);
    expect(fragment.get("userId")).toBe(MOI);
    expect(fragment.get("deviceId")).toBe(APPAREIL);
    expect(fragment.get("baseUrl")).toBe(HOMESERVER);
    expect(fragment.get("widgetId")).toBe("widget-1");
    expect(fragment.get("parentUrl")).toBe("https://app.tacita.chat");
    expect(params.perParticipantE2EE).toBe("true");

    // L'autorisation SFU passe par lk-jwt : rien de LiveKit ne peut être en dur ici.
    expect(url).not.toMatch(/secret|api[_-]?key|token/i);
  });

  it("traduit le point d'entrée en `intent`, celui de la version épinglée", () => {
    // E-14 close. Relu dans `UserIntent` de la v0.23.0 : `start_call` ouvre
    // en vidéo, `start_call_voice` en audio, et les deux laissent le lobby.
    const audio = new URLSearchParams(buildCallWidget(session, SALON, WIDGET).params);
    expect(audio.get("intent")).toBe("start_call_voice");

    const video = new URLSearchParams(
      buildCallWidget(session, SALON, { ...WIDGET, video: true }).params,
    );
    expect(video.get("intent")).toBe("start_call");

    // Le lobby est le rattrapage : ne jamais l'escamoter, sinon une intention envoyée de
    // travers dépose quelqu'un dans un appel caméra allumée sans lui demander.
    expect(audio.get("skipLobby")).toBeNull();
    expect(video.get("skipLobby")).toBeNull();
  });

  /**
   * **`preload` est une impasse, pas une optimisation.** Relu dans le
   * bundle de l'image épinglée v0.23.0, `GroupCallView` :
   *
   *     if (skipLobby)
   *       if (widget && preload) { lazyActions.on("io.element.join", …) }
   *       else setJoined(true)
   *
   * `preload` veut dire « n'entre pas dans l'appel, attends que l'hôte envoie
   * `io.element.join` ». Rien dans ce dépôt n'envoie cette action, et rien ne doit
   * l'envoyer — c'est le mécanisme de lobby d'Element Web, dont le nôtre n'a pas besoin.
   *
   * **Mais il gouverne aussi le rendu**, et c'est la moitié qui coûtait un écran noir.
   * Toujours dans `GroupCallView`, à la fin :
   *
   *     } else if (preload || skipLobby) {
   *       body = null;          // ne peint rien
   *     } else {
   *       body = lobbyView;
   *     }
   *
   * Avec `preload` posé et l'appel non rejoint, Element Call rend donc `null` : plus une
   * ligne de journal, plus un pixel, et pas la moindre erreur. Constaté sur le
   * déploiement de staging — poignée de main complète, `GroupCallView`
   * monté, écran noir. Les deux gardes se refermaient ensemble : celle du rendu peignait
   * `null`, celle du join attendait une action que personne n'envoie.
   *
   * Il avait été posé pour obtenir `content_loaded` ; `sendContentLoaded()` est en fait
   * appelé sans condition à l'initialisation, également relu dans le bundle.
   */
  it("ne demande pas `preload` : ce serait attendre un `io.element.join` que personne n'envoie", () => {
    const { params } = buildCallWidget(session, SALON, WIDGET);
    expect(params.preload).toBeUndefined();
  });

  it("n'envoie plus les deux paramètres qu'Element Call ne lit pas", () => {
    // Ils étaient écrits de bonne foi et ne faisaient rien : `video` n'existe dans
    // aucune version, `hideHeader` a été remplacé par `header` (v0.23.0). Le test les
    // nomme pour qu'ils ne reviennent pas par recopie d'un exemple ancien.
    const { params } = buildCallWidget(session, SALON, { ...WIDGET, video: true });
    expect(params.video).toBeUndefined();
    expect(params.hideHeader).toBeUndefined();
    expect(params.header).toBe("none");
  });

  it("reste en mode widget, sans quoi `intent` ne serait même pas lu", () => {
    // `isWidget = !!widgetId && !!parentUrl` dans `UrlParams.ts` : hors de ce mode,
    // Element Call ignore l'intention et retombe sur ses défauts de SPA.
    const { params } = buildCallWidget(session, SALON, WIDGET);
    expect(params.widgetId).toBeTruthy();
    expect(params.parentUrl).toBeTruthy();
  });

  it("met les paramètres dans le fragment, jamais dans la requête HTTP", () => {
    const { url } = buildCallWidget(session, SALON, WIDGET);
    expect(url.slice(0, url.indexOf("#"))).not.toContain("?");
  });
});

describe("découverte des rtc_foci, erreur typée sinon", () => {
  it("rend le focus LiveKit publié par le .well-known", async () => {
    vi.stubGlobal("fetch", wellKnown({ [RTC_FOCI_WELL_KNOWN_KEY]: [FOCUS] }));
    await expect(discoverFocus(HOMESERVER)).resolves.toEqual(FOCUS);
  });

  it("lève RtcFociMissing quand le well-known n'a pas de foci", async () => {
    vi.stubGlobal("fetch", wellKnown({ "m.homeserver": { base_url: HOMESERVER } }));

    const error = await discoverFocus(HOMESERVER).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RtcFociMissingError);
    expect((error as RtcFociMissingError).reason).toBe("well-known-absent");
  });

  it("distingue un well-known injoignable d'un focus non LiveKit", async () => {
    vi.stubGlobal("fetch", wellKnown({}, false));
    await expect(discoverFocus(HOMESERVER)).rejects.toMatchObject({
      reason: "well-known-unreachable",
    });

    vi.stubGlobal("fetch", wellKnown({ [RTC_FOCI_WELL_KNOWN_KEY]: [{ type: "jitsi" }] }));
    await expect(discoverFocus(HOMESERVER)).rejects.toMatchObject({
      reason: "no-livekit-focus",
    });
  });
});

describe("détection d'appel en cours par les événements d'état", () => {
  it("passe de idle à active puis ended", () => {
    const call = activeCall(session, SALON);
    const seen: string[] = [];
    call.subscribe((state) => seen.push(state.status));

    expect(call.current().status).toBe("idle");

    const ana = "@ana:tacita.chat";
    const key = callMemberStateKey(ana, "D2");
    const joined = membership(key, { application: "m.call", created_ts: Date.now() }, Date.now(), ana);
    fake.events.push(joined);
    fake.emit(joined);
    // Une personne, pas une state key : c'est ce que le bandeau du salon affiche.
    expect(call.current()).toEqual({ status: "active", participants: [ana] });

    fake.events.length = 0;
    fake.events.push(membership(key, {}, Date.now(), ana));
    fake.emit(membership(key, {}, Date.now(), ana));
    expect(call.current()).toEqual({ status: "ended", participants: [] });

    expect(seen).toEqual(["active", "ended"]);
  });

  it("ignore une appartenance périmée : un salon ne reste pas en appel pour toujours", () => {
    const key = callMemberStateKey("@ana:tacita.chat", "D2");
    const stale = Date.now() - 5 * 60 * 60 * 1000;
    fake.events.push(membership(key, { created_ts: stale }, stale));

    expect(activeCall(session, SALON).current().status).toBe("idle");
  });

  it("cesse de notifier après stop()", () => {
    const call = activeCall(session, SALON);
    const listener = vi.fn();
    call.subscribe(listener);
    call.stop();

    const key = callMemberStateKey("@ana:tacita.chat", "D2");
    fake.events.push(membership(key, { created_ts: Date.now() }));
    fake.emit(membership(key, { created_ts: Date.now() }));

    expect(listener).not.toHaveBeenCalled();
  });

  it("hangupLocal vide notre propre appartenance", async () => {
    await hangupLocal(session, SALON);
    expect(fake.client.sendStateEvent).toHaveBeenCalledWith(
      SALON,
      CALL_MEMBER_EVENT_TYPE,
      {},
      callMemberStateKey(MOI, APPAREIL),
    );
  });
});

describe("littéraux MatrixRTC centralisés dans un seul fichier", () => {
  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));

  it("n'écrit aucun littéral de protocole hors de matrixrtc.ts", () => {
    const literals = [/org\.matrix\.msc\d+/, /livekit_service_url/, /"m\.call"/];
    const offenders = readdirSync(srcDir)
      .filter((name) => name.endsWith(".ts") && name !== "matrixrtc.ts")
      .filter((name) => {
        const source = readFileSync(`${srcDir}${name}`, "utf8");
        return literals.some((literal) => literal.test(source));
      });

    expect(offenders).toEqual([]);
  });

  it("garde la référence de vérification datée dans le fichier de constantes", () => {
    const constants = readFileSync(`${srcDir}matrixrtc.ts`, "utf8");
    expect(constants).toContain("2026-08-03");
    expect(constants).toContain("matrix-js-sdk@42.0.0");
    // La divergence MSC connue est écrite, pas dissimulée.
    expect(constants).toContain("m.rtc.member");
  });

  it("construit la state key attendue par le SDK déployé", () => {
    expect(callMemberStateKey(MOI, APPAREIL)).toBe("_@bob:tacita.chat_DEVICE1_m.call");
  });
});

describe("driver widget standard, sans logique RTC maison", () => {
  it("relaie les événements d'état vers la Session", async () => {
    const driver = new CallWidgetDriver(session, SALON);
    const sent = await driver.sendEvent(CALL_MEMBER_EVENT_TYPE, { foci_preferred: [] }, "_k", null);

    expect(sent).toEqual({ roomId: SALON, eventId: "$state" });
    expect(fake.client.sendStateEvent).toHaveBeenCalled();
  });

  it("confine le widget au salon de son appel", async () => {
    const driver = new CallWidgetDriver(session, SALON);

    expect(driver.getKnownRooms()).toEqual([SALON]);
    await expect(driver.sendEvent("m.room.message", {}, null, "!autre:tacita.chat")).rejects.toThrow(
      "autre salon",
    );
  });

  it("chiffre les clés de média appareil par appareil", async () => {
    const driver = new CallWidgetDriver(session, SALON);
    await driver.sendToDevice("io.element.call.encryption_keys", true, {
      "@ana:tacita.chat": { D2: { key: "k2" }, D3: { key: "k3" } },
    });

    expect(fake.client.encryptAndSendToDevice).toHaveBeenCalledTimes(2);
    expect(fake.client.sendToDevice).not.toHaveBeenCalled();
  });

  it("fournit le jeton OpenID qui autorise le SFU via lk-jwt", async () => {
    const driver = new CallWidgetDriver(session, SALON);
    const updates: unknown[] = [];
    driver.askOpenID({ update: (value: unknown) => updates.push(value) } as never);

    await vi.waitFor(() => expect(updates).toHaveLength(1));
    expect(updates[0]).toMatchObject({ state: "allowed" });
  });
});

/**
 * Le défaut : l'appelant restait sur un écran mort, et la console ne
 * portait que `readStickyEvents is not implemented` — la moitié bénigne.
 *
 * `validateCapabilities` accordait tout ce qu'on lui demandait. Le widget appelait alors
 * une méthode que `WidgetDriver` laisse en plan, et trois d'entre elles **lèvent de façon
 * synchrone**. `ClientWidgetApi.handleMessage` n'ayant aucun `try`, la levée traverse le
 * gestionnaire et `transport.reply` n'est jamais appelé : la requête du widget n'obtient
 * jamais de réponse, et l'appel se fige sans une ligne pour le dire.
 *
 * C'est la règle 5 prise au pied de la lettre — une promesse affichée et non tenue — à
 * l'endroit exact où elle coûte le plus : une jonction (règle 1).
 */
describe("aucune capacité accordée que le driver ne tienne", () => {
  const valider = (demandees: string[]) =>
    new CallWidgetDriver(session, SALON).validateCapabilities(new Set(demandees) as never);

  it("les capacités sticky sont refusées : c'est leur levée synchrone qui figeait l'appel", async () => {
    const accordees = await valider([
      "org.matrix.msc4407.send.sticky_event",
      "org.matrix.msc4407.receive.sticky_event",
    ]);

    expect([...accordees]).toEqual([]);
  });

  it("les capacités portées passent, les autres non — dans la même demande", async () => {
    // Le mélange compte : un filtre qui refuserait tout passerait le test précédent sans
    // rien prouver. `turn_servers` est implémentée, la timeline est portée par
    // `ClientWidgetApi` lui-même et n'est pas dans la table.
    const accordees = await valider([
      "town.robin.msc3846.turn_servers",
      `org.matrix.msc2762.timeline:${SALON}`,
      "org.matrix.msc4157.send.delayed_event",
      "org.matrix.msc4039.upload_file",
    ]);

    expect([...accordees].sort()).toEqual(
      ["town.robin.msc3846.turn_servers", `org.matrix.msc2762.timeline:${SALON}`].sort(),
    );
  });

  /**
   * **Le site de lecture, et il est en amont.** La table dit « refuser tant que la
   * méthode n'est pas surchargée » ; ce test vérifie que le motif est encore vrai dans la
   * version épinglée de `matrix-widget-api`. Le jour où l'amont implémente l'une de ces
   * méthodes — ou le jour où on la surcharge ici — ce test rougit et demande une revue,
   * au lieu de laisser une capacité refusée pour une raison périmée.
   */
  it("chaque capacité refusée l'est parce que la classe de base ne l'implémente pas", async () => {
    const refusees = [
      ["org.matrix.msc4407.send.sticky_event", "sendStickyEvent"],
      ["org.matrix.msc4407.receive.sticky_event", "readStickyEvents"],
      ["org.matrix.msc4157.send.delayed_event", "sendDelayedEvent"],
      ["org.matrix.msc4039.upload_file", "uploadFile"],
    ] as const;

    for (const [capacite, methode] of refusees) {
      expect([...(await valider([capacite]))], `${capacite} ne devrait pas être accordée`).toEqual(
        [],
      );
      // Et la méthode est bien celle de la classe de base, non surchargée.
      const base = WidgetDriver.prototype[methode] as unknown;
      expect(CallWidgetDriver.prototype[methode] as unknown).toBe(base);
    }
  });
});

describe("aucune donnée d'appel dans les logs", () => {
  it("ne journalise rien pendant la construction du widget ni le hangup", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );

    buildCallWidget(session, SALON, WIDGET);
    await hangupLocal(session, SALON);
    const driver = new CallWidgetDriver(session, SALON);
    await driver.sendToDevice("io.element.call.encryption_keys", true, {
      "@ana:tacita.chat": { D2: { key: "secret" } },
    });
    for await (const server of driver.getTurnServers()) expect(server.username).toBe("u");

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    for (const spy of spies) spy.mockRestore();
  });

  it("garde les jetons hors du message d'erreur de découverte", async () => {
    vi.stubGlobal("fetch", wellKnown({}, false));
    const error = await discoverFocus(HOMESERVER).then(
      () => new Error("la découverte aurait dû échouer"),
      (caught: unknown) => caught as Error,
    );

    expect(error.message).not.toContain(HOMESERVER);
    expect(error.message).toContain("well-known-unreachable");
  });
});

describe("une personne connectée sur deux appareils reste une personne", () => {
  it("les appartenances sont dédoublonnées par identifiant d'utilisateur", () => {
    // Avant, `participants` portait les state keys — appareil compris. Le bandeau du
    // salon annonçait donc « 2 personnes y participent » pour quelqu'un qui avait laissé
    // son ordinateur allumé en décrochant sur son téléphone.
    const ana = "@ana:tacita.chat";
    const contenu = { application: "m.call", created_ts: Date.now() };
    fake.events.push(
      membership(callMemberStateKey(ana, "TELEPHONE"), contenu, Date.now(), ana),
      membership(callMemberStateKey(ana, "ORDINATEUR"), contenu, Date.now(), ana),
    );

    expect(activeCall(session, SALON).current().participants).toEqual([ana]);
  });
});
