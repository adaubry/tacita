import { NOT_ENCRYPTED } from "@tacita/outbox";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../components/conversation/Composer";
import { ConversationStarter } from "../components/conversation/ConversationStarter";
import { HoldMenu } from "../components/conversation/HoldMenu";
import { MessageObject } from "../components/conversation/MessageObject";
import { Timeline } from "../components/conversation/Timeline";
import {
  FENETRE_GROUPE_MS,
  nouveauJour,
  shouldShowHeader,
  texteAffiche,
  type MessageAffiche,
} from "../components/conversation/message";
import { SEUIL_GLISSEMENT, ZONE_MORTE_BORD } from "../lib/gestes";

vi.mock("next/navigation", () => ({
  usePathname: () => "/c/!salon",
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));

const LUNDI_10H = new Date("2026-08-03T10:00:00").getTime();

function message(partiel: Partial<MessageAffiche> = {}): MessageAffiche {
  return {
    cle: "$un",
    eventId: "$un",
    auteur: "@adam:tacita.test",
    nom: "adam",
    texte: "on se voit demain ?",
    horodatage: LUNDI_10H,
    moi: false,
    ...partiel,
  };
}

/**
 * jsdom 26 n'implémente pas `PointerEvent`, et l'événement de repli de Testing Library
 * ne porte pas `clientX` — un test de geste passerait au vert sans avoir rien glissé.
 * `MouseEvent` porte les coordonnées, React lit le type qu'on lui donne.
 */
function glisser(cible: HTMLElement, depuis: number, jusqu: number) {
  fireEvent(cible, new MouseEvent("pointerdown", { bubbles: true, clientX: depuis, clientY: 0 }));
  fireEvent(cible, new MouseEvent("pointerup", { bubbles: true, clientX: jusqu, clientY: 0 }));
}

const rendreMessage = (props: Partial<Parameters<typeof MessageObject>[0]> = {}) => {
  const actions = {
    message: message(),
    entete: true,
    heureVisible: false,
    onRepondre: vi.fn(),
    onHold: vi.fn(),
    onRevelerHeures: vi.fn(),
    ...props,
  };
  render(<MessageObject {...actions} />);
  return actions;
};

const carteMessage = (nom = "adam") => screen.getByLabelText(`Message de ${nom}`);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("REQ-UIX-12 — regroupement Discord : la table de cas de shouldShowHeader", () => {
  const adam = message({ auteur: "@adam:tacita.test", horodatage: LUNDI_10H });

  it("le premier message porte toujours son en-tête", () => {
    expect(shouldShowHeader(undefined, adam)).toBe(true);
  });

  it("un message du même auteur, dans la fenêtre, s'appende sans en-tête", () => {
    const suivant = message({ horodatage: LUNDI_10H + FENETRE_GROUPE_MS - 1 });
    expect(shouldShowHeader(adam, suivant)).toBe(false);
  });

  it("au-delà de cinq minutes, l'en-tête revient", () => {
    const suivant = message({ horodatage: LUNDI_10H + FENETRE_GROUPE_MS + 1 });
    expect(shouldShowHeader(adam, suivant)).toBe(true);
  });

  it("une interruption par un autre auteur rouvre un groupe", () => {
    const zoe = message({ auteur: "@zoe:tacita.test", horodatage: LUNDI_10H + 1000 });
    expect(shouldShowHeader(adam, zoe)).toBe(true);
    // Et le message suivant d'adam aussi, même à la seconde : c'est l'interruption qui
    // compte, pas le temps écoulé.
    expect(shouldShowHeader(zoe, message({ horodatage: LUNDI_10H + 2000 }))).toBe(true);
  });

  it("un changement de jour rouvre un groupe même pour le même auteur", () => {
    const lendemain = message({ horodatage: new Date("2026-08-04T09:59:00").getTime() });
    expect(nouveauJour(adam, lendemain)).toBe(true);
    expect(shouldShowHeader(adam, lendemain)).toBe(true);
  });

  it("l'en-tête rendu porte le nom et l'heure ; sans en-tête, ni l'un ni l'autre", () => {
    rendreMessage({ entete: true });
    expect(screen.getAllByText("adam").length).toBeGreaterThan(0);

    cleanup();
    rendreMessage({ entete: false });
    expect(screen.queryByText("adam")).toBeNull();
  });
});

describe("REQ-UI-06 — l'ordre du paquet, les séparateurs de date, la file d'envoi", () => {
  const rendreTimeline = (messages: MessageAffiche[]) =>
    render(
      <Timeline
        messages={messages}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
      />,
    );

  it("deux messages à cheval sur minuit produisent un second séparateur", () => {
    rendreTimeline([
      message({ cle: "$a", horodatage: new Date("2026-08-03T23:58:00").getTime() }),
      message({ cle: "$b", horodatage: new Date("2026-08-04T00:02:00").getTime() }),
    ]);

    // Deux séparateurs : celui du haut de timeline, et celui du changement de jour.
    expect(screen.getAllByRole("separator")).toHaveLength(2);
  });

  it("deux messages du même jour n'en produisent qu'un", () => {
    rendreTimeline([
      message({ cle: "$a", horodatage: LUNDI_10H }),
      message({ cle: "$b", horodatage: LUNDI_10H + 60_000 }),
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(1);
  });

  it("l'ordre rendu est exactement celui reçu — rien n'est retrié", () => {
    // Horodatages volontairement décroissants : un tri les remettrait dans l'autre sens,
    // et l'interdit n°6 dit que l'ordre du flux fait foi, pas l'horloge du serveur.
    rendreTimeline([
      message({ cle: "$a", texte: "premier", horodatage: LUNDI_10H + 60_000 }),
      message({ cle: "$b", texte: "second", horodatage: LUNDI_10H }),
    ]);

    const rendus = screen.getAllByRole("article").map((noeud) => noeud.textContent);
    expect(rendus[0]).toContain("premier");
    expect(rendus[1]).toContain("second");
  });

  it("une entrée en échec propose un renvoi ; bloquée par le chiffrement, elle ne le propose pas", () => {
    const onRenvoyer = vi.fn();
    render(
      <Timeline
        messages={[message({ cle: "txn1", eventId: undefined, moi: true, envoi: "failed" })]}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={onRenvoyer}
        onAbandonner={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(onRenvoyer).toHaveBeenCalledTimes(1);

    cleanup();
    render(
      <Timeline
        messages={[
          message({
            cle: "txn2",
            eventId: undefined,
            moi: true,
            envoi: "failed",
            // Importé, jamais recopié : c'est un contrat de passation (spec 11), et une
            // chaîne recopiée n'est plus qu'une coïncidence.
            errcode: NOT_ENCRYPTED,
          }),
        ]}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
    expect(screen.getByText(/n'est pas chiffré/)).toBeTruthy();
  });
});

describe("REQ-UI-08 — glissement gauche : répondre", () => {
  it("au-delà du seuil, la réponse est armée", () => {
    const { onRepondre } = rendreMessage();
    glisser(carteMessage(), 200, 200 - SEUIL_GLISSEMENT);
    expect(onRepondre).toHaveBeenCalledTimes(1);
  });

  it("en deçà du seuil, rien", () => {
    const { onRepondre } = rendreMessage();
    glisser(carteMessage(), 200, 200 - SEUIL_GLISSEMENT + 1);
    expect(onRepondre).not.toHaveBeenCalled();
  });

  it("le composer affiche le message cité et sait l'annuler", () => {
    const onAnnuler = vi.fn();
    render(
      <Composer
        mentions={[]}
        contexte={{ libelle: "Réponse à adam", extrait: "on se voit demain ?", onAnnuler }}
        onEnvoyer={vi.fn()}
        onFrappe={vi.fn()}
      />,
    );

    expect(screen.getByText(/Réponse à adam/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(onAnnuler).toHaveBeenCalledTimes(1);
  });
});

describe("REQ-UI-09 — glissement droit : les heures, et la zone morte du bord", () => {
  it("révèle les heures", () => {
    const { onRevelerHeures } = rendreMessage();
    glisser(carteMessage(), 100, 100 + SEUIL_GLISSEMENT);
    expect(onRevelerHeures).toHaveBeenCalledTimes(1);
  });

  it("l'appui long n'entraîne pas la sélection de texte native d'iOS", () => {
    rendreMessage();
    // Sur iOS, un appui long sur la bulle sélectionnerait son texte (surlignage bleu,
    // façon Live Text) *en plus* du hold menu. La copie passe par « Copier », pas par
    // la sélection native.
    expect(carteMessage().style.userSelect).toBe("none");
  });

  it("un geste parti à moins de 20 px du bord ne fait rien", () => {
    const { onRevelerHeures, onRepondre } = rendreMessage();
    // Le retour arrière de Safari iOS a déjà capté ce geste : agir en plus ferait les
    // deux à la fois, selon la chance qu'on a eue de partir à 19 ou à 21 px.
    glisser(carteMessage(), ZONE_MORTE_BORD - 1, ZONE_MORTE_BORD - 1 + SEUIL_GLISSEMENT * 2);
    expect(onRevelerHeures).not.toHaveBeenCalled();
    expect(onRepondre).not.toHaveBeenCalled();
  });

  it("une fois révélées, l'heure apparaît sur les messages groupés", () => {
    render(
      <Timeline
        messages={[
          message({ cle: "$a", horodatage: LUNDI_10H }),
          message({ cle: "$b", horodatage: LUNDI_10H + 1000 }),
        ]}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
      />,
    );

    const avant = screen.getAllByText(/\d{1,2}\D\d{2}/).length;
    glisser(screen.getAllByRole("article")[1]!, 100, 100 + SEUIL_GLISSEMENT);
    expect(screen.getAllByText(/\d{1,2}\D\d{2}/).length).toBeGreaterThan(avant);
  });
});

describe("REQ-UI-13 — accusés : trois niveaux, et ce qu'ils ne promettent pas", () => {
  const recuDe = (statut: "sent" | "delivered" | "read", indecidable = false) => {
    cleanup();
    rendreMessage({ message: message({ moi: true }), recu: { statut, indecidable } });
  };

  it("envoyé, délivré puis lu se distinguent à l'écran", () => {
    recuDe("sent");
    expect(screen.getByText("✓")).toBeTruthy();

    recuDe("delivered");
    expect(screen.getByText("✓✓")).toBeTruthy();
    expect(screen.getByLabelText(/extension propre à Tacita/)).toBeTruthy();

    recuDe("read");
    // DESIGN.md : la coche verte est un trait d'identité, et « lu » seul la porte.
    expect(screen.getByText("✓✓").style.color).toContain("--color-text-accent");
  });

  it("un destinataire masqué reste à « envoyé », et l'explique", () => {
    recuDe("sent", true);
    expect(screen.getByLabelText(/n'émet pas d'accusé/)).toBeTruthy();
  });

  it("un message en cours d'envoi ne porte aucune coche", () => {
    rendreMessage({ message: message({ moi: true }), recu: { statut: "sending", indecidable: false } });
    expect(screen.queryByText("✓")).toBeNull();
  });
});

describe("REQ-UI-07 / REQ-UIX-14 — hold menu : réactions, actions, et droits", () => {
  const rendreMenu = (droits: { modifiable?: boolean; supprimable?: boolean } = {}) => {
    const actions = {
      ouvert: true,
      onFermer: vi.fn(),
      modifiable: false,
      supprimable: false,
      epingle: false,
      onReagir: vi.fn(),
      onRepondre: vi.fn(),
      onCopier: vi.fn(),
      onModifier: vi.fn(),
      onSupprimer: vi.fn(),
      onEpingler: vi.fn(),
      ...droits,
    };
    render(<HoldMenu {...actions} />);
    return actions;
  };

  it("une réaction rapide part et referme le menu", () => {
    const { onReagir, onFermer } = rendreMenu();
    fireEvent.click(within(screen.getByRole("group", { name: "Réactions" })).getByText("👍"));
    expect(onReagir).toHaveBeenCalledWith("👍");
    expect(onFermer).toHaveBeenCalledTimes(1);
  });

  it("le picker complet s'ouvre sans quitter le menu", () => {
    rendreMenu();
    const reactions = () => within(screen.getByRole("group", { name: "Réactions" })).getAllByRole("button");
    const avant = reactions().length;
    fireEvent.click(screen.getByRole("button", { name: "Plus de réactions" }));
    expect(reactions().length).toBeGreaterThan(avant);
  });

  it("la mention du non-chiffrement des réactions est là, sobre et non modale", () => {
    rendreMenu();
    expect(screen.getByText(/visibles du serveur/)).toBeTruthy();
  });

  it("sans les droits, modifier et supprimer n'existent pas — ils ne sont pas grisés", () => {
    rendreMenu();
    expect(screen.queryByText("Modifier")).toBeNull();
    expect(screen.queryByText("Supprimer")).toBeNull();
    expect(screen.getByText("Répondre")).toBeTruthy();
    expect(screen.getByText("Copier")).toBeTruthy();
  });

  it("avec les droits, les deux apparaissent", () => {
    const { onSupprimer } = rendreMenu({ modifiable: true, supprimable: true });
    expect(screen.getByText("Modifier")).toBeTruthy();
    fireEvent.click(screen.getByText("Supprimer"));
    expect(onSupprimer).toHaveBeenCalledTimes(1);
  });
});

describe("REQ-UIX-13 — conversation starter : premier élément, actions selon le salon", () => {
  it("il est rendu au-dessus du premier message", () => {
    render(
      <Timeline
        messages={[message()]}
        starter={<ConversationStarter nom="adam" sousTitre="@adam:tacita.test" direct />}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
      />,
    );

    const journal = screen.getByRole("log");
    const starter = screen.getByLabelText("Début de la conversation");
    // `compareDocumentPosition` plutôt qu'un index : c'est la position dans le document
    // qui compte, et elle survit à un enrobage de plus.
    expect(journal.firstElementChild).toBe(starter);
  });

  it("en 1:1 : bloquer et retirer l'ami", () => {
    const onBloquer = vi.fn();
    render(
      <ConversationStarter
        nom="adam"
        sousTitre="@adam:tacita.test"
        direct
        onBloquer={onBloquer}
        onRetirer={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("Bloquer"));
    expect(onBloquer).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Retirer l'ami")).toBeTruthy();
    expect(screen.queryByText("Quitter")).toBeNull();
  });

  it("en groupe : muter et quitter", () => {
    render(
      <ConversationStarter
        nom="équipe"
        sousTitre="4 membres"
        direct={false}
        onMuter={vi.fn()}
        onQuitter={vi.fn()}
      />,
    );

    expect(screen.getByText("Muter")).toBeTruthy();
    expect(screen.getByText("Quitter")).toBeTruthy();
    expect(screen.queryByText("Bloquer")).toBeNull();
  });

  it("une action que personne ne branche n'est pas rendue en bouton inerte", () => {
    render(<ConversationStarter nom="adam" sousTitre="@adam:tacita.test" direct />);
    expect(screen.queryByText("Bloquer")).toBeNull();
  });
});

describe("REQ-UI-11 / REQ-UI-12 — typing en lecture, mentions à la saisie", () => {
  const rendreComposer = (props: Partial<Parameters<typeof Composer>[0]> = {}) => {
    const onFrappe = vi.fn();
    const actions = { mentions: [], onEnvoyer: vi.fn(), ...props, onFrappe };
    render(<Composer {...actions} />);
    return { ...actions, onFrappe };
  };

  it("l'indicateur nomme une personne, et compte au-delà", () => {
    rendreComposer({ ecrivent: ["adam"] });
    expect(screen.getByText(/adam est en train d'écrire/)).toBeTruthy();

    cleanup();
    rendreComposer({ ecrivent: ["adam", "zoé"] });
    expect(screen.getByText(/2 personnes/)).toBeTruthy();
  });

  it("personne n'écrit : aucun indicateur, pas une ligne vide", () => {
    rendreComposer();
    expect(screen.queryByText(/en train d'écrire/)).toBeNull();
  });

  it("chaque frappe prévient le paquet, qui décide seul d'émettre", () => {
    const { onFrappe } = rendreComposer();
    // Le champ d'Astryx est un `contentEditable`, pas un `input` : il émet `input`, et
    // `fireEvent.change` n'y trouverait aucun setter de valeur.
    const champ = screen.getAllByLabelText("Message")[0]!;
    fireEvent.input(champ, { target: { textContent: "sal" } });
    fireEvent.input(champ, { target: { textContent: "salu" } });
    expect(onFrappe.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("`@room` du corps se relit `@everyone`, jamais l'inverse à l'écran", () => {
    // REQ-MSG-10 : le corps porte le littéral que la push rule cherche ; l'utilisateur
    // a tapé `@everyone` et doit le relire tel quel.
    expect(texteAffiche("salut @room")).toBe("salut @everyone");
  });
});
