import { NOT_ENCRYPTED } from "@tacita/outbox";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Composer } from "../components/conversation/Composer";
import { ConversationStarter } from "../components/conversation/ConversationStarter";
import { HoldMenu } from "../components/conversation/HoldMenu";
import { MessageObject } from "../components/conversation/MessageObject";
import { decouperLiens } from "../components/conversation/TexteMessage";
import { Timeline } from "../components/conversation/Timeline";
import {
  apercu,
  citation,
  depuisFile,
  FENETRE_GROUPE_MS,
  nouveauJour,
  shouldShowHeader,
  texteAffiche,
  type MessageAffiche,
} from "../components/conversation/message";
import { mediaDe } from "../components/media/media";
import { DUREE_APPUI_LONG, SEUIL_GLISSEMENT, ZONE_MORTE_BORD } from "../lib/gestes";
import { lire, sansCommentaires } from "./sources";

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
  fireEvent(cible, new MouseEvent("pointermove", { bubbles: true, clientX: jusqu, clientY: 0 }));
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

describe("regroupement Discord : la table de cas de shouldShowHeader", () => {
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

  /**
   * La photo de l'auteur, de son appartenance au salon jusqu'à `ConversationAvatar`.
   *
   * Trois maillons, et le défaut était au dernier : la photo était posée, synchronisée,
   * et l'en-tête appelait `ConversationAvatar` **sans `mxc`** — donc des initiales, pour
   * tout le monde, toujours. Règle 7 : une valeur qu'aucun site de lecture ne relit est
   * indétectable, et celle-ci l'a été jusqu'à ce qu'un œil humain la cherche.
   *
   * Le rendu de l'image, lui, n'est pas ici : il demande une session et un
   * `fetch` authentifié (`useImageMxc`), que jsdom ne fournit pas. Ce qu'on tient, c'est
   * la chaîne — et c'est elle qui avait cédé.
   */
  it("la photo de l'auteur va du salon à l'avatar, sans se perdre en route", () => {
    const entree = {
      txnId: "txn1",
      roomId: "!salon:tacita.test",
      content: { msgtype: "m.text", body: "coucou" },
      queuedAt: LUNDI_10H,
      nextAttemptAt: LUNDI_10H,
      status: "queued" as const,
      attempts: 0,
    };
    expect(depuisFile(entree, "adam", "@adam:tacita.test", "mxc://tacita.test/photo").avatar).toBe(
      "mxc://tacita.test/photo",
    );

    // Les deux bouts de la jonction, à la source : le câblage lit l'appartenance au
    // salon, l'en-tête la passe à la primitive. Que l'un des deux disparaisse, et la
    // photo redevient invisible sans qu'aucun test de rendu ne s'en aperçoive.
    expect(lire("components/conversation/Conversation.tsx")).toContain("avatar: avatarDe(auteur)");
    expect(lire("components/conversation/Conversation.tsx")).toMatch(/getMxcAvatarUrl\(\)/);
    expect(lire("components/conversation/MessageObject.tsx")).toContain("mxc={message.avatar}");
  });
});

describe("l'ordre du paquet, les séparateurs de date, la file d'envoi", () => {
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
            // Importé, jamais recopié : c'est un contrat de passation, et une
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

describe("une réponse montre le message qu'elle vise", () => {
  /**
   * Le défaut signalé : « lorsqu'on répond à un message, une photo, une vidéo, un
   * document ou autre, il n'y a pas d'UI spécifique montrant à quel message on fait
   * référence ». La relation `m.in_reply_to` était bien posée à l'envoi — donc lisible
   * par les autres clients — et n'était rendue **nulle part** chez nous. Règle 7.
   */
  const photo = message({
    cle: "$photo",
    nom: "zoe",
    media: mediaDe({
      getId: () => "$photo",
      getContent: () => ({
        msgtype: "m.image",
        body: "IMG_4417.HEIC",
        file: { url: "mxc://tacita.test/def", key: {}, iv: "iv", hashes: {}, v: "v2" },
        info: { size: 2048, mimetype: "image/jpeg" },
      }),
    }),
  });

  it("nomme la nature d'un média cité, jamais son nom de fichier", () => {
    expect(apercu(photo)).toBe("Photo");
    expect(apercu(message({ texte: "coucou" }))).toBe("coucou");
  });

  it("cite l'auteur et l'extrait du message visé", () => {
    expect(citation(message({ nom: "zoe", texte: "on mange où ?" }))).toEqual({
      nom: "zoe",
      extrait: "on mange où ?",
    });
  });

  /**
   * Le message cité peut être hors de la fenêtre chargée : le repli le dit au lieu de
   * rendre une citation vide, et surtout au lieu d'aller chercher l'événement au serveur
   * — ce serait un aller-retour réseau par ligne de timeline.
   */
  it("un message cité absent se dit, il ne se devine pas", () => {
    expect(citation(undefined)).toEqual({ extrait: "Message plus ancien" });
  });

  it("rend la citation au-dessus du corps, auteur compris", () => {
    rendreMessage({
      message: message({ texte: "au bar", repondA: { nom: "zoe", extrait: "on mange où ?" } }),
    });
    expect(screen.getByText(/zoe · on mange où \?/)).toBeTruthy();
  });

  it("un message ordinaire n'en porte aucune", () => {
    rendreMessage();
    expect(screen.queryByText(/·/)).toBeNull();
  });

  /** Le composer cite la même chose, par la même fonction : « Photo », pas « IMG_1.jpg ». */
  it("le bandeau du composer cite le média par sa nature", () => {
    render(
      <Composer
        mentions={[]}
        contexte={{ libelle: "Réponse à zoe", extrait: apercu(photo), onAnnuler: vi.fn() }}
        onEnvoyer={vi.fn()}
        onFrappe={vi.fn()}
      />,
    );
    expect(screen.getByText(/Réponse à zoe : Photo/)).toBeTruthy();
  });

  /**
   * L'écran pose la relation avec l'`event_id` du message cité, jamais sa `cle` — qui est
   * un identifiant de transaction tant que le serveur n'a rien attribué. Une relation vers
   * un `txnId` ne se résout chez personne, et rien à l'écran ne l'aurait dit.
   */
  it("la relation part du paquet et porte un event_id", () => {
    const ecran = sansCommentaires(lire("components/conversation/Conversation.tsx"));
    expect(ecran).toContain("intention.message.eventId");
    expect(ecran).toContain("replyRelation(cite)");
    expect(ecran).not.toMatch(/m\.in_reply_to/);
  });
});

describe("les liens d'un message se voient et se cliquent", () => {
  /**
   * Le défaut signalé : « les liens n'apparaissent pas en bleu et on ne peut pas les
   * cliquer ». Le corps était rendu tel quel, donc une URL restait de l'encre ordinaire.
   *
   * L'encre est celle d'`accent` et non un bleu : DESIGN.md § Colors range les liens dans
   * `accent`, et § Typography n'autorise l'encre d'accent que pour eux et les actions.
   */
  it("découpe le texte autour des URL, schéma explicite ou `www.`", () => {
    expect(decouperLiens("va voir https://tacita.test/a puis www.exemple.org/b, merci")).toEqual([
      { texte: "va voir " },
      { texte: "https://tacita.test/a", lien: "https://tacita.test/a" },
      { texte: " puis " },
      // Sans schéma, le `href` serait relatif et enverrait sur `/c/www.exemple.org/b`.
      { texte: "www.exemple.org/b", lien: "https://www.exemple.org/b" },
      { texte: ", merci" },
    ]);
  });

  it("la ponctuation de fin de phrase n'entre pas dans l'URL", () => {
    expect(decouperLiens("regarde https://tacita.test.")).toEqual([
      { texte: "regarde " },
      { texte: "https://tacita.test", lien: "https://tacita.test" },
      { texte: "." },
    ]);
  });

  it("un texte sans lien reste un seul morceau, et rien n'est cliquable", () => {
    expect(decouperLiens("on se voit demain ?")).toEqual([{ texte: "on se voit demain ?" }]);
  });

  /** `javascript:` écrit dans un message est du texte, et le reste. */
  it("aucun autre schéma ne devient cliquable", () => {
    expect(decouperLiens("javascript:alert(1)")).toEqual([{ texte: "javascript:alert(1)" }]);
    expect(decouperLiens("écris-moi à data:text/html,x")).toEqual([
      { texte: "écris-moi à data:text/html,x" },
    ]);
  });

  it("le lien rendu est une ancre ouvrant à l'extérieur, en encre d'accent", () => {
    rendreMessage({ message: message({ texte: "c'est là : https://tacita.test/salon" }) });

    const lien = screen.getByRole("link", { name: "https://tacita.test/salon" });
    expect(lien.getAttribute("href")).toBe("https://tacita.test/salon");
    expect(lien.getAttribute("target")).toBe("_blank");
    // `noopener` contre le `window.opener`, `noreferrer` contre la fuite de référent —
    // l'URL d'une PWA de messagerie n'a pas à voyager chez un tiers.
    expect(lien.getAttribute("rel")).toContain("noopener");
    expect(lien.getAttribute("rel")).toContain("noreferrer");
    expect(lien.style.color).toBe("var(--color-text-accent)");
  });

  /** Viser un lien ne doit pas armer le glissement du message qui le porte. */
  it("un appui sur le lien n'arme pas la réponse", () => {
    const { onRepondre } = rendreMessage({
      message: message({ texte: "https://tacita.test/salon" }),
    });
    const lien = screen.getByRole("link", { name: "https://tacita.test/salon" });

    fireEvent(lien, new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 0 }));
    fireEvent(
      carteMessage(),
      new MouseEvent("pointerup", { bubbles: true, clientX: 200 - SEUIL_GLISSEMENT, clientY: 0 }),
    );

    expect(onRepondre).not.toHaveBeenCalled();
  });
});

describe("glissement gauche : répondre", () => {
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

describe("le glissement survit à sa propre durée, et se voit pendant", () => {
  /**
   * Le défaut signalé : « slider pour répondre ne marche pas ».
   *
   * Deux causes, et la première suffisait. L'appui long n'était annulé qu'au relâchement :
   * un glissement tranquille — c'est le geste normal, on ne balaie pas un message en
   * 200 ms — franchissait les 500 ms en chemin, le hold menu s'ouvrait par-dessus et
   * avalait la fin du geste. La seconde est qu'à l'écran, rien ne bougeait : le geste ne
   * disait ni qu'il avait été pris, ni dans quel sens il allait, ni qu'il fallait insister.
   */
  it("un glissement lent répond, sans ouvrir le hold menu en route", () => {
    vi.useFakeTimers();
    try {
      const { onRepondre, onHold } = rendreMessage();
      const carte = carteMessage();

      fireEvent(carte, new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 0 }));
      // Le doigt part, puis prend son temps : bien au-delà des 500 ms de l'appui long.
      fireEvent(carte, new MouseEvent("pointermove", { bubbles: true, clientX: 180, clientY: 0 }));
      vi.advanceTimersByTime(DUREE_APPUI_LONG * 2);
      fireEvent(
        carte,
        new MouseEvent("pointerup", { bubbles: true, clientX: 200 - SEUIL_GLISSEMENT, clientY: 0 }),
      );

      expect(onHold).not.toHaveBeenCalled();
      expect(onRepondre).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("le doigt immobile ouvre toujours le hold menu — l'appui long n'est pas perdu", () => {
    vi.useFakeTimers();
    try {
      const { onHold } = rendreMessage();
      fireEvent(
        carteMessage(),
        new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 0 }),
      );
      vi.advanceTimersByTime(DUREE_APPUI_LONG);
      expect(onHold).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("le message suit le doigt pendant le geste, et revient en place après", () => {
    rendreMessage();
    const carte = carteMessage();

    fireEvent(carte, new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 0 }));
    fireEvent(carte, new MouseEvent("pointermove", { bubbles: true, clientX: 160, clientY: 0 }));
    expect(carte.style.transform).toBe("translateX(-40px)");

    fireEvent(carte, new MouseEvent("pointerup", { bubbles: true, clientX: 160, clientY: 0 }));
    expect(carte.style.transform).toBe("");
  });

  it("un doigt qui descend la liste rend la main : rien ne suit, et rien ne se déclenche", () => {
    const { onRepondre, onRevelerHeures } = rendreMessage();
    const carte = carteMessage();

    fireEvent(carte, new MouseEvent("pointerdown", { bubbles: true, clientX: 200, clientY: 0 }));
    fireEvent(carte, new MouseEvent("pointermove", { bubbles: true, clientX: 190, clientY: 120 }));
    expect(carte.style.transform).toBe("");

    fireEvent(
      carte,
      new MouseEvent("pointerup", { bubbles: true, clientX: 200 - SEUIL_GLISSEMENT, clientY: 120 }),
    );
    expect(onRepondre).not.toHaveBeenCalled();
    expect(onRevelerHeures).not.toHaveBeenCalled();
  });
});

describe("glissement droit : les heures, et la zone morte du bord", () => {
  it("l'appui long n'entraîne pas la sélection de texte native d'iOS", () => {
    rendreMessage();
    // Sur iOS, l'appui long sélectionnait le texte de la bulle (surlignage bleu) en plus
    // d'ouvrir le hold menu. jsdom n'applique pas les feuilles de style : on vérifie que la
    // bulle porte la classe, et que la classe coupe bien sélection et callout.
    expect(carteMessage().classList.contains("tacita-geste")).toBe(true);
    const regle = /\.tacita-geste\s*\{([^}]*)\}/.exec(
      sansCommentaires(lire("components/foundation/tokens.css")),
    )?.[1];
    expect(regle).toMatch(/-webkit-touch-callout:\s*none/);
    expect(regle).toMatch(/-webkit-user-select:\s*none/);
  });

  it("révèle les heures", () => {
    const { onRevelerHeures } = rendreMessage();
    glisser(carteMessage(), 100, 100 + SEUIL_GLISSEMENT);
    expect(onRevelerHeures).toHaveBeenCalledTimes(1);
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

describe("accusés : trois niveaux, et ce qu'ils ne promettent pas", () => {
  const recuDe = (statut: "sent" | "delivered" | "read", indecidable = false) => {
    cleanup();
    rendreMessage({ message: message({ moi: true }), recu: { statut, indecidable } });
  };

  it("envoyé, délivré puis lu se distinguent à l'écran", () => {
    /*
     * Les trois états se distinguent par leur **étiquette accessible**, plus par un
     * caractère. Les coches étaient les glyphes `✓` et `✓✓` ; ce sont désormais des SVG au
     * trait, comme toutes les autres marques de l'application. Assertion
     * sur le rôle et le nom : c'est ce que l'utilisateur perçoit, et ça ne dépend plus du
     * dessin retenu.
     */
    recuDe("sent");
    expect(screen.getByRole("img", { name: /^Envoyé\.$/ })).toBeTruthy();

    recuDe("delivered");
    expect(screen.getByRole("img", { name: /extension propre à Tacita/ })).toBeTruthy();

    recuDe("read");
    // DESIGN.md : la coche verte est un trait d'identité, et « lu » seul la porte.
    expect(screen.getByRole("img", { name: "Lu." }).style.color).toContain(
      "--color-text-accent",
    );
  });

  it("un destinataire masqué reste à « envoyé », et l'explique", () => {
    recuDe("sent", true);
    expect(screen.getByLabelText(/n'émet pas d'accusé/)).toBeTruthy();
  });

  it("un message en cours d'envoi ne porte aucune coche", () => {
    rendreMessage({ message: message({ moi: true }), recu: { statut: "sending", indecidable: false } });
    expect(screen.queryByRole("img", { name: /Envoyé|Délivré|Lu/ })).toBeNull();
  });
});

describe("hold menu : réactions, actions, et droits", () => {
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

describe("conversation starter : premier élément, actions selon le salon", () => {
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

describe("typing en lecture, mentions à la saisie", () => {
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
    // le corps porte le littéral que la push rule cherche ; l'utilisateur
    // a tapé `@everyone` et doit le relire tel quel.
    expect(texteAffiche("salut @room")).toBe("salut @everyone");
  });
});

/**
 * la barre d'écriture, telle qu'on l'attend d'une
 * messagerie : joindre à gauche, capture contre le bouton d'envoi, et la barre au bas de
 * l'écran plutôt qu'accrochée au dernier message.
 */
describe("la barre d'écriture : une seule rangée, et le bas de l'écran", () => {
  /**
   * Le cœur du composant : **quatre éléments sur une ligne, dans cet ordre**. Le défaut
   * qu'il ferme n'était pas une absence — les boutons étaient bien là, et bien à gauche
   * et à droite — mais une *forme* : les emplacements de `ChatComposer` les rangeaient
   * sur une seconde ligne sous le champ, la silhouette d'un composer d'assistant. Un test
   * de présence restait vert ; c'est l'ordre et le parent commun qui disent la rangée.
   */
  it("joindre, champ, photo, envoyer — une ligne, dans cet ordre", () => {
    render(
      <Composer
        mentions={[]}
        onEnvoyer={vi.fn()}
        onFrappe={vi.fn()}
        actions={<button type="button">joindre</button>}
        actionsEnvoi={<button type="button">photo</button>}
      />,
    );

    const joindre = screen.getByText("joindre");
    const rangee = joindre.parentElement!;
    expect(rangee.style.display).toBe("flex");
    // `flex-end` et non `center` : les boutons suivent la dernière ligne d'un champ qui
    // a grandi, au lieu de flotter au milieu du pavé de texte.
    expect(rangee.style.alignItems).toBe("flex-end");

    const enfants = [...rangee.children];
    expect(enfants).toHaveLength(4);
    expect(enfants[0]).toBe(joindre);
    // Le champ est le seul à porter une enveloppe : c'est elle qui tient la surface et
    // le `flex: 1` qui lui donne toute la largeur restante.
    expect(enfants[1]!.contains(screen.getAllByLabelText("Message")[0]!)).toBe(true);
    expect((enfants[1] as HTMLElement).style.flexGrow).toBe("1");
    expect(enfants[2]).toBe(screen.getByText("photo"));
    expect(enfants[3]).toBe(screen.getByRole("button", { name: "Envoyer" }));
  });

  it("l'envoi est refusé tant qu'il n'y a rien à envoyer", () => {
    render(<Composer mentions={[]} onEnvoyer={vi.fn()} onFrappe={vi.fn()} />);
    // `canSend` venait du shell d'Astryx ; il est recalculé ici, et c'est exactement le
    // genre de règle qu'on croit acquise et qui repart à zéro quand le shell s'en va.
    expect(screen.getByRole("button", { name: "Envoyer" }).hasAttribute("disabled")).toBe(true);
  });

  /**
   * jsdom ne calcule ni hauteur ni défilement : la colonne se lit à la source, comme les
   * règles de la navbar. Ce que ce test tient, ce n'est pas la mise en page — c'est que
   * la ligne qui la produit ne disparaisse pas sans que personne ne le voie.
   */
  it("l'écran est une colonne dont la timeline est la seule partie qui défile", () => {
    const ecran = lire("components/conversation/Conversation.tsx");
    expect(ecran).toContain('height: "100dvh"');
    expect(ecran).toContain('flexDirection: "column"');

    const timeline = lire("components/conversation/Timeline.tsx");
    expect(timeline).toContain('overflowY: "auto"');
    // Sans `minHeight: 0`, un enfant de flex refuse de descendre sous son contenu : la
    // colonne s'allonge, la page entière défile, et la barre repart sous le dernier
    // message — exactement le défaut qu'on corrige, avec l'`overflow` en place.
    expect(timeline).toContain("minHeight: 0");
  });
});

/**
 * **la sortie d'un fichier reçu, de bout en bout.**
 *
 * Le viewer plein écran ne s'ouvre que sur une image ou une vidéo : un PDF, un ZIP ou un
 * document restait une tuile sans aucune façon d'en écrire les octets sur l'appareil.
 * Signalé tel quel par les utilisateurs.
 *
 * La chaîne est faite de props **optionnelles** — `Conversation` → `Timeline` →
 * `MessageObject` → `MediaMessage` : en oublier une compile, et le bouton disparaît en
 * silence. D'où le rendu jusqu'à la timeline, et la source pour le maillon du dessus.
 */
describe("un fichier reçu se télécharge sur l'appareil", () => {
  const fichier = mediaDe({
    getId: () => "$fic",
    getContent: () => ({
      msgtype: "m.file",
      body: "contrat.pdf",
      file: { url: "mxc://tacita.test/abc", key: {}, iv: "iv", hashes: {}, v: "v2" },
      info: { size: 1536, mimetype: "application/pdf" },
    }),
  })!;

  it("la timeline câble le téléchargement jusqu'à la tuile du fichier", () => {
    const onSauvegarderMedia = vi.fn();
    render(
      <Timeline
        messages={[message({ media: fichier })]}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
        telecharger={vi.fn()}
        onSauvegarderMedia={onSauvegarderMedia}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Télécharger" }));
    expect(onSauvegarderMedia).toHaveBeenCalledWith(fichier);
  });

  it("le câblage de l'écran fournit le geste, et le pipeline en est le propriétaire", () => {
    const ecran = lire("components/conversation/Conversation.tsx");
    expect(ecran).toContain("onSauvegarderMedia={sauvegarder}");
    // `saveOriginal` et pas un `<a download>` maison : le choix de destination
    // appartient au pipeline, qui sait ce que le navigateur supporte.
    expect(lire("components/media/useMediaActions.ts")).toContain("saveOriginal(env, blob, media.nom)");
  });
});

describe("lire une conversation fait retomber son badge de non-lus", () => {
  /**
   * Le défaut signalé : « le compteur de messages non lus ne fait que monter malgré leur
   * lecture ». Le badge est le compteur natif du serveur ; il ne retombe que
   * sur un reçu `m.read`, et `markRead` — exposé par `@tacita/receipts` dès son premier jour —
   * n'avait **aucun appelant** dans tout le dépôt.
   *
   * Structurel, et c'est le bon niveau : `@tacita/receipts` prouve déjà que `markRead` émet le
   * bon reçu que le badge suit `RoomEvent.Receipt`. Ce qui manquait est le
   * fil entre les deux, et c'est un fil qu'aucun des deux paquets ne peut voir — règle 7,
   * une valeur écrite là où rien ne la lit est indétectable.
   */
  it("l'écran émet le reçu de lecture sur le dernier message du salon", () => {
    const ecran = sansCommentaires(lire("components/conversation/Conversation.tsx"));
    expect(ecran).toContain("receipts.current?.markRead(dernier)");
    expect(ecran).toMatch(/listerMessages\(session, roomId\)\.at\(-1\)/);
  });
});

describe("la timeline remonte l'historique quand on approche du haut", () => {
  /**
   * jsdom ne fait aucune mise en page : `scrollTop` et `scrollHeight` y valent zéro et
   * ne bougent pas. On les remplace par des accesseurs adossés à des variables — c'est
   * la géométrie qui est simulée, pas le composant, et la logique éprouvée est bien la
   * sienne.
   */
  function geometrie(element: HTMLElement, hauteur: number, position: number) {
    const etat = { hauteur, position };
    Object.defineProperty(element, "scrollHeight", { configurable: true, get: () => etat.hauteur });
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => etat.position,
      set: (valeur: number) => {
        etat.position = valeur;
      },
    });
    return etat;
  }

  const rendre = (messages: MessageAffiche[], onRemonter?: () => void) =>
    render(
      <Timeline
        messages={messages}
        onRemonter={onRemonter}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
      />,
    );

  it("demande la suite quand le défilement approche du haut", () => {
    const onRemonter = vi.fn();
    rendre([message()], onRemonter);

    const zone = screen.getByRole("log");
    geometrie(zone, 2000, 50);
    fireEvent.scroll(zone);

    expect(onRemonter).toHaveBeenCalled();
  });

  it("ne demande rien tant qu'on est loin du haut", () => {
    const onRemonter = vi.fn();
    rendre([message()], onRemonter);

    const zone = screen.getByRole("log");
    geometrie(zone, 5000, 3000);
    fireEvent.scroll(zone);

    expect(onRemonter).not.toHaveBeenCalled();
  });

  /**
   * Le défaut que ce test empêche : sans compensation, les messages insérés en tête
   * poussent le contenu vers le bas, le lecteur se retrouve encore plus haut, et le
   * défilement redemande aussitôt une page — une boucle, pas un chargement.
   */
  it("conserve la position de lecture quand des messages s'insèrent en tête", () => {
    const { rerender } = rendre([message({ cle: "$b" })], vi.fn());

    const zone = screen.getByRole("log");
    const etat = geometrie(zone, 1000, 100);
    fireEvent.scroll(zone);

    // La page remontée arrive : la zone grandit de 400 px au-dessus de la position.
    etat.hauteur = 1400;
    rerender(
      <Timeline
        messages={[message({ cle: "$a" }), message({ cle: "$b" })]}
        onRemonter={vi.fn()}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
      />,
    );

    expect(zone.scrollTop).toBe(500);
  });

  it("sans `onRemonter`, le défilement ne déclenche rien — la timeline reste passive", () => {
    rendre([message()]);
    const zone = screen.getByRole("log");
    geometrie(zone, 2000, 0);
    // Aucune exception, et aucune position touchée : le composant sans câblage est inerte.
    expect(() => fireEvent.scroll(zone)).not.toThrow();
    expect(zone.scrollTop).toBe(0);
  });
});

describe("une conversation s'ouvre sur son dernier message", () => {
  /**
   * Rien ne positionnait la zone défilante : elle s'ouvrait à zéro, donc sur le message
   * le **plus ancien** de la fenêtre chargée, et il fallait défiler jusqu'en bas pour
   * lire ce qui venait d'arriver. jsdom ne met rien en page — la géométrie est simulée,
   * la logique éprouvée est bien celle du composant.
   */
  it("se positionne en bas à l'arrivée", () => {
    const { rerender } = render(
      <Timeline
        messages={[]}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
      />,
    );

    const zone = screen.getByRole("log");
    let position = 0;
    Object.defineProperty(zone, "scrollHeight", { configurable: true, get: () => 3000 });
    Object.defineProperty(zone, "scrollTop", {
      configurable: true,
      get: () => position,
      set: (valeur: number) => {
        position = valeur;
      },
    });

    rerender(
      <Timeline
        messages={[message({ cle: "$a" }), message({ cle: "$b" })]}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
      />,
    );

    expect(zone.scrollTop).toBe(3000);
  });

  /**
   * Le chemin réel, et celui qui était cassé : la timeline rend d'abord ses squelettes
   * (`chargement`), donc `zone` n'est attachée à rien et l'effet sort sans rien
   * positionner. Les messages arrivent ensuite **sans changer de nombre** — le paquet les
   * tenait déjà, seul `pret` a basculé côté écran —, et l'effet ne se rejouait pas.
   *
   * Le test précédent passait au vert en rendant la timeline directement chargée : il
   * éprouvait la bonne logique par un chemin que l'app n'emprunte jamais.
   */
  it("se positionne en bas quand les squelettes cèdent la place, à nombre de messages égal", () => {
    const messages = [message({ cle: "$a" }), message({ cle: "$b" })];
    const rendre = (chargement: boolean) => (
      <Timeline
        messages={messages}
        chargement={chargement}
        onRepondre={vi.fn()}
        onHold={vi.fn()}
        onReagir={vi.fn()}
        onRenvoyer={vi.fn()}
        onAbandonner={vi.fn()}
      />
    );

    /*
     * La géométrie est posée sur le **prototype** et non sur l'élément : la zone
     * défilante n'existe pas encore au moment du premier rendu — c'est tout le sujet —,
     * et il n'y a donc rien à instrumenter avant la bascule.
     */
    let position = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 3000,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => position,
      set: (valeur: number) => {
        position = valeur;
      },
    });

    try {
      const { rerender } = render(rendre(true));
      expect(screen.queryByRole("log")).toBeNull();

      rerender(rendre(false));

      expect(screen.getByRole("log").scrollTop).toBe(3000);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
    }
  });
});
