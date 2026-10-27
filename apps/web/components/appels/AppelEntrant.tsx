"use client";

import { incomingCalls, type IncomingCall } from "@tacita/calls";
import { conversations, type Conversation } from "@tacita/messaging";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { CHEMIN_APPEL, routeAppel } from "../../lib/routes";
import { sonner } from "../../lib/sonnerie";
import { ConversationAvatar } from "../foundation/ConversationAvatar";
import { Button, Text } from "../foundation/primitives";
import { useSession } from "../onboarding/SessionProvider";

/**
 * **L'appel entrant, depuis n'importe quel écran.**
 *
 * C'était le trou le plus grave du chemin d'appel : l'état d'appel ne se lisait que salon
 * par salon, et le bandeau qui l'affichait vivait *dans* l'écran Conversation. Quelqu'un
 * qui appelait pendant qu'on lisait la liste des conversations, un autre salon, ou son
 * profil ne produisait donc rien du tout — pas un pixel, pas un son. Un appel qui
 * n'arrive pas est le seul défaut d'une messagerie d'appel qu'on ne peut pas rattraper.
 *
 * **Une bannière, pas une modale**, et c'est un choix : l'application est au premier plan
 * quand ce composant rend, donc l'utilisateur est en train de faire quelque chose. Un
 * plein écran qui s'empare du clavier au milieu d'une phrase se referme de rage, et il
 * emporte l'appel avec lui. La bannière se pose au-dessus, laisse tout lisible, et porte
 * les deux seules actions qui comptent.
 *
 * **« Ignorer » ne prévient pas l'appelant, et le libellé le dit.** MatrixRTC n'a pas de
 * refus : dire « Refuser » promettrait un signal qui ne part nulle part (interdit n°13).
 * Ce bouton fait taire la sonnerie ici, et rien d'autre — l'appel reste rejoignable
 * depuis le salon tant qu'il dure.
 */

/** Ce que la bannière montre d'un appel entrant, une fois le salon nommé. */
export interface AppelAffiche {
  roomId: string;
  nom: string;
  direct: boolean;
  /** Le correspondant en DM, absent en groupe. Source de la teinte. */
  peerId?: string;
  /** Distingue deux appels successifs dans le même salon : la clé du rejet local. */
  cle: string;
}

/**
 * L'appel à montrer parmi ceux qui sonnent, les rejetés retirés.
 *
 * Un seul à la fois, et c'est le plus récent : deux bannières empilées obligeraient à
 * choisir entre deux inconnus, et la deuxième arriverait sous la première.
 */
export function appelAMontrer(
  appels: readonly IncomingCall[],
  salons: readonly Conversation[],
  rejetes: ReadonlySet<string>,
): AppelAffiche | undefined {
  const candidat = appels
    .filter((appel) => appel.ringing && !rejetes.has(`${appel.roomId}:${appel.since}`))
    .sort((a, b) => b.since - a.since)[0];
  if (!candidat) return undefined;

  const salon = salons.find((conversation) => conversation.roomId === candidat.roomId);
  return {
    roomId: candidat.roomId,
    // Le nom du salon, jamais l'identifiant brut : « !abc:serveur vous appelle » ne dit
    // rien à personne. À défaut, l'auteur — qui est au moins un nom d'utilisateur.
    nom: salon?.name ?? candidat.from,
    direct: salon?.direct ?? true,
    // Le correspondant en DM : c'est de lui que se dérive la teinte, pour que l'appel
    // porte la même couleur que la conversation et la liste d'amis.
    peerId: salon?.peerId,
    cle: `${candidat.roomId}:${candidat.since}`,
  };
}

export function AppelEntrant() {
  const { etat } = useSession();
  const router = useRouter();
  const chemin = usePathname();
  const session = etat.phase === "prete" ? etat.session : null;

  const [appels, setAppels] = useState<readonly IncomingCall[]>([]);
  const [salons, setSalons] = useState<readonly Conversation[]>([]);
  const [rejetes, setRejetes] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!session) return;
    const entrants = incomingCalls(session);
    const lire = () => {
      setAppels(entrants.current());
      // Les noms se relisent au même moment : un salon créé à l'instant — le cas d'un
      // premier appel — n'est pas dans une liste capturée au montage.
      setSalons(conversations(session));
    };

    lire();
    const desabonner = entrants.subscribe(lire);
    return () => {
      desabonner();
      entrants.stop();
    };
  }, [session]);

  const appel = useMemo(() => appelAMontrer(appels, salons, rejetes), [appels, salons, rejetes]);

  /**
   * Sur l'écran d'appel lui-même, rien. Entre la navigation et la publication de notre
   * appartenance il s'écoule un aller-retour réseau, pendant lequel l'appel qu'on vient
   * de décrocher est encore « entrant » — la bannière se serait rallumée par-dessus.
   */
  const surEcranAppel = chemin?.startsWith(CHEMIN_APPEL) === true;
  const visible = appel !== undefined && !surEcranAppel;

  useEffect(() => {
    if (!visible) return;
    return sonner();
  }, [visible, appel?.cle]);

  if (!visible || !appel) return null;

  return (
    <div
      // e3 — DESIGN.md nomme ce niveau pour la bannière d'appel. Fixe et non dans le
      // flux : l'écran Conversation est une colonne de hauteur fixée, un bandeau posé
      // au-dessus dans le flux pousserait le composer hors de la fenêtre.
      role="alertdialog"
      aria-label={`Appel entrant de ${appel.nom}`}
      style={{
        position: "fixed",
        // R-07 : sous la barre d'en-tête, jamais dessus — le token porte le pourquoi.
        top: "calc(var(--tacita-decalage-appel) + var(--spacing-2) + env(safe-area-inset-top, 0px))",
        left: "var(--spacing-2)",
        right: "var(--spacing-2)",
        zIndex: 20,
        display: "flex",
        alignItems: "center",
        gap: "var(--spacing-3)",
        padding: "var(--spacing-3)",
        borderRadius: "var(--radius-container)",
        // e3 tel que DESIGN.md le définit : `surface-raised` + filet + `--shadow-high`.
        // L'ombre vient du thème et jamais d'un littéral — celui qu'on aurait écrit ici
        // n'aurait porté que la valeur claire, et une ombre noire à 10 % sur un fond
        // sombre ne se voit pas. **Jamais d'ombre sans filet.**
        background: "var(--color-background-popover)",
        border: "1px solid var(--color-border)",
        boxShadow: "var(--shadow-high)",
      }}
    >
      <ConversationAvatar nom={appel.nom} direct={appel.direct} taille={40} cle={appel.peerId ?? appel.roomId} />

      <div style={{ display: "grid", minWidth: 0, flex: 1 }}>
        <Text maxLines={1}>{appel.nom}</Text>
        <Text type="supporting" color="secondary" maxLines={1}>
          Appel entrant
        </Text>
      </div>

      <div style={{ display: "flex", gap: "var(--spacing-1)", flexShrink: 0 }}>
        {/* L'ordre compte : le geste destructeur n'est jamais le premier sous le pouce. */}
        <Button
          label="Ignorer"
          variant="ghost"
          className="tacita-bouton-contour"
          onClick={() => setRejetes((connus) => new Set(connus).add(appel.cle))}
        />
        <Button
          label="Répondre"
          variant="primary"
          className="tacita-bouton-doux"
          onClick={() => router.push(routeAppel(appel.roomId))}
        />
      </div>
    </div>
  );
}
