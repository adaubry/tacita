/**
 * L'écran de réglages : une option par ligne, chacune avec son effet en clair.
 *
 * `TITRES`, `DETAILS` et `MODES` sont la source du libellé : une option ajoutée sans
 * son texte ne s'affiche pas à moitié, elle ne compile pas. Chaque réglage existant
 * doit se justifier — on ne pose pas un labyrinthe d'options.
 */
"use client";

import type { Session } from "@tacita/client-core";
import {
  conversations as listerConversations,
  roomNotificationLevel,
  type RoomNotificationLevel,
} from "@tacita/messaging";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { useModeTheme } from "../../app/providers";
import { ButtonsList } from "../foundation/ButtonsList";
import { IconeMuet } from "../foundation/icons";
import { OptionCard } from "../foundation/OptionCard";
import { Placeholder } from "../foundation/Placeholder";
import { Sheet } from "../foundation/Sheet";
import { Divider, RadioList, RadioListItem, Switch, Text, type ThemeMode } from "../foundation/primitives";
import { useSession } from "../onboarding/SessionProvider";
import { Appareils } from "./Appareils";
import { Confidentialite } from "./Confidentialite";
import { LimitesConnues } from "./LimitesConnues";
import { MotDePasse } from "./MotDePasse";
import { NotificationsPush } from "./NotificationsPush";
import { libelleNiveau } from "./NotificationsSalon";
import { StockageLocal } from "./StockageLocal";
import { routeInfos } from "../../lib/routes";
import { ecrireGarderClavier, lireGarderClavier } from "../../lib/preferences";

/**
 * Les options de. Chacune ouvre une modal, aucune ne navigue.
 *
 * « Appareils » est arrivée, juste sous le mot de passe : les
 * deux sont les gestes qu'on cherche au même moment, quand on soupçonne que quelqu'un
 * d'autre est entré. Changer son mot de passe sans pouvoir fermer les sessions ouvertes
 * ne reprend rien.
 */
type Option =
  | "theme"
  | "ecriture"
  | "motdepasse"
  | "appareils"
  | "confidentialite"
  | "notifications"
  | "stockage"
  | "limites";

const TITRES: Record<Option, string> = {
  theme: "Apparence",
  ecriture: "Écriture",
  motdepasse: "Mot de passe",
  appareils: "Appareils",
  confidentialite: "Confidentialité",
  notifications: "Notifications",
  stockage: "Stockage local",
  limites: "Limites connues",
};

/**
 * La ligne d'état de chaque carte — ce que dit `niveauLibelle` pour une conversation.
 * `theme` n'y est pas : son état courant est le mode choisi, et il se lit à l'exécution.
 */
const DETAILS: Record<Exclude<Option, "theme">, string> = {
  ecriture: "Le clavier après l'envoi",
  // D-12 — le détail dit ce qui garde le changement, parce que c'est la surprise : on
  // s'attend à devoir donner son mot de passe actuel, et c'est la clé qu'on demande.
  motdepasse: "Changer, avec votre clé de récupération",
  appareils: "Voir et déconnecter vos sessions",
  confidentialite: "Mode masqué, accusés de lecture",
  notifications: "Cet appareil, et les conversations en silence",
  stockage: "Index de recherche et caches",
  limites: "Ce que Tacita ne promet pas",
};

/** les trois modes du mécanisme Astryx, dans l'ordre du plus passif. */
const MODES: { valeur: ThemeMode; libelle: string; effet: string }[] = [
  { valeur: "system", libelle: "Comme le système", effet: "Suit le réglage de votre appareil." },
  { valeur: "light", libelle: "Clair", effet: "Le thème de référence de Tacita." },
  { valeur: "dark", libelle: "Sombre", effet: "Les mêmes couleurs, en sombre." },
];

/**
 * les réglages, **une section de son propre profil** (amendé).
 *
 * `/reglages` n'existe plus. L'écran commençait par une carte de profil dont le chevron
 * ramenait au profil — un écran dont le premier élément mène ailleurs est un couloir, et
 * la Settings profile card (composant 24) disparaît avec lui.
 *
 * **Une pile de cartes sur la page, pas une liste dans une feuille.** Exactement la forme
 * des options d'une conversation (composant 15, `OptionCard` — « Thème de la
 * conversation » et ses voisines) : titre, ligne d'état, chevron. Le même geste ouvre la
 * même sorte de chose, et l'état courant se lit sans rien ouvrir. Un cran de moins
 * qu'avant : les cinq réglages sont visibles, et un seul geste mène à chacun.
 *
 * Chaque option reste une modal : ce sont des réglages qu'on pose et qu'on quitte, pas
 * des destinations. Une seule est ouverte à la fois, et aucune n'en ouvre une autre.
 *
 * Le shard ne calcule rien ici : le thème vient du provider de M-A, le mode masqué du
 * service d'accusés, les niveaux de notification des push rules natives.
 */
export function Reglages() {
  const { etat } = useSession();
  const router = useRouter();
  const { mode, changerMode } = useModeTheme();
  const session: Session | null = etat.phase === "prete" ? etat.session : null;

  const [option, setOption] = useState<Option | undefined>();

  const libelleMode = MODES.find(({ valeur }) => valeur === mode)?.libelle ?? "Clair";

  /**
   * les conversations dont le niveau n'est pas « tout ». C'est le seul
   * réglage de notification que M-H tient : l'abonnement push global appartient à M-I,
   * et rien ne l'annonce ici tant qu'il n'existe pas.
   */
  const filtrees = useMemo(() => {
    if (!session) return [] as { roomId: string; name: string; niveau: RoomNotificationLevel }[];
    return listerConversations(session)
      .map((conversation) => ({
        roomId: conversation.roomId,
        name: conversation.name,
        niveau: roomNotificationLevel(session, conversation.roomId),
      }))
      .filter((conversation) => conversation.niveau !== "all");
    // `option` est la dépendance qui compte : la liste se relit à l'ouverture de la
    // modal, pas à chaque rendu. Interroger les push rules en continu n'apprendrait rien
    // — elles ne changent que depuis un autre écran.
  }, [session, option]);

  return (
    <>
      {/* DESIGN.md : « séparation par hairline ou par espace, jamais par changement de
          fond gratuit ». Le filet suffit à dire qu'on change de sujet — un fond de
          section en dirait autant en ajoutant une couleur. */}
      <Divider />

      <section
        aria-label="Réglages"
        style={{ display: "grid", gap: "var(--spacing-2)", padding: "var(--spacing-3)" }}
      >
        {(Object.keys(TITRES) as Option[]).map((cle) => (
          <OptionCard
            key={cle}
            titre={TITRES[cle]}
            // L'apparence dit le mode courant, comme les notifications d'une conversation
            // disent leur niveau : c'est le seul des cinq réglages dont l'état tient en
            // un mot, et le cacher obligerait à ouvrir pour savoir.
            detail={cle === "theme" ? libelleMode : DETAILS[cle]}
            onClick={() => setOption(cle)}
          />
        ))}
      </section>

      <Sheet
        ouvert={option !== undefined}
        onFermer={() => setOption(undefined)}
        titre={option ? TITRES[option] : ""}
      >
        {option === "theme" && (
          <div style={{ padding: "var(--spacing-3)" }}>
            <RadioList
              label="Thème"
              value={mode}
              onChange={(valeur) => changerMode(valeur as ThemeMode)}
            >
              {MODES.map(({ valeur, libelle, effet }) => (
                <RadioListItem key={valeur} value={valeur} label={libelle} description={effet} />
              ))}
            </RadioList>
          </div>
        )}

        {option === "ecriture" && <Ecriture />}

        {/* D-12 — la session est requise : sans elle il n'y a ni compte ni clé à
            vérifier, et l'écran n'aurait rien à changer. */}
        {option === "motdepasse" && session && <MotDePasse session={session} />}

        {/* la session est requise : la liste et la révocation sont des
            appels authentifiés, il n'y a rien à montrer sans compte. */}
        {option === "appareils" && session && <Appareils session={session} />}

        {option === "confidentialite" && <Confidentialite />}

        {option === "notifications" && (
          <div style={{ display: "grid", gap: "var(--spacing-3)", padding: "var(--spacing-3)" }}>
            {/* l'abonnement push et son rattrapage (M-I) : d'abord savoir
                si l'appareil prévient, ensuite quelle conversation est en silence. */}
            <NotificationsPush />

            <Text type="supporting" color="secondary">
              Les notifications se règlent conversation par conversation, depuis ses
              informations. Voici celles qui ne sont pas au niveau « Tout ».
            </Text>

            {filtrees.length === 0 ? (
              <Placeholder
                icone={IconeMuet}
                titre="Aucune conversation en silence"
                explication="Ouvrez les informations d'une conversation pour changer son niveau."
              />
            ) : (
              // Une liste, et non des boutons comme au-dessus : ce sont des lignes de
              // données qui portent un libellé **et** un état, pas cinq actions fixes.
              <ButtonsList
                boutons={filtrees.map((conversation) => ({
                  cle: conversation.roomId,
                  libelle: conversation.name,
                  description: libelleNiveau(conversation.niveau),
                  // Naviguer ferme la modal : la laisser ouverte la ferait retrouver
                  // au retour, par-dessus un écran qu'on n'a pas demandé.
                  onClick: () => {
                    setOption(undefined);
                    router.push(routeInfos(conversation.roomId));
                  },
                }))}
              />
            )}
          </div>
        )}

        {option === "stockage" && <StockageLocal />}
        {option === "limites" && <LimitesConnues />}
      </Sheet>
    </>
  );
}

/**
 * Garder le clavier après l'envoi. Bascule optimiste, comme le mode masqué : l'état suit
 * le doigt, l'écriture IndexedDB suit derrière.
 */
function Ecriture() {
  const [garder, setGarder] = useState(false);

  useEffect(() => {
    let annule = false;
    void lireGarderClavier(globalThis.indexedDB)
      .then((valeur) => {
        if (!annule) setGarder(valeur);
      })
      .catch(() => {});
    return () => {
      annule = true;
    };
  }, []);

  return (
    <div style={{ padding: "var(--spacing-3)" }}>
      <Switch
        label="Garder le clavier après l'envoi"
        description="Il reste ouvert pour le message suivant. Un toucher bref sur la conversation le range."
        value={garder}
        onChange={(valeur) => {
          setGarder(valeur);
          void ecrireGarderClavier(globalThis.indexedDB, valeur).catch(() => {});
        }}
      />
    </div>
  );
}
