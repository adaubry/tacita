import type { Session } from "@tacita/client-core";
import { asSession } from "@tacita/client-core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  callHistory,
  CALL_MEMBER_EVENT_TYPE,
  incomingCalls,
  RINGING_WINDOW_MS,
} from "../src/index";

const MOI = "@bob:tacita.chat";
const AUTRE = "@ana:tacita.chat";
const TIERS = "@sam:tacita.chat";
const SALON = "!salon:tacita.chat";
const AUTRE_SALON = "!groupe:tacita.chat";

const T0 = 1_700_000_000_000;

/** Une appartenance réduite à ce que les deux modules en lisent. */
function appartenance(
  sender: string,
  contenu: Record<string, unknown>,
  ts: number,
  appareil = "D1",
  roomId = SALON,
) {
  return {
    getType: () => CALL_MEMBER_EVENT_TYPE,
    getRoomId: () => roomId,
    getStateKey: () => `_${sender}_${appareil}_m.call`,
    getSender: () => sender,
    getId: () => `$${sender}-${appareil}-${ts}`,
    getContent: () => contenu,
    getTs: () => ts,
  };
}

/** Une appartenance vivante : `expires` la couvre au moment où le test la lit. */
const rejoint = (sender: string, ts = T0, appareil = "D1", roomId = SALON) =>
  appartenance(sender, { created_ts: ts, expires: 4 * 60 * 60 * 1000 }, ts, appareil, roomId);

/** Le départ, tel que le SDK l'écrit : un contenu vide. */
const parti = (sender: string, ts: number, appareil = "D1", roomId = SALON) =>
  appartenance(sender, {}, ts, appareil, roomId);

type Evenement = ReturnType<typeof appartenance>;

/**
 * Deux salons, chacun avec son état courant et sa timeline. L'état sert aux appels
 * entrants, la timeline au journal — ce sont deux lectures différentes du SDK, et les
 * confondre dans le double masquerait précisément ce qui les distingue.
 */
function monde(salons: Record<string, { etat?: Evenement[]; timeline?: Evenement[] }>) {
  const handlers = new Set<(event: Evenement) => void>();
  const room = (roomId: string) => ({
    roomId,
    getLiveTimeline: () => ({
      getState: () => ({
        getStateEvents: () => salons[roomId]?.etat ?? [],
      }),
      getEvents: () => salons[roomId]?.timeline ?? [],
    }),
  });

  return {
    emettre(event: Evenement) {
      for (const handler of handlers) handler(event);
    },
    client: {
      getUserId: () => MOI,
      getDeviceId: () => "D1",
      getRooms: () => Object.keys(salons).map(room),
      getRoom: (roomId: string) => (salons[roomId] ? room(roomId) : null),
      on: (_e: string, handler: (event: Evenement) => void) => void handlers.add(handler),
      off: (_e: string, handler: (event: Evenement) => void) => void handlers.delete(handler),
    },
  };
}

const sessionDe = (fake: ReturnType<typeof monde>): Session =>
  asSession({ client: fake.client });

beforeEach(() => vi.useFakeTimers({ now: T0 }));
afterEach(() => vi.useRealTimers());

describe("un appel qui commence se voit depuis n'importe quel écran, pas seulement du salon ouvert", () => {
  it("un appel ouvert par quelqu'un d'autre est rendu, avec son salon et son auteur", () => {
    const fake = monde({ [SALON]: { etat: [rejoint(AUTRE)] } });
    const appels = incomingCalls(sessionDe(fake), () => T0);

    expect(appels.current()).toEqual([
      { roomId: SALON, from: AUTRE, since: T0, ringing: true },
    ]);
    appels.stop();
  });

  it("plusieurs salons sont surveillés à la fois, pas seulement celui qu'on regarde", () => {
    // La panne d'origine : l'état d'appel n'était lisible que salon par salon, et il
    // fallait avoir ce salon ouvert pour le demander. Quelqu'un qui appelait pendant
    // qu'on lisait la liste des conversations ne produisait rien du tout.
    const fake = monde({
      [SALON]: { etat: [rejoint(AUTRE)] },
      [AUTRE_SALON]: { etat: [rejoint(TIERS)] },
    });
    const appels = incomingCalls(sessionDe(fake), () => T0);

    expect(appels.current().map((appel) => appel.roomId)).toEqual([SALON, AUTRE_SALON]);
    appels.stop();
  });

  it("un appel où je suis déjà n'est pas un appel entrant", () => {
    const fake = monde({ [SALON]: { etat: [rejoint(AUTRE), rejoint(MOI)] } });
    const appels = incomingCalls(sessionDe(fake), () => T0);

    expect(appels.current()).toEqual([]);
    appels.stop();
  });

  it("rejoint depuis un autre appareil compte comme rejoint", () => {
    // Faire sonner le téléphone de quelqu'un qui est déjà dans l'appel depuis son
    // ordinateur est le genre de détail qui fait qu'on coupe les notifications.
    const fake = monde({ [SALON]: { etat: [rejoint(AUTRE), rejoint(MOI, T0, "AUTRE-APPAREIL")] } });
    const appels = incomingCalls(sessionDe(fake), () => T0);

    expect(appels.current()).toEqual([]);
    appels.stop();
  });

  it("une appartenance périmée ne fait pas sonner un salon vide", () => {
    const perime = appartenance(AUTRE, { created_ts: T0 - 10_000, expires: 5_000 }, T0 - 10_000);
    const fake = monde({ [SALON]: { etat: [perime] } });
    const appels = incomingCalls(sessionDe(fake), () => T0);

    expect(appels.current()).toEqual([]);
    appels.stop();
  });

  it("l'auteur retenu est celui de la plus ancienne appartenance, pas le dernier arrivé", () => {
    const fake = monde({
      [SALON]: { etat: [rejoint(TIERS, T0 - 1_000, "D2"), rejoint(AUTRE, T0 - 5_000)] },
    });
    const appels = incomingCalls(sessionDe(fake), () => T0);

    expect(appels.current()[0]?.from).toBe(AUTRE);
    expect(appels.current()[0]?.since).toBe(T0 - 5_000);
    appels.stop();
  });
});

describe("un appel ne sonne que le temps qu'on décroche, puis se tait sans disparaître", () => {
  it("un appel commencé il y a longtemps est rejoignable, mais ne sonne plus", () => {
    // Ouvrir l'application pendant qu'un groupe appelle depuis quarante minutes ne doit
    // pas déclencher une sonnerie plein écran pour un appel que personne n'attend de nous.
    const vieux = T0 - RINGING_WINDOW_MS - 1;
    const fake = monde({ [SALON]: { etat: [rejoint(AUTRE, vieux)] } });
    const appels = incomingCalls(sessionDe(fake), () => T0);

    expect(appels.current()[0]?.ringing).toBe(false);
    appels.stop();
  });

  it("la sonnerie s'éteint toute seule à l'heure, sans attendre un événement", () => {
    // Rien n'est publié quand la fenêtre se referme : sans minuteur, la sonnerie durerait
    // jusqu'à la prochaine appartenance, c'est-à-dire jusqu'à la fin de l'appel.
    let maintenant = T0;
    const fake = monde({ [SALON]: { etat: [rejoint(AUTRE, T0)] } });
    const appels = incomingCalls(sessionDe(fake), () => maintenant);
    const vus: boolean[] = [];
    appels.subscribe((etat) => vus.push(etat[0]?.ringing ?? false));

    expect(appels.current()[0]?.ringing).toBe(true);
    maintenant = T0 + RINGING_WINDOW_MS;
    vi.advanceTimersByTime(RINGING_WINDOW_MS);

    expect(vus).toEqual([false]);
    expect(appels.current()[0]?.ringing).toBe(false);
    appels.stop();
  });

  it("un événement d'appartenance republie l'état, un événement d'autre type non", () => {
    const salons: Record<string, { etat: Evenement[] }> = { [SALON]: { etat: [] } };
    const fake = monde(salons);
    const appels = incomingCalls(sessionDe(fake), () => T0);
    const vus: number[] = [];
    appels.subscribe((etat) => vus.push(etat.length));

    salons[SALON]!.etat = [rejoint(AUTRE)];
    fake.emettre({ ...rejoint(AUTRE), getType: () => "m.room.message" });
    expect(vus).toEqual([]);

    fake.emettre(rejoint(AUTRE));
    expect(vus).toEqual([1]);
    appels.stop();
  });

  it("`stop` coupe l'écoute et le minuteur", () => {
    const fake = monde({ [SALON]: { etat: [rejoint(AUTRE)] } });
    const appels = incomingCalls(sessionDe(fake), () => T0);
    appels.stop();

    const vus: unknown[] = [];
    appels.subscribe(() => vus.push(1));
    fake.emettre(rejoint(AUTRE));
    vi.advanceTimersByTime(RINGING_WINDOW_MS * 2);
    expect(vus).toEqual([]);
  });
});

describe("un appel manqué laisse une trace, sans qu'aucun événement soit inventé pour ça", () => {
  it("un appel ouvert puis refermé donne une entrée avec son début et sa fin", () => {
    const fake = monde({
      [SALON]: { timeline: [rejoint(AUTRE, T0), parti(AUTRE, T0 + 60_000)] },
    });

    const [entree, ...reste] = callHistory(sessionDe(fake), SALON);
    expect(reste).toEqual([]);
    expect(entree).toMatchObject({
      from: AUTRE,
      debut: T0,
      fin: T0 + 60_000,
      enCours: false,
      mien: false,
      manque: true,
    });
  });

  it("un appel auquel j'ai participé n'est pas manqué", () => {
    const fake = monde({
      [SALON]: {
        timeline: [rejoint(AUTRE, T0), rejoint(MOI, T0 + 2_000), parti(AUTRE, T0 + 9_000), parti(MOI, T0 + 10_000)],
      },
    });

    const [entree] = callHistory(sessionDe(fake), SALON);
    expect(entree?.mien).toBe(true);
    expect(entree?.manque).toBe(false);
    expect(entree?.participants).toEqual([AUTRE, MOI]);
  });

  it("un appel que j'ai lancé et que personne n'a pris n'est pas « manqué » — c'est le mien", () => {
    const fake = monde({ [SALON]: { timeline: [rejoint(MOI, T0), parti(MOI, T0 + 30_000)] } });

    const [entree] = callHistory(sessionDe(fake), SALON);
    expect(entree?.manque).toBe(false);
    expect(entree?.from).toBe(MOI);
  });

  it("deux appels successifs font deux entrées, et pas une seule qui s'étire", () => {
    const fake = monde({
      [SALON]: {
        timeline: [
          rejoint(AUTRE, T0),
          parti(AUTRE, T0 + 10_000),
          rejoint(AUTRE, T0 + 600_000),
          parti(AUTRE, T0 + 660_000),
        ],
      },
    });

    const journal = callHistory(sessionDe(fake), SALON);
    expect(journal).toHaveLength(2);
    expect(journal[1]?.debut).toBe(T0 + 600_000);
    expect(journal.map((entree) => entree.id)).toHaveLength(new Set(journal.map((e) => e.id)).size);
  });

  it("le créneau se referme au dernier parti, pas au premier", () => {
    // Deux personnes dans l'appel : le départ de l'une ne termine rien.
    const fake = monde({
      [SALON]: {
        timeline: [
          rejoint(AUTRE, T0),
          rejoint(TIERS, T0 + 1_000, "D2"),
          parti(AUTRE, T0 + 5_000),
          parti(TIERS, T0 + 20_000, "D2"),
        ],
      },
    });

    const journal = callHistory(sessionDe(fake), SALON);
    expect(journal).toHaveLength(1);
    expect(journal[0]?.fin).toBe(T0 + 20_000);
    expect(journal[0]?.participants).toEqual([AUTRE, TIERS]);
  });

  it("un appel encore vivant est marqué en cours, et sa fin reste inconnue", () => {
    // C'est le bandeau du salon qui le porte, pas le journal : deux surfaces pour le
    // même appel se contrediraient au premier décalage.
    const fake = monde({ [SALON]: { timeline: [rejoint(AUTRE, T0)] } });

    const [entree] = callHistory(sessionDe(fake), SALON);
    expect(entree?.enCours).toBe(true);
    expect(entree?.fin).toBeUndefined();
    expect(entree?.manque).toBe(false);
  });

  it("un client parti sans nettoyer clôt l'appel sans lui inventer de durée", () => {
    // L'appartenance expire en silence. Sans ce cas, le salon restait « appel en cours »
    // quatre heures ; avec une fin devinée, il aurait affiché « appel de 4 h ».
    const abandonnee = appartenance(AUTRE, { created_ts: T0 - 60_000, expires: 5_000 }, T0 - 60_000);
    const fake = monde({ [SALON]: { timeline: [abandonnee] } });

    const [entree] = callHistory(sessionDe(fake), SALON);
    expect(entree?.enCours).toBe(false);
    expect(entree?.fin).toBeUndefined();
    expect(entree?.manque).toBe(true);
  });

  it("chaque appel s'ancre au message qu'il suit, plutôt que de se trier par horodatage", () => {
    // Interdit n°6 : l'ordre canonique est celui du flux `/sync`, jamais
    // `origin_server_ts`. Le journal doit pourtant se placer parmi les messages — il le
    // fait en se rattachant à celui qui le précède, sans comparer deux dates.
    const message = (id: string, ts: number) => ({
      ...appartenance(AUTRE, {}, ts),
      getType: () => "m.room.message",
      getId: () => id,
    });
    const fake = monde({
      [SALON]: {
        timeline: [
          message("$m1", T0 - 1_000),
          rejoint(AUTRE, T0),
          parti(AUTRE, T0 + 5_000),
          message("$m2", T0 + 6_000),
          rejoint(TIERS, T0 + 7_000, "D2"),
          parti(TIERS, T0 + 8_000, "D2"),
        ],
      },
    });

    expect(callHistory(sessionDe(fake), SALON).map((entree) => entree.apres)).toEqual([
      "$m1",
      "$m2",
    ]);
  });

  it("un appel qui ouvre la fenêtre chargée n'a pas d'ancre, et se rend en tête", () => {
    const fake = monde({ [SALON]: { timeline: [rejoint(AUTRE, T0), parti(AUTRE, T0 + 1_000)] } });
    expect(callHistory(sessionDe(fake), SALON)[0]?.apres).toBeUndefined();
  });

  it("un salon sans le moindre appel rend un journal vide, pas une entrée fantôme", () => {
    expect(callHistory(sessionDe(monde({ [SALON]: {} })), SALON)).toEqual([]);
  });
});
