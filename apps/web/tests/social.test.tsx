import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Profile } from "@tacita/messaging";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AjouterAmis } from "../components/amis/AjouterAmis";
import { Demandes } from "../components/amis/Demandes";
import { Note } from "../components/profil/Note";
import { routeConversation } from "../lib/routes";
import { ProfilAutrui, CONFIRMATIONS } from "../components/profil/ProfilAutrui";
import { AVERTISSEMENT_PHOTO, ProfilMoi } from "../components/profil/ProfilMoi";
import { ReceptionLien } from "../components/amis/ReceptionLien";
import { liensDeLaSession, urlDInvitation, type LiensInvitation } from "../lib/liens-invitation";
import type { Demande } from "../lib/contacts";
import { LIBELLE_NOTE, lireNote } from "../lib/notes";
import { DEBOUNCE_MS } from "../lib/recherche";

const pousser = vi.fn();
const revenir = vi.fn();
const remplacer = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => "/profil/@mira:tacita.test",
  useRouter: () => ({ push: pousser, back: revenir, replace: remplacer }),
  useSearchParams: () => new URLSearchParams(),
}));

/** E-13 — le paquet 05 est mocké à son interface : M-G compose, il ne dérive rien. */
const frapper = vi.fn(async () => ({ room_id: "!groupe:t" }));
/** L'interface `Contacts` : les écrans se codent contre elle, pas contre le SDK. */
const inviterContact = vi.fn(async () => "!dm:t");
vi.mock("../lib/contacts", () => ({
  contactsDeLaSession: () => ({ inviter: inviterContact }),
}));
const regleDAcces = vi.fn(() => "knock" as "knock" | "invite");
vi.mock("@tacita/messaging", async (original) => ({
  ...(await original<typeof import("@tacita/messaging")>()),
  knock: (...args: unknown[]) => frapper(...(args as [])),
  joinRule: () => regleDAcces(),
}));

const MIRA: Profile = { userId: "@mira:tacita.test", displayName: "mira" };
const MOI: Profile = { userId: "@alice:tacita.test", displayName: "alice" };

/** Une base neuve par test : les notes persistent, et un test ne doit rien hériter. */
let base: IDBFactory;
beforeEach(() => {
  base = new IDBFactory();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const rendreAutrui = (props: Partial<Parameters<typeof ProfilAutrui>[0]> = {}) => {
  const actions = {
    profil: MIRA,
    estAmi: false,
    bloque: false,
    indexedDB: base,
    onMessage: vi.fn(),
    onAppel: vi.fn(),
    onInviter: vi.fn().mockResolvedValue(undefined),
    onAction: vi.fn().mockResolvedValue(undefined),
    activite: <div>galeries</div>,
    ...props,
  };
  render(<ProfilAutrui {...actions} />);
  return actions;
};

describe("profil d'un ami : le sélecteur Actions / Activity", () => {
  it("un ami voit le sélecteur, jamais le bouton d'ajout", () => {
    rendreAutrui({ estAmi: true });

    expect(screen.getByRole("radiogroup", { name: "Actions ou activité" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Message" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Appel audio/ })).toBeTruthy();
    // Les deux états s'excluent : proposer « Ajouter » à un ami serait sans effet.
    expect(screen.queryByRole("button", { name: "Ajouter" })).toBeNull();
  });

  it("l'onglet Activity rend les galeries du DM partagé", () => {
    rendreAutrui({ estAmi: true, activite: <div>galeries du DM</div> });

    expect(screen.queryByText("galeries du DM")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Activity" }));
    expect(screen.getByText("galeries du DM")).toBeTruthy();
    // Le sélecteur bascule, il n'empile pas.
    expect(screen.queryByRole("button", { name: "Message" })).toBeNull();
  });

  it("les actions appellent leurs callbacks", () => {
    const { onMessage, onAppel } = rendreAutrui({ estAmi: true });

    fireEvent.click(screen.getByRole("button", { name: "Message" }));
    expect(onMessage).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /Appel audio/ }));
    expect(onAppel).toHaveBeenCalledOnce();
  });
});

describe("profil d'un non-ami : Send invite, et rien d'autre", () => {
  it("un non-ami voit le bouton d'ajout, jamais le sélecteur", () => {
    rendreAutrui({ estAmi: false });

    expect(screen.getByRole("button", { name: "Ajouter" })).toBeTruthy();
    // Écrire à quelqu'un sans conversation serait une action qui échoue.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: "Message" })).toBeNull();
  });

  it("ajouter envoie la demande", async () => {
    const { onInviter } = rendreAutrui({ estAmi: false });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ajouter" }));
    });
    expect(onInviter).toHaveBeenCalledOnce();
  });

  it("le statut est affiché dans les deux cas, et le blocage prime", () => {
    const { unmount } = render(
      <ProfilAutrui
        profil={MIRA}
        estAmi={false}
        bloque={false}
        indexedDB={base}
        onMessage={vi.fn()}
        onAppel={vi.fn()}
        onInviter={vi.fn()}
        onAction={vi.fn()}
      />,
    );
    /*
     * Le statut se lit par son **étiquette accessible** et non par du texte : c'est une
     * icône (plainte : « le badge "ami" devrait être une icône »).
     * Le mot reste, à l'oreille — c'est bien lui qu'on assertait, et il est toujours là.
     */
    expect(screen.getByRole("img", { name: "Pas encore ami" })).toBeTruthy();
    unmount();

    rendreAutrui({ estAmi: true, bloque: true });
    expect(screen.getByRole("img", { name: "Bloqué" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Ami" })).toBeNull();
  });
});

describe("note privée : libellé exact, persistée, relue", () => {
  it("le libellé est celui de l'exigence, mot pour mot", () => {
    render(<Note userId={MIRA.userId} indexedDB={base} />);

    // « sur cet appareil » n'est pas négociable : sans ces mots, l'utilisateur suppose
    // une synchronisation que D-09 a refusée définitivement.
    expect(LIBELLE_NOTE).toBe("Note (visible uniquement par vous, sur cet appareil)");
    expect(screen.getAllByText(LIBELLE_NOTE).length).toBeGreaterThan(0);
  });

  it("une note écrite est persistée puis relue au remontage", async () => {
    const { unmount } = render(<Note userId={MIRA.userId} indexedDB={base} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "rencontrée au festival" },
    });
    // Minuteurs réels : `fake-indexeddb` planifie ses transactions dessus, et les figer
    // ferait attendre une écriture qui n'aboutit jamais.
    await waitFor(async () =>
      expect(await lireNote(base, MIRA.userId)).toBe("rencontrée au festival"),
    );

    unmount();
    render(<Note userId={MIRA.userId} indexedDB={base} />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
        "rencontrée au festival",
      ),
    );
  });

  it("la note est propre à une personne — celle d'une autre ne fuit pas", async () => {
    render(<Note userId={MIRA.userId} indexedDB={base} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "note sur mira" } });
    await waitFor(async () => expect(await lireNote(base, MIRA.userId)).toBe("note sur mira"));
    cleanup();

    render(<Note userId="@sam:tacita.test" indexedDB={base} />);
    await waitFor(() =>
      expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(""),
    );
  });
});

describe("Add-friends : lien, annuaire débouncé, aucune suggestion promise", () => {
  const rendre = (props: Partial<Parameters<typeof AjouterAmis>[0]> = {}) => {
    const actions = {
      chercher: vi.fn().mockResolvedValue([]),
      onPartagerLien: vi.fn().mockResolvedValue("copie" as const),
      onOuvrirProfil: vi.fn(),
      ...props,
    };
    render(<AjouterAmis {...actions} />);
    return actions;
  };

  it("l'écran dit qu'il n'y a aucune suggestion, et pourquoi", () => {
    rendre();
    // D-09 a refusé le graphe social : il n'existe aucune source. Un carrousel vide
    // laisserait croire à une panne.
    expect(screen.getByText("Aucune suggestion")).toBeTruthy();
    expect(screen.getByText(/ne construit pas de graphe social/)).toBeTruthy();
  });

  it("la recherche d'annuaire est débouncée : vingt frappes, un appel", async () => {
    vi.useFakeTimers();
    const { chercher } = rendre({
      chercher: vi.fn().mockResolvedValue([MIRA]),
    });

    const champ = screen.getByLabelText("Rechercher par nom ou identifiant");
    for (let rang = 1; rang <= 20; rang++) {
      fireEvent.change(champ, { target: { value: "m".repeat(rang) } });
      act(() => {
        vi.advanceTimersByTime(DEBOUNCE_MS - 50);
      });
    }
    expect(chercher).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });
    expect(chercher).toHaveBeenCalledOnce();
    expect(chercher).toHaveBeenCalledWith("m".repeat(20));
  });

  it("un résultat mène au profil, il ne porte pas l'action d'ajout", async () => {
    vi.useFakeTimers();
    const { onOuvrirProfil } = rendre({ chercher: vi.fn().mockResolvedValue([MIRA]) });

    fireEvent.change(screen.getByLabelText("Rechercher par nom ou identifiant"), {
      target: { value: "mira" },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    });

    const carte = screen.getByRole("button", { name: "mira" });
    expect(within(carte.parentElement!).getByText("@mira")).toBeTruthy();
    // Ajouter se décide sur le profil, après l'avoir regardé.
    expect(screen.queryByRole("button", { name: "Ajouter" })).toBeNull();

    fireEvent.click(carte);
    expect(onOuvrirProfil).toHaveBeenCalledWith("@mira:tacita.test");
  });

  it("partager un lien dit ce qui s'est réellement passé", async () => {
    const { onPartagerLien } = rendre({
      onPartagerLien: vi.fn().mockResolvedValue("copie" as const),
    });

    await act(async () => {
      fireEvent.click(screen.getByText("Partager un lien d'invitation"));
    });
    expect(onPartagerLien).toHaveBeenCalledOnce();
    expect(screen.getByText(/Lien copié/)).toBeTruthy();
  });
});

describe("Friend request : accepter, refuser, état vide", () => {
  const demande: Demande = {
    roomId: "!dm:tacita.test",
    userId: "@mira:tacita.test",
    nom: "mira",
  };

  it("aucune demande rend le Placeholder dédié", () => {
    render(
      <Demandes demandes={[]} onAccepter={vi.fn()} onRefuser={vi.fn()} onOuvrir={vi.fn()} />,
    );
    expect(screen.getByText("Aucune demande")).toBeTruthy();
  });

  it("accepter appelle Contacts puis navigue vers le DM", async () => {
    const onAccepter = vi.fn().mockResolvedValue("!dm:tacita.test");
    const onOuvrir = vi.fn();
    render(
      <Demandes
        demandes={[demande]}
        onAccepter={onAccepter}
        onRefuser={vi.fn()}
        onOuvrir={onOuvrir}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Accepter" }));
    });

    expect(onAccepter).toHaveBeenCalledWith("!dm:tacita.test");
    expect(onOuvrir).toHaveBeenCalledWith("!dm:tacita.test");
    // Optimiste : la ligne part au clic, sans attendre le serveur.
    expect(screen.getByText("Aucune demande")).toBeTruthy();
  });

  it("refuser fait disparaître la demande immédiatement", async () => {
    const onRefuser = vi.fn().mockResolvedValue(undefined);
    render(
      <Demandes
        demandes={[demande]}
        onAccepter={vi.fn()}
        onRefuser={onRefuser}
        onOuvrir={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refuser" }));
    });
    expect(onRefuser).toHaveBeenCalledWith("!dm:tacita.test");
    expect(screen.getByText("Aucune demande")).toBeTruthy();
  });

  it("un refus qui échoue remet la demande — c'est son état réel", async () => {
    const onRefuser = vi.fn().mockRejectedValue(new Error("réseau"));
    render(
      <Demandes
        demandes={[demande]}
        onAccepter={vi.fn()}
        onRefuser={onRefuser}
        onOuvrir={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refuser" }));
    });
    await waitFor(() => expect(screen.getByText("mira")).toBeTruthy());
  });
});

describe("bloquer et retirer : la confirmation dit l'effet réel", () => {
  const ouvrirOptions = () => fireEvent.click(screen.getByRole("button", { name: "Options" }));

  it("bloquer explique ce que le blocage ne fait pas", async () => {
    const { onAction } = rendreAutrui({ estAmi: true });

    ouvrirOptions();
    fireEvent.click(screen.getByText("Bloquer"));

    const corps = screen.getByText(/Ses messages ne s'afficheront plus chez vous/);
    // Les trois limites réelles de `m.ignored_user_list`, pas une promesse
    // d'expulsion que le protocole ne tient pas.
    expect(corps.textContent).toContain("n'en sera pas informée");
    expect(corps.textContent).toContain("continuer à écrire");
    expect(corps.textContent).toContain("conversations de groupe");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Bloquer" }));
    });
    expect(onAction).toHaveBeenCalledWith("bloquer");
  });

  it("retirer un ami annonce la perte de l'historique local", async () => {
    const { onAction } = rendreAutrui({ estAmi: true });

    ouvrirOptions();
    fireEvent.click(screen.getByText("Retirer des amis"));
    expect(screen.getByText(/quitterez votre conversation privée/)).toBeTruthy();
    expect(screen.getByText(/historique ne vous sera plus accessible/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retirer" }));
    });
    expect(onAction).toHaveBeenCalledWith("retirer");
  });

  it("annuler ne déclenche rien", () => {
    const { onAction } = rendreAutrui({ estAmi: true });

    ouvrirOptions();
    fireEvent.click(screen.getByText("Bloquer"));
    fireEvent.click(screen.getByRole("button", { name: "Annuler" }));
    expect(onAction).not.toHaveBeenCalled();
  });

  it("une personne déjà bloquée se débloque, sans confirmation alarmante", async () => {
    const { onAction } = rendreAutrui({ estAmi: true, bloque: true });

    ouvrirOptions();
    fireEvent.click(screen.getByText("Débloquer"));
    expect(screen.getByText(CONFIRMATIONS.debloquer.corps)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Débloquer" }));
    });
    expect(onAction).toHaveBeenCalledWith("debloquer");
  });

  it("un non-ami n'a rien à retirer", () => {
    rendreAutrui({ estAmi: false });
    ouvrirOptions();
    expect(screen.queryByText("Retirer des amis")).toBeNull();
    expect(screen.getByText("Bloquer")).toBeTruthy();
  });
});

describe("son propre profil : nom, identifiant, et form edit", () => {
  it("le nom et l'identifiant sont tous deux affichés", () => {
    render(<ProfilMoi profil={MOI} onEnregistrer={vi.fn()} onPhoto={vi.fn()} />);

    expect(screen.getByText("alice")).toBeTruthy();
    // l'identifiant, sans son domaine : c'est le même pour tout le monde.
    expect(screen.getByText("@alice")).toBeTruthy();
    // Pas de statut ami sur son propre profil : la question ne s'y pose pas.
    expect(screen.queryByText("Ami")).toBeNull();
  });

  it("enregistrer n'écrit que ce qui a changé", async () => {
    const onEnregistrer = vi.fn().mockResolvedValue(undefined);
    render(<ProfilMoi profil={MOI} onEnregistrer={onEnregistrer} onPhoto={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Modifier le profil" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    });
    // Rien n'a bougé : une écriture inutile ferait un événement de profil dans tous les
    // salons partagés.
    expect(onEnregistrer).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Modifier le profil" }));
    fireEvent.change(screen.getByLabelText("Nom d'affichage"), { target: { value: "alice a." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    });
    expect(onEnregistrer).toHaveBeenCalledWith({ displayName: "alice a." });
  });

  it("la déconnexion est posée à droite de la modification, dans la même rangée", () => {
    // `LogoutButton` était testé mais rendu par aucun écran : la
    // déconnexion n'existait dans aucun parcours. Ce test garde le point de branchement.
    render(
      <ProfilMoi
        profil={MOI}
        onEnregistrer={vi.fn()}
        onPhoto={vi.fn()}
        deconnexion={<button type="button">Se déconnecter</button>}
      />,
    );

    const modifier = screen.getByRole("button", { name: "Modifier le profil" });
    const deconnecter = screen.getByRole("button", { name: "Se déconnecter" });
    // Même parent : c'est ce qui fait la rangée. Deux blocs empilés passeraient les deux
    // assertions ci-dessus sans rien dire de la disposition demandée.
    expect(deconnecter.parentElement).toBe(modifier.parentElement);
    // Et dans cet ordre : modifier d'abord, la sortie ensuite.
    expect(modifier.compareDocumentPosition(deconnecter)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

describe("photo de profil : livrée, et honnête sur ce qu'elle expose", () => {
  const rendre = () => {
    const onEnregistrer = vi.fn().mockResolvedValue(undefined);
    const onPhoto = vi.fn().mockResolvedValue("mxc://tacita.test/avatar");
    render(<ProfilMoi profil={MOI} onEnregistrer={onEnregistrer} onPhoto={onPhoto} />);
    fireEvent.click(screen.getByRole("button", { name: "Modifier le profil" }));
    return { onEnregistrer, onPhoto };
  };

  const choisir = async () => {
    const champ = screen.getByLabelText("Choisir une photo de profil") as HTMLInputElement;
    const fichier = new File(["jpeg"], "moi.jpg", { type: "image/jpeg" });
    Object.defineProperty(champ, "files", { value: [fichier], configurable: true });
    await act(async () => {
      fireEvent.change(champ);
    });
    return fichier;
  };

  it("le champ existe, et il n'est pas grisé", () => {
    rendre();
    // Une option grisée est une promesse non tenue affichée (interdit n°13). Avant E-12
    // le champ était **absent** ; il est maintenant là et il marche.
    expect(screen.getByRole("button", { name: "Choisir une photo de profil" })).toBeTruthy();
    expect(screen.getByLabelText("Choisir une photo de profil")).toBeTruthy();
    // la bannière emprunte le même chemin, elle est là au même titre.
    expect(screen.getByRole("button", { name: "Choisir une bannière" })).toBeTruthy();
  });

  it("dit au moment du choix que les images ne sont pas chiffrées", () => {
    rendre();
    // La condition qui rend acceptable : dans la feuille où l'on choisit,
    // pas dans un écran de réglages qu'on n'ouvrira jamais. Une phrase pour les deux
    // images — c'est la même limite, et la répéter la banaliserait.
    expect(screen.getByText(AVERTISSEMENT_PHOTO)).toBeTruthy();
    expect(AVERTISSEMENT_PHOTO).toMatch(/ne sont pas chiffrées/);
    expect(AVERTISSEMENT_PHOTO).toMatch(/bannière/);
  });

  it("téléverse par le chemin injecté et n'enregistre le mxc qu'à la validation", async () => {
    const { onEnregistrer, onPhoto } = rendre();
    const fichier = await choisir();

    expect(onPhoto).toHaveBeenCalledWith(fichier);
    // Choisir n'écrit pas : tant qu'on n'a pas validé, rien ne part dans le profil.
    expect(onEnregistrer).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    });
    // Le nom n'a pas bougé : il n'est pas dans le patch.
    expect(onEnregistrer).toHaveBeenCalledWith({ avatarUrl: "mxc://tacita.test/avatar" });
  });

  it("un téléversement en échec le dit et laisse enregistrer le reste", async () => {
    const onEnregistrer = vi.fn().mockResolvedValue(undefined);
    const onPhoto = vi.fn().mockRejectedValue(new Error("réseau"));
    render(<ProfilMoi profil={MOI} onEnregistrer={onEnregistrer} onPhoto={onPhoto} />);
    fireEvent.click(screen.getByRole("button", { name: "Modifier le profil" }));

    await choisir();
    expect(screen.getByText(/n'a pas pu être envoyée/)).toBeTruthy();

    // Et le reste du formulaire reste utilisable : une photo ratée ne bloque pas le nom.
    fireEvent.change(screen.getByLabelText("Nom d'affichage"), { target: { value: "alice a." } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Enregistrer" }));
    });
    expect(onEnregistrer).toHaveBeenCalledWith({ displayName: "alice a." });
  });
});

describe("réception d'un lien : on frappe, un membre confirme", () => {
  const TOKEN = "jeton-opaque";
  const GROUPE = "!groupe:t";

  /** Le service, mocké à son interface : c'est une API HTTP, pas un paquet. */
  const service = (resoudre: LiensInvitation["resoudre"]): LiensInvitation => ({
    lister: vi.fn(async () => []),
    emettreGroupe: vi.fn(),
    emettreAmi: vi.fn(),
    revoquer: vi.fn(async () => {}),
    resoudre,
  });

  /** Une session réduite à ce que l'écran en lit : l'appartenance au salon visé. */
  const session = (membership?: string, nom = "équipe") =>
    ({
      client: {
        getRoom: (roomId: string) =>
          roomId === GROUPE && membership ? { name: nom, getMyMembership: () => membership } : null,
        // Lu par le **vrai** client du service, que deux tests montent pour éprouver le
        // classement de l'échec de bout en bout.
        getAccessToken: () => "jeton-porteur",
      },
    }) as never;

  /** Un service qui répond ce statut-là, sans corps exploitable : c'est tout ce que le client lit. */
  const repond = (status: number) =>
    vi.fn(async () => ({ ok: false, status, json: async () => ({}) })) as never;

  beforeEach(() => {
    frapper.mockClear();
    regleDAcces.mockReturnValue("knock");
  });

  it("un lien de groupe fait frapper, puis affiche une attente honnête", async () => {
    const liens = service(vi.fn(async () => ({ kind: "group" as const, issuer: "@bob:t", roomId: GROUPE })));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session()} />);

    await waitFor(() => expect(frapper).toHaveBeenCalledWith(expect.anything(), GROUPE));
    expect(await screen.findByText("Demande envoyée")).toBeTruthy();

    // Ce que l'écran ne promet pas : ni délai, ni notification qu'on n'émet pas.
    expect(screen.getByText(/Personne n'est prévenu automatiquement/)).toBeTruthy();
    // Et surtout : aucune navigation. Frapper n'est pas entrer.
    expect(remplacer).not.toHaveBeenCalled();
  });

  it("un lien d'ami passe par le chemin natif de D-09, sans frapper", async () => {
    const liens = service(vi.fn(async () => ({ kind: "friend" as const, issuer: "@mira:tacita.test" })));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session()} />);

    // `inviter` rend le DM existant s'il y en a un : rien à
    // distinguer ici, et donc rien à demander à l'utilisateur.
    await waitFor(() => expect(remplacer).toHaveBeenCalled());
    expect(frapper).not.toHaveBeenCalled();
  });

  it("déjà membre : on ouvre la conversation au lieu de frapper à nouveau", async () => {
    const liens = service(vi.fn(async () => ({ kind: "group" as const, issuer: "@bob:t", roomId: GROUPE })));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session("join")} />);

    // succès idempotent : rouvrir un lien déjà utilisé n'est pas une erreur.
    await waitFor(() => expect(remplacer).toHaveBeenCalledWith(routeConversation(GROUPE)));
    expect(frapper).not.toHaveBeenCalled();
  });

  it("déjà en attente : on réaffiche l'attente sans frapper deux fois", async () => {
    const liens = service(vi.fn(async () => ({ kind: "group" as const, issuer: "@bob:t", roomId: GROUPE })));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session("knock")} />);

    expect(await screen.findByText("Demande envoyée")).toBeTruthy();
    expect(frapper).not.toHaveBeenCalled();
  });

  it("un lien de groupe sans salon est inutilisable : on ne devine pas le salon manquant", async () => {
    const liens = service(vi.fn(async () => ({ kind: "group" as const, issuer: "@bob:t" })));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session()} />);

    expect(await screen.findByText("Ce lien n'est plus valide")).toBeTruthy();
  });

  /**
   * **Le vrai client, sur un vrai statut.** Les deux moitiés du classement vivent dans
   * deux fichiers que rien d'autre ne relie : `liens-invitation` pose le statut sur
   * l'erreur, `ReceptionLien` le lit. Mocker `resoudre` à l'interface ne peut pas les
   * éprouver ensemble — c'est ce qui a laissé le défaut vivre entre les deux (règle 7).
   *
   * Le 404 n'est pas un cas limite : un lien à usage unique valable un jour finit
   * *toujours* par le rendre. Il affichait « le service ne répond pas, réessayez plus
   * tard », soit un conseil d'attendre là où attendre ne peut rien donner (règle 2).
   */
  it("un lien refusé dit qu'il est invalide, pas que le service est en panne", async () => {
    const liens = liensDeLaSession(session(), repond(404));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session()} />);

    expect(await screen.findByText("Ce lien n'est plus valide")).toBeTruthy();
    expect(screen.queryByText("Le lien n'a pas pu être vérifié")).toBeNull();

    // Et toujours pas laquelle des quatre causes : le service refuse de le dire, et
    // l'écran ne le reconstruit pas.
    for (const cause of [/révoqué seulement/i, /bloqué/i, /inconnu/i]) {
      expect(screen.queryByText(cause)).toBeNull();
    }
  });

  it("son propre lien est refusé, pas mis en panne : l'émetteur qui teste son lien le voit", async () => {
    // `400 TACITA_OWN_LINK` — le seul cas que le service nomme, et le premier geste que
    // fait un émetteur : cliquer sur ce qu'il vient d'envoyer pour vérifier.
    const liens = liensDeLaSession(session(), repond(400));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session()} />);

    expect(await screen.findByText("Ce lien n'est plus valide")).toBeTruthy();
  });

  it("le service en panne reste une panne : 5xx conseille de réessayer", async () => {
    // La contrepartie du classement : ce qui se résout par l'attente doit continuer à le
    // dire. Sans elle, le correctif aurait juste inversé le mensonge.
    const liens = liensDeLaSession(session(), repond(503));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session()} />);

    expect(await screen.findByText("Le lien n'a pas pu être vérifié")).toBeTruthy();
  });

  it("service injoignable : l'ajout par identifiant reste proposé", async () => {
    const liens = service(vi.fn(async () => Promise.reject(new Error("503"))));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session()} />);

    expect(await screen.findByText("Le lien n'a pas pu être vérifié")).toBeTruthy();
    // Un lien cassé ne doit jamais rendre le produit inutilisable pour se lier.
    expect(screen.getByText(/identifiant Matrix/)).toBeTruthy();
  });

  it("rien n'est journalisé : le token est dans l'URL", async () => {
    const espions = (["log", "info", "warn", "error", "debug"] as const).map((niveau) =>
      vi.spyOn(console, niveau).mockImplementation(() => {}),
    );
    const liens = service(vi.fn(async () => Promise.reject(new Error(TOKEN))));
    render(<ReceptionLien token={TOKEN} liens={liens} session={session()} />);

    await screen.findByText("Le lien n'a pas pu être vérifié");
    for (const espion of espions) expect(espion).not.toHaveBeenCalled();
    for (const espion of espions) espion.mockRestore();
  });

  it("la route qui consomme le lien est celle que l'émission fabrique", () => {
    // Les deux moitiés vivent dans deux fichiers que rien ne relie : `urlDInvitation`
    // écrit `/i/<token>`, et c'est le nom du dossier de route qui le sert. Un renommage
    // de l'un casserait l'autre en silence — un lien partagé mènerait à un 404.
    const chemin = new URL(urlDInvitation("https://tacita.test", TOKEN)).pathname;
    expect(chemin).toBe(`/i/${TOKEN}`);
    // `join` et non `new URL` : les crochets du segment dynamique de Next seraient
    // percent-encodés par l'URL, et le fichier deviendrait introuvable.
    expect(existsSync(join(import.meta.dirname, "../app/i/[token]/page.tsx"))).toBe(true);
  });
});

describe("l'identifiant s'affiche sans son domaine", () => {
  const rendreAjouter = (props: Partial<Parameters<typeof AjouterAmis>[0]> = {}) => {
    const actions = {
      chercher: vi.fn().mockResolvedValue([]),
      onPartagerLien: vi.fn().mockResolvedValue("copie" as const),
      onOuvrirProfil: vi.fn(),
      ...props,
    };
    render(<AjouterAmis {...actions} />);
    return actions;
  };

  /**
   * Retour utilisateur : « l'id `@alice:chat.example.org` est beaucoup trop long, il
   * faudrait `@alice` uniquement ». La fédération étant désactivée, le
   * domaine est le même pour tout le monde : il occupe la place du nom sans rien
   * apprendre. Ce que les callbacks reçoivent, en revanche, reste l'adresse entière.
   */
  it("la carte de profil montre `@alice`, pas l'adresse entière", () => {
    render(<ProfilMoi profil={MOI} onEnregistrer={vi.fn()} onPhoto={vi.fn()} />);

    expect(screen.getByText("@alice")).toBeTruthy();
    expect(screen.queryByText(MOI.userId)).toBeNull();
  });

  it("un résultat de recherche d'amis aussi, et il ouvre le profil sur l'adresse entière", async () => {
    const onOuvrirProfil = vi.fn();
    const { chercher } = rendreAjouter({
      chercher: vi.fn().mockResolvedValue([MIRA]),
      onOuvrirProfil,
    });

    fireEvent.change(screen.getByLabelText("Rechercher par nom ou identifiant"), {
      target: { value: "mira" },
    });
    await waitFor(() => expect(chercher).toHaveBeenCalled());
    await screen.findByText("@mira");

    fireEvent.click(screen.getByRole("button", { name: /mira/ }));
    expect(onOuvrirProfil).toHaveBeenCalledWith(MIRA.userId);
  });

  it("une demande reçue montre l'identifiant court", () => {
    const demande: Demande = { roomId: "!dm:t", userId: MIRA.userId, nom: "mira" };
    render(<Demandes demandes={[demande]} onAccepter={vi.fn()} onRefuser={vi.fn()} onOuvrir={vi.fn()} />);

    expect(screen.getByText("@mira")).toBeTruthy();
    expect(screen.queryByText(MIRA.userId)).toBeNull();
  });

  it("le champ d'ajout n'exige plus le domaine", () => {
    rendreAjouter();
    const champ = screen.getByLabelText("Rechercher par nom ou identifiant") as HTMLInputElement;
    // Un placeholder qui montre une adresse entière est une consigne : il faisait
    // recopier le domaine à la main.
    expect(champ.placeholder).not.toContain(":");
  });
});

describe("le champ nomme les deux chemins, et dit ce qu'ils exposent", () => {
  /**
   * E-21, tranchée : l'annuaire couvre tous les comptes du serveur
   * Deux conséquences d'écran, et elles vont ensemble — l'une dit ce que
   * la recherche peut, l'autre ce qu'elle coûte.
   */
  const rendre = () =>
    render(
      <AjouterAmis
        chercher={vi.fn().mockResolvedValue([])}
        onPartagerLien={vi.fn().mockResolvedValue("copie" as const)}
        onOuvrirProfil={vi.fn()}
      />,
    );

  it("un prénom est une recherche valable, et le libellé le dit", () => {
    rendre();
    // « Ajouter par identifiant » était exact tant que l'annuaire ne répondait qu'à une
    // adresse entière : personne n'aurait essayé un nom.
    expect(screen.getByLabelText("Rechercher par nom ou identifiant")).toBeTruthy();
  });

  it("l'écran dit que l'utilisateur est lui aussi trouvable", () => {
    rendre();
    // La réciprocité de l'annuaire est une exposition assumée :
    // c'est ici, au moment où la personne s'en sert, qu'elle doit pouvoir l'apprendre.
    expect(screen.getByText(/y compris le vôtre/)).toBeTruthy();
  });

  it("plus une ligne ne prétend que les noms d'affichage sont hors de portée", () => {
    rendre();
    expect(screen.queryByText(/partagez déjà une conversation/)).toBeNull();
  });
});
